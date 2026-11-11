import type { Context, MiddlewareHandler } from "hono";
import algosdk from "algosdk";
import crypto from "crypto";
import { config, marketplaceEnabled } from "../config.js";
import {
  createListing,
  creatorEarnings,
  getListingBySlug,
  listListings,
  listPayouts,
  ListingRecord,
  newId,
} from "../ledger/index.js";
import { verifyOwnerMessage } from "../mandates/index.js";
import { microToUsdString, usdToMicroCeil } from "../pricing/index.js";
import { getWifPriceSnapshot, usdMicroToTokenAtomic } from "../pricing/wif.js";
import { sha256Hex } from "../receipts/index.js";
import { apiError, isGatewayReady, paymentHeaderOf } from "../payments/gateway.js";
import { evmAcceptedFromHeader } from "../payments/evm-identity.js";
import { getWifQuoteChallenge, matchesWifQuoteRequirement, rememberWifQuoteChallenge, WIF_CHAT_MAX_TIMEOUT_SECONDS } from "../payments/wif-challenges.js";
import { getPaymentState, setPaymentState } from "../payments/state.js";
import { marketplaceListingTypedData, verifyCreatorListingSignature } from "../payments/marketplace-evm.js";
import { safeCreatorFetch, SafeResponse, validateCreatorUrl } from "../market/safeFetch.js";

/** The WIF marketplace is deliberately opt-in and remains disabled by default. */
export function robinhoodMarketplaceEnabled(): boolean {
  return marketplaceEnabled();
}

export const marketplaceEnabledMiddleware: MiddlewareHandler = async (c, next) => {
  if (!robinhoodMarketplaceEnabled()) {
    return apiError(c, 503, "marketplace_disabled", "The WIF marketplace is disabled. No payment was taken.");
  }
  return next();
};

const SLUG = /^[a-z0-9][a-z0-9-]{2,47}$/;
const NONCE = /^[A-Za-z0-9._:-]{1,128}$/;
const USD = /^\d+(?:\.\d{1,6})?$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PRICE_USD = 5;

type CreatorFetcher = typeof safeCreatorFetch;
let creatorFetcher: CreatorFetcher = safeCreatorFetch;

/** Tests point listings at local servers, which the SSRF guard would (correctly) refuse. */
export function setCreatorFetcherForTests(fetcher: CreatorFetcher | null) {
  creatorFetcher = fetcher ?? safeCreatorFetch;
}

function disabled(c: Context): Response | null {
  return robinhoodMarketplaceEnabled()
    ? null
    : apiError(c, 503, "marketplace_disabled", "The WIF marketplace is disabled. No payment was taken.");
}

function publicListing(l: ListingRecord) {
  const shared = {
    slug: l.slug,
    name: l.name,
    description: l.description,
    creator: l.creator,
    price_usd: microToUsdString(l.price_micro),
    endpoint: `/v1/market/${l.slug}/call`,
    input_example: l.input_example,
    status: l.status,
    creator_share_percent: 100 - config.marketplaceFeePercent,
    created_at: l.created_at,
  };
  return config.paymentChain === "robinhood"
    ? { ...shared, price_usd_micro: l.price_micro, payment_asset: "WIF", payment_amount: "quote-time dynamic" }
    : { ...shared, price_micro_usdc: l.price_micro };
}

function validEvmAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export async function handleListingCreate(c: Context): Promise<Response> {
  const blocked = disabled(c);
  if (blocked) return blocked;
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return apiError(c, 413, "validation_error", "Listing body exceeds 64 KiB.");
  const body: any = (() => { try { return JSON.parse(raw); } catch { return null; } })();
  const listing = body?.listing;
  const draft = c.req.path.endsWith("/draft");
  if (!listing || (!draft && typeof body.creator_sig !== "string")) {
    return apiError(c, 400, "validation_error", "Body must be { listing: {...}, creator_sig }.");
  }
  if (listing.action !== "list") return apiError(c, 400, "validation_error", "listing.action must be 'list'.");

  const isRobinhood = config.paymentChain === "robinhood";
  if (isRobinhood ? !validEvmAddress(listing.creator) : !algosdk.isValidAddress(listing.creator ?? "")) {
    return apiError(c, 400, "validation_error", isRobinhood ? "listing.creator must be an EVM address." : "listing.creator must be an Algorand address.");
  }
  if (typeof listing.issued_at !== "number" || !Number.isInteger(listing.issued_at) || Math.abs(Date.now() / 1000 - listing.issued_at) > 600) {
    return apiError(c, 400, "validation_error", "listing.issued_at must be an integer within 10 minutes of server time.");
  }
  if (isRobinhood && (typeof listing.nonce !== "string" || !NONCE.test(listing.nonce))) {
    return apiError(c, 400, "validation_error", "Robinhood listings require a non-empty replay-safe nonce.");
  }
  if (!SLUG.test(listing.slug ?? "")) return apiError(c, 400, "validation_error", "slug: 3-48 chars of a-z, 0-9 and '-'.");
  if (typeof listing.name !== "string" || !listing.name.trim() || listing.name.length > 80) {
    return apiError(c, 400, "validation_error", "name is required (max 80 chars).");
  }
  if (typeof listing.description !== "string" || listing.description.length < 10 || listing.description.length > 1000) {
    return apiError(c, 400, "validation_error", "description must be 10-1000 chars.");
  }
  const rawPrice = typeof listing.price_usd === "number" ? String(listing.price_usd) : listing.price_usd;
  if (typeof rawPrice !== "string" || !USD.test(rawPrice)) {
    return apiError(c, 400, "validation_error", "price_usd must be a positive decimal with at most 6 decimal places.");
  }
  const priceUsd = Number(rawPrice);
  if (!(priceUsd >= config.priceMinFloor && priceUsd <= MAX_PRICE_USD)) {
    return apiError(c, 400, "validation_error", `price_usd must be between ${config.priceMinFloor} and ${MAX_PRICE_USD}.`);
  }
  const priceMicro = usdToMicroCeil(priceUsd);
  try {
    validateCreatorUrl(String(listing.upstream_url));
  } catch (err: any) {
    return apiError(c, 400, "validation_error", err.message);
  }

  const creator = isRobinhood ? String(listing.creator).toLowerCase() : listing.creator;
  if (isRobinhood) {
    const signedListing = {
      action: "list" as const,
      creator,
      slug: listing.slug,
      name: listing.name.trim(),
      description: listing.description.trim(),
      upstream_url: listing.upstream_url,
      price_micro: priceMicro,
      input_example: listing.input_example ?? null,
      nonce: listing.nonce,
      issued_at: listing.issued_at,
    };
    if (draft) {
      const typedData = marketplaceListingTypedData(signedListing);
      return c.json({ listing: { ...listing, creator, name: signedListing.name, description: signedListing.description, price_usd: rawPrice }, typed_data: JSON.parse(JSON.stringify(typedData, (_key, value) => typeof value === "bigint" ? value.toString() : value)) });
    }
    if (!(await verifyCreatorListingSignature(signedListing, body.creator_sig))) {
      return apiError(c, 401, "invalid_signature", "creator_sig must be a valid EIP-712 signature for this domain, Robinhood chain, listing and nonce.");
    }
  } else if (draft) {
    return apiError(c, 400, "unsupported_operation", "Typed listing drafts are available on the WIF rail.");
  } else if (!verifyOwnerMessage(listing, body.creator_sig, listing.creator)) {
    return apiError(c, 401, "invalid_signature", "creator_sig must sign the canonical JSON of `listing` with the creator's key.");
  }

  const signingSecret = crypto.randomBytes(32).toString("base64url");
  const created = await createListing({
    id: newId("lst"),
    slug: listing.slug,
    name: listing.name.trim(),
    description: listing.description.trim(),
    creator,
    upstream_url: listing.upstream_url,
    price_micro: priceMicro,
    input_example: listing.input_example ?? null,
    signing_secret: signingSecret,
    listing_nonce: isRobinhood ? listing.nonce : null,
  });
  if (!created) return apiError(c, 409, "listing_conflict", "The slug or creator nonce is already used.");
  return c.json(
    {
      listing: publicListing(created),
      signing_secret: signingSecret,
      verification:
        "Each forwarded call carries X-Moltworld-Timestamp, X-Moltworld-Request-Id and X-Moltworld-Signature = base64url(HMAC-SHA256(signing_secret, `${timestamp}.${request_id}.${sha256_hex(body)}`)). Reject calls that fail this check.",
      review: "Listings go live after review. Status is visible at GET /v1/market/listings/" + created.slug,
    },
    201
  );
}

export async function handleMarketList(c: Context): Promise<Response> {
  const blocked = disabled(c);
  if (blocked) return blocked;
  const listings = await listListings("approved");
  return c.json({ object: "list", data: listings.map(publicListing) });
}

export async function handleListingGet(c: Context): Promise<Response> {
  const blocked = disabled(c);
  if (blocked) return blocked;
  const listing = await getListingBySlug(c.req.param("slug") ?? "");
  if (!listing) return apiError(c, 404, "listing_not_found", "No such listing.");
  return c.json({ listing: publicListing(listing), review_note: listing.review_note });
}

export async function handleCreatorEarnings(c: Context): Promise<Response> {
  const blocked = disabled(c);
  if (blocked) return blocked;
  const address = c.req.param("address") ?? "";
  const valid = config.paymentChain === "robinhood" ? validEvmAddress(address) : algosdk.isValidAddress(address);
  if (!valid) return apiError(c, 400, "validation_error", "Invalid creator address.");
  const account = config.paymentChain === "robinhood" ? address.toLowerCase() : address;
  const includeLegacyAlgorand = config.paymentChain === "algorand";
  const earnings = await creatorEarnings(account, config.paymentAssetAddress, config.networkCaip2, includeLegacyAlgorand);
  const payouts = (await listPayouts(account)).filter((p) =>
    p.kind === "creator" && (
      (p.asset_address.toLowerCase() === config.paymentAssetAddress.toLowerCase() && p.network === config.networkCaip2) ||
      (includeLegacyAlgorand && p.asset_address === "" && p.asset_symbol === "USDC" && p.network === "legacy")
    )
  );
  return c.json({
    creator: address,
    paid_calls: earnings.calls,
    unpaid: microToUsdString(earnings.unpaidMicro),
    paid_out: microToUsdString(earnings.paidMicro),
    accounting_basis: "USD quote equivalent",
    payment_asset: config.paymentAssetSymbol,
    payment_asset_decimals: config.paymentAssetDecimals,
    unpaid_amount_atomic: earnings.unpaidAtomic,
    paid_out_amount_atomic: earnings.paidAtomic,
    payout_threshold: `$${config.creatorPayoutMinUsd}`,
    // The WIF rail has no payout/refund signer here. Credits remain manual-review balances.
    payout_mode: config.paymentChain === "robinhood" ? "wallet_verified" : "algorand_worker",
    manual_payout_required: config.paymentChain === "robinhood",
    payouts: payouts.map((p) => ({ id: p.id, amount_usd_quote: microToUsdString(p.amount_micro), amount_atomic: p.amount_atomic, asset: p.asset_symbol, status: p.status, txid: p.txid, at: p.created_at })),
  });
}

/** Pre-payment checks for POST /v1/market/:slug/call. */
export const prepareMarketRequest: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "POST") return next();
  const match = c.req.path.match(/^\/v1\/market\/([^/]+)\/call$/);
  if (!match) return next();
  const blocked = disabled(c);
  if (blocked) return blocked;
  const listing = await getListingBySlug(match[1]);
  if (!listing || listing.status !== "approved") {
    return apiError(c, 404, "listing_not_found", `No live listing '${match[1]}'. No payment was taken.`);
  }
  if (!isGatewayReady()) return apiError(c, 503, "facilitator_unavailable", "Payment verification is unavailable. No payment was taken.");
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  if (rawBody.length > MAX_BODY_BYTES) return apiError(c, 413, "body_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes.`);
  if (rawBody.length) {
    try {
      JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return apiError(c, 400, "invalid_json", "Body must be JSON. No payment was taken.");
    }
  }

  let wifPrice;
  let amountAtomic = String(listing.price_micro);
  let quoteId: string | undefined;
  const requestSha256 = sha256Hex(rawBody);
  const paymentHeader = paymentHeaderOf(c);
  if (config.paymentChain === "robinhood") {
    if (paymentHeader) {
      const accepted = evmAcceptedFromHeader(paymentHeader);
      const challenge = typeof accepted?.extra?.quoteId === "string"
        ? getWifQuoteChallenge(accepted.extra.quoteId, c.req.path, requestSha256) : undefined;
      if (!challenge) return apiError(c, 409, "wif_quote_expired", "The WIF quote is unavailable for this exact request. No payment was taken; request a fresh quote.");
      if (challenge.amountMicro !== listing.price_micro || !matchesWifQuoteRequirement(accepted, challenge, {
        network: config.networkCaip2, asset: config.paymentAssetAddress, payTo: config.payToAddress,
        symbol: config.paymentAssetSymbol, decimals: config.paymentAssetDecimals, maxTimeoutSeconds: WIF_CHAT_MAX_TIMEOUT_SECONDS,
      })) return apiError(c, 409, "wif_quote_mismatch", "Signed terms do not match the original listing quote. No payment was taken.");
      wifPrice = challenge.wifPrice;
      amountAtomic = challenge.amountAtomic;
      quoteId = challenge.quoteId;
    } else {
    try {
      wifPrice = await getWifPriceSnapshot();
      amountAtomic = usdMicroToTokenAtomic(listing.price_micro, BigInt(wifPrice.effectivePriceUsdScaled18), config.paymentAssetDecimals);
      quoteId = newId("wq");
    } catch (err: any) {
      return apiError(c, 503, "wif_price_unavailable", `Cannot safely quote WIF right now: ${err?.message ?? String(err)}. No payment was taken.`);
    }
    }
  }
  setPaymentState(c, {
    requestId: newId("req"),
    kind: "market",
    resource: `/v1/market/${listing.slug}/call`,
    listing,
    rawBody,
    requestSha256,
    amountMicro: listing.price_micro,
    amountAtomic,
    wifPrice,
    quoteId,
    // Authorization means creator work runs before settlement; only 2xx may settle.
    paymentFlow: "authorization",
  });
  c.header("Moltworld-Quote", microToUsdString(listing.price_micro));
  await next();
  if (!paymentHeader && quoteId && wifPrice && c.res.status === 402 && c.res.headers.has("payment-required")) {
    rememberWifQuoteChallenge({ quoteId, route: c.req.path, requestSha256, amountMicro: listing.price_micro, amountAtomic, wifPrice });
  }
};

export function signForCreator(secret: string, timestamp: string, requestId: string, body: Uint8Array): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${requestId}.${sha256Hex(body)}`).digest("base64url");
}

export async function handleMarketCall(c: Context): Promise<Response> {
  const blocked = disabled(c);
  if (blocked) return blocked;
  const state = getPaymentState(c);
  const listing = state?.listing;
  if (!state || !listing) return apiError(c, 500, "internal_error", "Request was not prepared.");
  const timestamp = String(Math.floor(Date.now() / 1000));
  let upstream: SafeResponse;
  try {
    upstream = await creatorFetcher(listing.upstream_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Moltworld-Market/1.0",
        "X-Moltworld-Request-Id": state.requestId,
        "X-Moltworld-Payer": state.payer ?? "",
        "X-Moltworld-Timestamp": timestamp,
        "X-Moltworld-Signature": signForCreator(listing.signing_secret, timestamp, state.requestId, state.rawBody),
      },
      body: state.rawBody,
      timeoutMs: 30_000,
      maxBytes: MAX_RESPONSE_BYTES,
    });
  } catch (err: any) {
    return apiError(c, 502, "creator_unreachable", `${err.message} Your payment was not settled; you were not charged.`);
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    return apiError(c, 502, "creator_error", `Creator endpoint returned HTTP ${upstream.status}. Your payment was not settled.`);
  }
  state.upstream = { provider: "market", model: listing.slug };
  // Never serve creator-controlled HTML/JS from Moltworld's origin.
  const contentType = /^application\/json\b/i.test(upstream.contentType) ? "application/json" : "text/plain; charset=utf-8";
  return new Response(Buffer.from(upstream.body), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}
