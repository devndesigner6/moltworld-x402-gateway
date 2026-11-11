import type { Context, MiddlewareHandler } from "hono";
import type { x402ResourceServer } from "@x402/core/server";
import { config } from "../config.js";
import { defaultModelRegistry, getModelEndpoint, ModelDefinition } from "../models/registry.js";
import { defaultProviderRegistry } from "../providers/index.js";
import { validateBody } from "../middleware/validation.js";
import { actualChatPriceMicro, quoteRequest, referenceRequest } from "../pricing/index.js";
import { getWifPriceSnapshot, usdMicroToTokenAtomic, wifBalanceUsdMicro } from "../pricing/wif.js";
import {
  addCredit,
  type CompletionCredit,
  completeRequest,
  createRefund,
  createRequest,
  getMandate,
  getRequestByPaymentHash,
  mandateSpendLast24h,
  markSettled,
  newId,
  setRequestStatus,
} from "../ledger/index.js";
import { encodeReceiptHeader, receiptSigner, sha256Hex } from "../receipts/index.js";
import { usdcBalanceMicro } from "../chain/algod.js";
import { coordination } from "./coordination.js";
import { getPaymentState, PaymentState, setPaymentState, stateFromTransport } from "./state.js";
import { evmAcceptedFromHeader, evmPayerFromPayload, evmPaymentIdFromHeader, evmPaymentIdFromPayload } from "./evm-identity.js";
import { getWifQuoteChallenge, matchesWifQuoteRequirement, rememberWifQuoteChallenge, WIF_CHAT_MAX_TIMEOUT_SECONDS } from "./wif-challenges.js";
import { creatorShareAtomic } from "./marketplace-evm.js";
import {
  logicSigProgramFromPayload,
  agentSignatureValid,
  mandateId,
  parseMandateProgram,
  payerFromPayload,
  paymentTxidFromHeader,
  paymentTxidFromPayload,
} from "../mandates/index.js";

const MAX_STORED_RESPONSE_BYTES = 1_000_000;
const PAYMENT_LOCK_MS = 10 * 60 * 1000;

let gatewayReady = false;
let gatewayError: string | null = null;

export function setGatewayReady(ready: boolean, error?: string): void {
  gatewayReady = ready;
  gatewayError = error ?? null;
}

export function isGatewayReady(): boolean {
  return gatewayReady;
}

export function gatewayInitError(): string | null {
  return gatewayError;
}

export function apiError(c: Context, status: number, code: string, message: string, extra?: Record<string, unknown>) {
  if (["wif_quote_expired", "wif_quote_mismatch", "model_not_found", "model_unavailable", "validation_error", "invalid_json", "facilitator_unavailable", "wif_price_unavailable", "marketplace_disabled", "listing_not_found"].includes(code)) {
    c.header("Moltworld-Payment-Status", "uncharged");
  }
  return c.json({ error: { code, message, ...extra } }, status as any);
}

export function paymentHeaderOf(c: Context): string | undefined {
  return c.req.header("payment-signature") ?? c.req.header("x-payment") ?? undefined;
}

/** Upstream modalities that cost real money per call settle *before* the work runs. */
export function paymentFlowFor(model: ModelDefinition): "authorization" | "upfront" {
  return model.modality === "chat" ? "authorization" : "upfront";
}

const OPERATION_FOR: Record<string, string> = {
  "chat/completions": "chat",
  "images/generations": "image",
  "audio/speech": "voice",
  "videos/generations": "video",
};

/**
 * Runs before the payment middleware for POST /v1/models/:model/*. Unknown
 * models, unavailable upstreams and invalid bodies are rejected here, so a
 * caller is never asked to pay for a request that cannot succeed.
 */
export const prepareModelRequest: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "POST") return next();
  const match = c.req.path.match(/^\/v1\/models\/([^/]+)\/([^/]+\/[^/]+)$/);
  if (!match) return next();
  const [, slug, operation] = match;
  const model = defaultModelRegistry.getModel(slug);
  if (!model || OPERATION_FOR[operation] !== model.modality) {
    return apiError(c, 404, "model_not_found", `No ${OPERATION_FOR[operation] ?? ""} model '${slug}'. See GET /v1/models.`);
  }
  if (config.paymentChain === "robinhood" && model.modality !== "chat") {
    return apiError(c, 503, "migration_incomplete", "Robinhood WIF checkout is enabled for chat only while WIF refunds and payouts are being migrated. No payment was taken.");
  }
  const unavailable = defaultModelRegistry.getUnavailableReason(model);
  if (unavailable || !defaultProviderRegistry.supports(model)) {
    return apiError(c, 503, "model_unavailable", `Model '${slug}' is not available: ${unavailable ?? "provider not configured"}. No payment was taken.`);
  }
  if (!gatewayReady) {
    return apiError(c, 503, "facilitator_unavailable", "Payment verification is unavailable. Failing closed; no payment was taken.");
  }

  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const paymentHeader = paymentHeaderOf(c);
  const hasPayment = !!paymentHeader;
  let request;
  if (rawBody.length === 0 && !hasPayment) {
    // A bare probe (e.g. a discovery crawler) gets a 402 priced for a reference request.
    request = referenceRequest(model);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return apiError(c, 400, "invalid_json", "Request body must be valid JSON. No payment was taken.");
    }
    const result = validateBody(parsed, model);
    if (!result.valid) return apiError(c, 400, "validation_error", `${result.error} No payment was taken.`);
    request = result.request;
  }

  const quote = quoteRequest(model, request);
  const requestSha256 = sha256Hex(rawBody);
  let wifPrice;
  let amountAtomic = String(quote.microUsdc);
  let quoteId: string | undefined;
  if (config.paymentChain === "robinhood") {
    if (hasPayment) {
      const accepted = evmAcceptedFromHeader(paymentHeader!);
      const requestedQuoteId = typeof accepted?.extra?.quoteId === "string" ? accepted.extra.quoteId : "";
      const challenge = requestedQuoteId
        ? getWifQuoteChallenge(requestedQuoteId, c.req.path, requestSha256)
        : undefined;
      if (!challenge) {
        return apiError(c, 409, "wif_quote_expired", "The signed WIF quote is expired or unavailable for this exact request. No payment was taken; run the request again for a fresh quote.");
      }
      if (challenge.amountMicro !== quote.microUsdc || !matchesWifQuoteRequirement(accepted, challenge, {
        network: config.networkCaip2,
        asset: config.paymentAssetAddress,
        payTo: config.payToAddress,
        symbol: config.paymentAssetSymbol,
        decimals: config.paymentAssetDecimals,
        maxTimeoutSeconds: WIF_CHAT_MAX_TIMEOUT_SECONDS,
      })) {
        return apiError(c, 409, "wif_quote_mismatch", "The signed WIF terms do not match the server-issued quote for this request. No payment was taken; run the request again for a fresh quote.");
      }
      wifPrice = challenge.wifPrice;
      amountAtomic = challenge.amountAtomic;
      quoteId = challenge.quoteId;
    } else {
      try {
        wifPrice = await getWifPriceSnapshot();
        amountAtomic = usdMicroToTokenAtomic(quote.microUsdc, BigInt(wifPrice.effectivePriceUsdScaled18), config.paymentAssetDecimals);
        quoteId = newId("wq");
      } catch (err: any) {
        return apiError(c, 503, "wif_price_unavailable", `Cannot safely quote WIF right now: ${err?.message ?? String(err)}. No payment was taken.`);
      }
    }
  }
  const state: PaymentState = {
    requestId: newId("req"),
    kind: "model",
    resource: getModelEndpoint(model),
    model,
    request,
    rawBody,
    requestSha256,
    quote,
    amountMicro: quote.microUsdc,
    amountAtomic,
    wifPrice,
    quoteId,
    paymentFlow: paymentFlowFor(model),
  };
  setPaymentState(c, state);
  c.header("Moltworld-Quote", quote.formattedPrice);
  await next();
  if (!hasPayment && quoteId && wifPrice && c.res.status === 402 && c.res.headers.has("payment-required")) {
    rememberWifQuoteChallenge({
      quoteId,
      route: c.req.path,
      requestSha256,
      amountMicro: quote.microUsdc,
      amountAtomic,
      wifPrice,
    });
  }
  return;
};

/** Dynamic x402 price: the amount computed by prepareModelRequest/prepareMarketRequest. */
export function priceFromState(ctx: any) {
  const state = getPaymentState(ctx.adapter.c);
  if (!state) throw new Error("Payment state missing: request was not prepared.");
  return {
    amount: state.amountAtomic,
    asset: config.paymentAssetAddress,
    extra: config.paymentChain === "robinhood"
      ? {
          assetTransferMethod: "permit2",
          decimals: config.paymentAssetDecimals,
          symbol: config.paymentAssetSymbol,
          quotedUsdMicro: state.amountMicro,
          wifPriceUsdScaled18: state.wifPrice?.effectivePriceUsdScaled18,
          wifSpotPriceUsd: state.wifPrice?.priceUsd,
          quoteId: state.quoteId,
        }
      : {},
  };
}

function abortWith(state: PaymentState, reason: string, message: string) {
  state.rejection = { reason, message };
  return { abort: true as const, reason, message };
}

function safeFailureText(value: unknown, fallback: string, maxLength: number): string {
  const text = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
    : "";
  return text ? text.slice(0, maxLength) : fallback;
}

export function registerPaymentHooks(server: x402ResourceServer): void {
  server.onBeforeVerify(async (ctx) => {
    const state = stateFromTransport(ctx.transportContext);
    if (!state) return;
    const c = (ctx.transportContext as any).request.adapter.c as Context;
    const header = paymentHeaderOf(c);
    if (!header) return;

    const payer = config.paymentChain === "robinhood" ? evmPayerFromPayload(ctx.paymentPayload) : payerFromPayload(ctx.paymentPayload);
    const paymentId = config.paymentChain === "robinhood" ? evmPaymentIdFromPayload(ctx.paymentPayload) : paymentTxidFromPayload(ctx.paymentPayload);
    if (!payer || !paymentId) return abortWith(state, "invalid_payload", "Could not decode the payment authorization.");
    state.paymentHash = paymentId;
    state.payer = payer;

    // One signed payment buys one request. Concurrent or repeated submissions are refused.
    if (!(await coordination.acquire(`pay:${state.paymentHash}`, PAYMENT_LOCK_MS))) {
      return abortWith(state, "duplicate_payment_in_flight", "This payment is already being processed.");
    }
    (state as any).lockHeld = true;
    const existing = await getRequestByPaymentHash(state.paymentHash);
    if (existing) {
      return abortWith(state, "payment_already_used", `This payment was already used for request ${existing.id} (${existing.status}).`);
    }

    // The legacy mandate model is AVM-specific. Robinhood mode accepts direct WIF payments only.
    const program = config.paymentChain === "algorand" ? logicSigProgramFromPayload(ctx.paymentPayload) : null;
    const mandateTerms = program ? parseMandateProgram(program) : null;
    if (program && mandateTerms) {
      const id = mandateId(program);
      const mandate = await getMandate(id);
      if (!mandate || mandate.status !== "active") {
        return abortWith(state, "mandate_not_active", `Mandate ${id} is ${mandate ? mandate.status : "not registered"}.`);
      }
      if (mandate.owner !== payer) return abortWith(state, "mandate_owner_mismatch", "Mandate was registered by a different owner.");
      // Mandates registered before agent binding pay with the credential alone; refuse them.
      if (!mandateTerms.agent) {
        return abortWith(state, "mandate_not_bound", "This mandate is not bound to an agent key, so its credential alone could pay. Create a new mandate bound to the agent's key.");
      }
      // Algorand enforces this too; checking here gives a clear error before any settlement.
      if (!agentSignatureValid(ctx.paymentPayload, mandateTerms)) {
        return abortWith(state, "mandate_agent_signature_invalid", "Payment is not signed by the mandate's agent key.");
      }
      if (state.model && mandate.allowed_models?.length && !mandate.allowed_models.includes(state.model.slug)) {
        return abortWith(state, "mandate_model_not_allowed", `Mandate does not allow model '${state.model.slug}'.`);
      }
      const spent = await mandateSpendLast24h(id);
      const remaining = mandate.daily_cap_micro - spent;
      if (!(await coordination.reserve(`mandate:${id}`, state.amountMicro, Math.max(0, remaining), 1000))) {
        return abortWith(state, "mandate_daily_cap_exceeded", `Mandate daily cap reached (${spent} of ${mandate.daily_cap_micro} micro-USDC spent).`);
      }
      state.mandateId = id;
    }

    // Authorization flow serves before settling, so cap what one payer can have in flight
    // at their actual on-chain balance: concurrent requests cannot outspend the wallet.
    if (state.paymentFlow === "authorization") {
      const balance = config.paymentChain === "robinhood"
        ? await wifBalanceUsdMicro(payer, state.wifPrice!)
        : await usdcBalanceMicro(payer);
      if (config.paymentChain === "robinhood" && balance === null) {
        return abortWith(state, "wif_balance_unavailable", "Could not verify the WIF balance on Robinhood Chain. No payment was taken; please retry shortly.");
      }
      if (!(await coordination.reserve(payer, state.amountMicro, balance, config.maxInflightPerPayer))) {
        return abortWith(state, 
          "payer_exposure_limit",
          `Too many unsettled requests for this wallet's ${config.paymentAssetSymbol} balance. Wait for in-flight requests to finish.`
        );
      }
      state.reservedMicro = state.amountMicro;
    }
  });

  // Authorization flow: the facilitator verified the payment; record it before the work runs.
  server.onAfterVerify(async (ctx) => {
    const state = stateFromTransport(ctx.transportContext);
    if (!state) return;
    if (!ctx.result.isValid) {
      const reason = safeFailureText(ctx.result.invalidReason, "payment_rejected", 80);
      const message = safeFailureText(ctx.result.invalidMessage, reason, 240);
      state.rejection = { reason, message };
      return;
    }
    if (!state.paymentHash) return;
    state.payer = (ctx.result as any).payer ?? state.payer!;
    if (!(await recordRequest(state, ctx.requirements))) return abortWith(state, "payment_already_used", "This payment was already used.");
  });

  server.onAfterSettle(async (ctx) => {
    if (ctx.phase === "cancel") return;
    const state = stateFromTransport(ctx.transportContext);
    if (!state?.paymentHash || !ctx.result.success) return;
    // Upfront flow skips facilitator /verify: settlement is the proof, so record here.
    if (!state.recorded) {
      state.payer = ctx.result.payer ?? state.payer!;
      await recordRequest(state, ctx.requirements);
    }
    state.settlement = { txid: ctx.result.transaction, phase: ctx.phase };
    await markSettled(state.requestId, ctx.result.transaction);
  });
}

async function recordRequest(state: PaymentState, requirements: { payTo: string; network: string; asset: string; amount: string }): Promise<boolean> {
  const sameAddress = (left: string, right: string) => config.paymentChain === "robinhood"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
  if (
    requirements.network !== config.networkCaip2 ||
    !sameAddress(requirements.asset, config.paymentAssetAddress) ||
    !sameAddress(requirements.payTo, config.payToAddress) ||
    BigInt(requirements.amount) !== BigInt(state.amountAtomic)
  ) {
    throw new Error("Facilitator payment terms do not match the quote-bound chain, WIF asset, payTo, or amount.");
  }
  const recorded = await createRequest({
    id: state.requestId,
    paymentHash: state.paymentHash!,
    kind: state.kind,
    resource: state.resource,
    modelSlug: state.model?.slug,
    modality: state.model?.modality,
    listingId: state.listing?.id,
    mandateId: state.mandateId,
    payer: state.payer!,
    payTo: requirements.payTo,
    network: requirements.network,
    asset: requirements.asset,
    amountMicro: state.amountMicro,
    amountAtomic: requirements.amount,
    quote: state.quote,
    paymentFlow: state.paymentFlow,
    requestSha256: state.requestSha256,
  });
  state.recorded = recorded;
  return recorded;
}

async function releaseCoordination(state: PaymentState) {
  if (state.reservedMicro && state.payer) await coordination.unreserve(state.payer, state.reservedMicro);
  if (state.mandateId) await coordination.unreserve(`mandate:${state.mandateId}`, state.amountMicro);
  if ((state as any).lockHeld && state.paymentHash) await coordination.release(`pay:${state.paymentHash}`);
}

async function errorMessageOf(res: Response): Promise<string> {
  try {
    const body: any = await res.clone().json();
    return String(body?.error?.message ?? body?.error ?? `HTTP ${res.status}`);
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * Wraps the x402 payment middleware. Before it: serves exact replays of an
 * already-completed paid request (safe retries after a dropped connection).
 * After it: records the outcome, issues the signed receipt, books usage rebates
 * and creator earnings, and queues a refund when settled work failed.
 */
export const commerceMiddleware: MiddlewareHandler = async (c, next) => {
  const header = paymentHeaderOf(c);
  const paymentKey = header
    ? config.paymentChain === "robinhood" ? evmPaymentIdFromHeader(header) : paymentTxidFromHeader(header)
    : null;
  if (paymentKey) {
    const prior = await getRequestByPaymentHash(paymentKey);
    if (prior?.status === "completed" && prior.receipt) {
      if (!prior.response_body) {
        return apiError(c, 409, "payment_already_used", "This payment already completed; its response is too large to replay.", {
          request_id: prior.id,
          receipt_url: `${config.publicDomain}/v1/receipts/${prior.id}`,
        });
      }
      return new Response(Buffer.from(prior.response_body), {
        status: prior.response_status ?? 200,
        headers: {
          "Content-Type": prior.response_content_type ?? "application/json",
          "Moltworld-Request-Id": prior.id,
          "Moltworld-Receipt": encodeReceiptHeader(prior.receipt),
          "Moltworld-Replay": "true",
          "Cache-Control": "private, no-store",
        },
      });
    }
  }

  await next();

  const state = getPaymentState(c);
  if (c.res.status === 402 && header) await explainPaymentFailure(c, state);
  if (!state) return;
  c.res.headers.set("Moltworld-Request-Id", state.requestId);
  try {
    if (state.recorded) await finalize(c, state);
  } finally {
    await releaseCoordination(state);
  }
};

/** The x402 middleware only reports why a payment was refused inside the Payment-Required header. */
async function explainPaymentFailure(c: Context, state?: PaymentState): Promise<void> {
  const text = await c.res.clone().text();
  if (text && text !== "{}") return;
  const headers = new Headers(c.res.headers);
  headers.set("Content-Type", "application/json");
  if (state?.rejection) {
    c.res = new Response(JSON.stringify({ error: { code: state.rejection.reason, message: state.rejection.message } }), { status: 402, headers });
    return;
  }
  let reason = "payment_rejected";
  try {
    const required = JSON.parse(Buffer.from(c.res.headers.get("payment-required") ?? "", "base64").toString("utf8"));
    if (required?.error) reason = String(required.error);
  } catch {
    // keep generic reason
  }
  c.res = new Response(JSON.stringify({ error: { code: reason.split(":")[0].trim(), message: reason } }), { status: 402, headers });
}

async function finalize(c: Context, state: PaymentState): Promise<void> {
  const res = c.res;
  const payer = state.payer!;

  if (state.settlement && res.status < 400) {
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    const responseSha256 = sha256Hex(bytes);

    let actualPriceMicro: number | undefined;
    let rebateMicro = 0;
    if (state.model?.modality === "chat" && state.upstream?.usage) {
      actualPriceMicro = actualChatPriceMicro(state.model, state.upstream.usage, state.upstream.costUsd);
      if (config.paymentChain === "algorand") rebateMicro = Math.max(0, state.amountMicro - actualPriceMicro);
    }

    const receipt = receiptSigner.sign({
      id: state.requestId,
      network: config.networkCaip2,
      asset: config.paymentAssetAddress,
      payer,
      payTo: config.payToAddress,
      amountMicro: state.amountMicro,
      amountAtomic: state.amountAtomic,
      assetDecimals: config.paymentAssetDecimals,
      assetSymbol: config.paymentAssetSymbol,
      quotedUsdMicro: state.amountMicro,
      ...(state.wifPrice ? { wifPrice: { source: state.wifPrice.source, priceUsd: state.wifPrice.priceUsd, observedAt: state.wifPrice.observedAt, liquidityUsd: state.wifPrice.liquidityUsd } } : {}),
      txid: state.settlement.txid,
      resource: state.resource,
      model: state.model?.slug ?? state.listing?.slug ?? null,
      upstreamProvider: state.upstream?.provider ?? null,
      upstreamModel: state.upstream?.model ?? null,
      requestSha256: state.requestSha256,
      responseSha256,
      rebateMicro,
    });

    const completion = {
      upstreamProvider: state.upstream?.provider,
      upstreamModel: state.upstream?.model,
      upstreamCostUsd: state.upstream?.costUsd,
      actualPriceMicro,
      rebateMicro,
      responseSha256,
      responseStatus: res.status,
      responseContentType: res.headers.get("content-type") ?? "application/json",
      responseBody: bytes.length <= MAX_STORED_RESPONSE_BYTES ? bytes : null,
      receipt,
    };
    const credits: CompletionCredit[] = [];
    const asset = { assetAddress: config.paymentAssetAddress, assetSymbol: config.paymentAssetSymbol, assetDecimals: config.paymentAssetDecimals, network: config.networkCaip2 };
    if (config.paymentChain === "algorand" && rebateMicro > 0) {
      credits.push({ account: payer, kind: "rebate", amountMicro: rebateMicro, amountAtomic: String(rebateMicro), asset });
    }
    // The default marketplace fee remains 15% (configurable via MARKETPLACE_FEE_PERCENT).
    // Robinhood credits are ledger-only; no EVM payout/refund signer is invoked here.
    if (state.listing) {
      const creatorShareMicro = Math.floor((state.amountMicro * (100 - config.marketplaceFeePercent)) / 100);
      const creatorAmountAtomic = config.paymentChain === "robinhood"
        ? creatorShareAtomic(state.amountAtomic, config.marketplaceFeePercent)
        : String(creatorShareMicro);
      credits.push({ account: state.listing.creator, kind: "creator", amountMicro: creatorShareMicro, amountAtomic: creatorAmountAtomic, asset });
    }
    await completeRequest(state.requestId, completion, credits);
    c.res.headers.set("Moltworld-Payment-Status", "settled");
    c.res.headers.set("Moltworld-Receipt", encodeReceiptHeader(receipt));
    return;
  }

  if (state.settlement) {
    // The legacy refund worker pays Algorand USDC. Never send it for WIF.
    const reason = await errorMessageOf(res);
    if (config.paymentChain === "robinhood") {
      await setRequestStatus(state.requestId, "refund_pending", `Manual WIF refund required: ${reason}`);
      c.res.headers.set("Moltworld-Refund", "manual-review");
    } else {
      await createRefund(state.requestId, payer, state.amountMicro, `Upstream failure after settlement: ${reason}`);
      c.res.headers.set("Moltworld-Refund", "pending");
    }
    return;
  }

  if (state.upstream) {
    // Authorization flow: the work ran but settlement failed, so the output was withheld.
    await setRequestStatus(state.requestId, "settle_failed", await errorMessageOf(res));
    return;
  }
  c.res.headers.set("Moltworld-Payment-Status", "uncharged");
  await setRequestStatus(state.requestId, "failed", await errorMessageOf(res));
}
