import type { Context } from "hono";
import { ROUNDS_PER_DAY } from "../mandates/index.js";
import fs from "fs";
import path from "path";
import { config, marketplaceEnabled } from "../config.js";
import { defaultModelRegistry, getModelEndpoint, ModelDefinition } from "../models/registry.js";
import { defaultProviderRegistry } from "../providers/index.js";
import { validateBody } from "../middleware/validation.js";
import { microToUsdString, quoteRequest, referenceRequest, usdToMicroCeil } from "../pricing/index.js";
import { getWifPriceSnapshot, usdMicroToTokenAtomic } from "../pricing/wif.js";
import { getJob, getJobByRequest, getRefundByRequest, getRequest, getStats } from "../ledger/index.js";
import { getDatabase } from "../ledger/db.js";
import { receiptSigner, SignedReceipt } from "../receipts/index.js";
import { apiError, gatewayInitError, isGatewayReady } from "../payments/gateway.js";
import { payoutAccount } from "../workers/payouts.js";

const startedAt = Date.now();
let lastSync: { at: string; unverified: Record<string, string>; errors: string[] } | null = null;

export function recordCatalogSync(report: { unverified: Record<string, string>; errors: string[] }) {
  lastSync = { at: new Date().toISOString(), unverified: report.unverified, errors: report.errors };
}

function modelView(m: ModelDefinition) {
  const from = quoteRequest(m, referenceRequest(m));
  return {
    id: m.slug,
    name: m.displayName,
    modality: m.modality,
    provider: m.provider,
    upstream_model: m.upstreamModelId,
    endpoint: getModelEndpoint(m),
    from_price: from.formattedPrice,
    from_price_request: from.units,
    cost_basis: m.cost,
    cost_source: m.costSource,
    margin_percent: from.marginPercent,
    payment_flow: m.modality === "chat" ? "authorization" : "upfront",
    limits: m.limits,
    sizes: m.image?.sizes,
    durations: m.video?.durations,
    aspect_ratios: m.video?.aspectRatios,
    voices: m.voices,
    audio_formats: m.audioFormats,
    description: m.description,
    tags: m.tags,
  };
}

function modelAvailableOnPaymentRail(model: ModelDefinition): boolean {
  return config.paymentChain !== "robinhood" || model.modality === "chat";
}

export async function handleHealth(c: Context): Promise<Response> {
  let ledger = "unavailable";
  try {
    const db = await getDatabase();
    await db.query("SELECT 1");
    ledger = db.kind;
  } catch {
    // reported below
  }
  const ready = isGatewayReady() && ledger !== "unavailable";
  const models = defaultModelRegistry.getEnabledModels()
    .filter((m) => defaultProviderRegistry.supports(m))
    .filter(modelAvailableOnPaymentRail);
  const body = {
    status: ready ? "healthy" : "degraded",
    ready,
    version: "3.0.0",
    product: "Moltworld",
    error: ready ? undefined : gatewayInitError() ?? (ledger === "unavailable" ? "Ledger unavailable" : undefined),
    public_domain: config.publicDomain,
    payment_chain: config.paymentChain,
    network: config.isMainnet ? "mainnet" : "testnet",
    network_caip2: config.networkCaip2,
    payment_asset: config.paymentAssetAddress,
    payment_symbol: config.paymentAssetSymbol,
    payment_decimals: config.paymentAssetDecimals,
    usdc_asset_id: config.usdcAsaId,
    pay_to: config.payToAddress,
    facilitator: config.facilitatorUrl,
    // Clients rebuild the counter from these terms and compare it with the deployed app's code.
    mandate_counter: config.mandateCounterAppId
      ? { app_id: config.mandateCounterAppId, min_amount_micro: Math.round(config.priceMinFloor * 1_000_000), window_rounds: ROUNDS_PER_DAY }
      : null,
    ledger,
    providers: defaultProviderRegistry.listConfiguredProviders(),
    mock_providers: config.mockProviders,
    enabled_models: models.length,
    models_by_modality: {
      chat: models.filter((m) => m.modality === "chat").length,
      image: models.filter((m) => m.modality === "image").length,
      voice: models.filter((m) => m.modality === "voice").length,
      video: models.filter((m) => m.modality === "video").length,
    },
    catalog_sync: lastSync,
    pricing: { model: "cost_plus_per_request", margin_percent: Math.round(config.priceMargin * 100), min_price: `$${config.priceMinFloor}` },
    receipts: { kid: receiptSigner.kid, persistent_key: !receiptSigner.ephemeral, keys_url: `${config.publicDomain}/.well-known/moltworld-receipts.json` },
    payouts_enabled: config.paymentChain === "algorand" && !!payoutAccount(),
    marketplace_enabled: marketplaceEnabled(),
    creator_payout_mode: config.paymentChain === "robinhood" && marketplaceEnabled() ? "wallet_verified" : "legacy_or_disabled",
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  };
  return c.json(body, ready ? 200 : 503);
}

export function handleListModels(c: Context): Response {
  const modality = c.req.query("modality");
  const models = defaultModelRegistry
    .getEnabledModels()
    .filter((m) => defaultProviderRegistry.supports(m))
    .filter(modelAvailableOnPaymentRail)
    .filter((m) => !modality || m.modality === modality);
  const body: Record<string, unknown> = { object: "list", data: models.map(modelView) };
  if (c.req.query("include") === "unavailable") {
    body.unavailable = defaultModelRegistry
      .getAllModels()
      .filter(modelAvailableOnPaymentRail)
      .filter((m) => !models.includes(m) && (!modality || m.modality === modality))
      .map((m) => ({
        id: m.slug,
        name: m.displayName,
        reason: defaultModelRegistry.getUnavailableReason(m) ?? `provider '${m.provider}' is not configured`,
      }));
  }
  return c.json(body);
}

/** Free price quote for an exact request body; identical to the amount the 402 challenge will ask for. */
export async function handleQuote(c: Context): Promise<Response> {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, "invalid_json", "Body must be JSON: { \"model\": \"<slug>\", ...request }.");
  }
  const slug = typeof body?.model === "string" ? body.model : "";
  const model = defaultModelRegistry.getModel(slug);
  if (!model) return apiError(c, 404, "model_not_found", `Unknown model '${slug}'.`);
  if (config.paymentChain === "robinhood" && model.modality !== "chat") {
    return apiError(c, 503, "migration_incomplete", "Robinhood WIF checkout is currently enabled for chat only.");
  }
  const unavailable = defaultModelRegistry.getUnavailableReason(model);
  if (unavailable || !defaultProviderRegistry.supports(model)) {
    return apiError(c, 503, "model_unavailable", `Model '${slug}' is not available: ${unavailable ?? "provider not configured"}. No payment was taken.`);
  }
  const { model: _ignored, ...request } = body;
  const result = validateBody(request, model);
  if (!result.valid) return apiError(c, 400, "validation_error", result.error);
  const quote = quoteRequest(model, result.request);
  let payment: Record<string, unknown> | undefined;
  if (config.paymentChain === "robinhood") {
    try {
      const price = await getWifPriceSnapshot();
      payment = {
        amountAtomic: usdMicroToTokenAtomic(quote.microUsdc, BigInt(price.effectivePriceUsdScaled18), config.paymentAssetDecimals),
        asset: config.paymentAssetAddress,
        symbol: config.paymentAssetSymbol,
        decimals: config.paymentAssetDecimals,
        network: config.networkCaip2,
        wifPrice: { source: price.source, priceUsd: price.priceUsd, observedAt: price.observedAt, liquidityUsd: price.liquidityUsd },
      };
    } catch (err: any) {
      return apiError(c, 503, "wif_price_unavailable", `Cannot safely quote WIF right now: ${err?.message ?? String(err)}.`);
    }
  }
  return c.json({
    model: model.slug,
    name: model.displayName,
    available: defaultModelRegistry.isAvailable(model) && defaultProviderRegistry.supports(model),
    endpoint: getModelEndpoint(model),
    payment_flow: model.modality === "chat" ? "authorization" : "upfront",
    quote: { ...quote, ...payment },
    note: config.paymentChain === "robinhood"
      ? "WIF payment is denominated from a guarded live price snapshot; the signed 402 challenge is the authoritative amount."
      : model.modality === "chat"
        ? "Chat is charged for the full max_tokens budget; the unused part is credited back as a USDC rebate."
        : "Charged up front; refunded in full if the upstream fails.",
  });
}

function operatorWallets(): string[] {
  const wallets = new Set<string>([config.payToAddress]);
  for (const w of (process.env.OPERATOR_WALLETS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) wallets.add(w);
  const fleetPath = path.join(process.cwd(), ".mainnet_fleet.json");
  if (fs.existsSync(fleetPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(fleetPath, "utf-8"));
      if (Array.isArray(data)) for (const item of data) if (item?.address) wallets.add(item.address);
    } catch {
      // ignore malformed fleet file
    }
  }
  return [...wallets];
}

export interface FacilitatorStats {
  id: string;
  volume: number;
  settles: number;
  successRate: number;
  payers: number;
  avgTicket: number;
  avgSettleMs: number;
  firstSeen?: number;
  lastSeen?: number;
  bazaar?: boolean;
  challenge?: boolean;
  accounts?: Array<{ network: { slug: string; name: string; testnet: boolean }; address: string; status: string }>;
  networks?: Array<{
    network: string;
    slug: string;
    name: string;
    volume: number;
    events: number;
    testnet: boolean;
  }>;
  resources?: Array<{
    id: string;
    url: string;
    method: string;
    settles: number;
    volume: number;
    price: number;
    priceAsset: string;
  }>;
}

// The facilitator is slow to answer now and then. Serve the last good answer while a refresh runs in
// the background, so a slow request never blanks the page.
let cachedFacilitatorStats: { data: FacilitatorStats | null; fetchedAt: number } = { data: null, fetchedAt: 0 };
let facilitatorRefresh: Promise<FacilitatorStats | null> | null = null;
const FACILITATOR_CACHE_TTL_MS = 60_000;
const FACILITATOR_TIMEOUT_MS = 8_000;

function refreshFacilitatorStats(): Promise<FacilitatorStats | null> {
  facilitatorRefresh ??= (async () => {
    try {
      const merchantId = encodeURIComponent(config.facilitatorMerchantId || "414f1538ce0d6de4");
      // Scope to this deployment's network so testnet traffic is not counted on mainnet (and the reverse).
      const env = config.isMainnet ? "mainnet" : "testnet";
      const res = await fetch(`${config.facilitatorUrl}/data/merchants/${merchantId}?env=${env}`, {
        signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return cachedFacilitatorStats.data;
      const json = (await res.json()) as FacilitatorStats;
      if (json && typeof json.settles === "number") {
        cachedFacilitatorStats = { data: json, fetchedAt: Date.now() };
        return json;
      }
    } catch {
      // Unreachable or slow: keep serving whatever we already have.
    } finally {
      facilitatorRefresh = null;
    }
    return cachedFacilitatorStats.data;
  })();
  return facilitatorRefresh;
}

/** Fills the cache at startup so the first visitor to /stats already sees the facilitator's figures. */
export function warmFacilitatorStats(): void {
  if (!config.isTest) void refreshFacilitatorStats();
}

export async function fetchFacilitatorStats(): Promise<FacilitatorStats | null> {
  if (config.isTest) return null;
  const { data, fetchedAt } = cachedFacilitatorStats;
  if (data && Date.now() - fetchedAt < FACILITATOR_CACHE_TTL_MS) return data;
  const refresh = refreshFacilitatorStats();
  return data ?? refresh;
}

const MODALITY_BY_ENDPOINT: Record<string, string> = { chat: "chat", images: "image", audio: "voice", videos: "video" };

/** Names a settled resource by the model it serves; marketplace and other endpoints keep their path. */
function describeResource(url: string): { model: string; modality: string } {
  const model = url.match(/\/v1\/models\/([^/]+)\/([^/]+)/);
  if (model) return { model: model[1], modality: MODALITY_BY_ENDPOINT[model[2]] ?? "other" };
  const market = url.match(/\/v1\/market\/([^/]+)/);
  if (market) return { model: market[1], modality: "market" };
  return { model: url.replace(/^https?:\/\/[^/]+/, ""), modality: "other" };
}

const isoOrNull = (ms?: number) => (ms ? new Date(ms).toISOString() : null);

function formatTokenAtomic(amount: string | null, decimals: number, symbol: string): string | null {
  if (!amount || !/^\d+$/.test(amount)) return null;
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(amount);
  const whole = value / scale;
  const fraction = decimals ? (value % scale).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "") : "";
  return `${whole}${fraction ? `.${fraction}` : ""} ${symbol}`;
}

export async function handleStats(c: Context): Promise<Response> {
  const excluded = operatorWallets();
  const s = await getStats(excluded);
  const robinhood = config.paymentChain === "robinhood";
  const explorer = robinhood
    ? (config.isMainnet ? "https://robinhoodchain.blockscout.com/tx/" : "https://explorer.testnet.chain.robinhood.com/tx/")
    : (config.isMainnet ? "https://lora.algokit.io/mainnet/transaction/" : "https://lora.algokit.io/testnet/transaction/");
  const netMicro = s.grossMicro - s.rebatedMicro - s.refundedMicro;

  const f = robinhood ? null : await fetchFacilitatorStats();
  const fPaid = f?.settles ?? 0;
  const fGrossMicro = f ? usdToMicroCeil(f.volume) : 0;
  const fPayers = f?.payers ?? 0;

  const totalPaid = robinhood ? s.onchainPaidRequests : Math.max(s.paidRequests, fPaid);
  const totalCompleted = robinhood ? s.onchainCompletedRequests : Math.max(s.completedRequests, fPaid);
  const totalGrossMicro = robinhood ? s.onchainGrossMicro : Math.max(s.grossMicro, fGrossMicro);
  const totalNetMicro = robinhood
    ? Math.max(0, totalGrossMicro - s.refundedMicro)
    : Math.max(Math.max(0, netMicro), totalGrossMicro - s.rebatedMicro - s.refundedMicro);
  const totalPayers = Math.max(s.uniquePayers, fPayers);

  return c.json({
    payment_chain: config.paymentChain,
    payment_symbol: config.paymentAssetSymbol,
    network: config.isMainnet ? "mainnet" : "testnet",
    metrics: {
      paid_requests: totalPaid,
      completed_requests: totalCompleted,
      uncharged_failures: s.failedUncharged,
      refunded_requests: s.refundedRequests,
      paid_requests_24h: s.last24hRequests,
      reporting_currency: robinhood ? "USD quote" : "USDC",
      gross_usd_quote: microToUsdString(totalGrossMicro),
      rebated_usd_quote: microToUsdString(s.rebatedMicro),
      refunded_usd_quote: microToUsdString(s.refundedMicro),
      net_revenue_usd_quote: microToUsdString(totalNetMicro),
      pending_refund_reviews: robinhood ? s.manualRefundReviews : 0,
      ...(!robinhood ? {
        gross_usdc: microToUsdString(totalGrossMicro),
        rebated_usdc: microToUsdString(s.rebatedMicro),
        refunded_usdc: microToUsdString(s.refundedMicro),
        net_revenue_usdc: microToUsdString(totalNetMicro),
      } : {}),
      upstream_cost_usd: Number(s.upstreamCostUsd.toFixed(6)),
      unique_paying_wallets: totalPayers,
      repeat_paying_wallets: s.repeatPayers,
      repeat_payer_rate: totalPayers ? Number((s.repeatPayers / totalPayers).toFixed(4)) : 0,
      completed_by_modality: s.byModality,
      success_rate: robinhood
        ? (totalPaid ? Number((totalCompleted / totalPaid * 100).toFixed(2)) : null)
        : f ? Number((f.successRate * 100).toFixed(2)) : undefined,
      avg_settle_ms: robinhood
        ? (s.averageRequestToSettlementMs === null ? null : Math.round(s.averageRequestToSettlementMs))
        : f ? Math.round(f.avgSettleMs) : undefined,
      avg_ticket_usd: robinhood
        ? (totalPaid ? Number((totalGrossMicro / totalPaid / 1_000_000).toFixed(6)) : null)
        : f ? Number(f.avgTicket.toFixed(4)) : undefined,
      ...(robinhood ? {
        avg_ticket_usd_quote: totalPaid ? microToUsdString(Math.round(totalGrossMicro / totalPaid)) : null,
      } : {}),
    },
    facilitator: f
      ? {
          merchant_id: config.facilitatorMerchantId,
          dashboard_url: `https://facilitator.goplausible.xyz/dashboard/merchants/${config.facilitatorMerchantId}`,
          scope: config.isMainnet ? "mainnet" : "testnet",
          volume_usdc: Number(f.volume.toFixed(2)),
          settles: f.settles,
          success_rate: Number((f.successRate * 100).toFixed(2)),
          payers: f.payers,
          avg_ticket_usd: Number(f.avgTicket.toFixed(4)),
          avg_settle_ms: Math.round(f.avgSettleMs),
          first_settle_at: isoOrNull(f.firstSeen),
          last_settle_at: isoOrNull(f.lastSeen),
          listed: { bazaar: Boolean(f.bazaar), challenge: Boolean(f.challenge) },
          accounts: (f.accounts ?? []).map((a) => ({ network: a.network.name, testnet: a.network.testnet, address: a.address, status: a.status })),
          networks: (f.networks ?? []).map((n) => ({ name: n.name, slug: n.slug, testnet: n.testnet, settles: n.events, volume_usdc: Number(n.volume.toFixed(2)) })),
          endpoints: (f.resources ?? []).map((r) => ({
            ...describeResource(r.url),
            endpoint: r.url,
            method: r.method,
            settles: r.settles,
            volume_usdc: Number(r.volume.toFixed(2)),
            price_usdc: r.price,
          })),
        }
      : null,
    recent_settlements: s.recent.map((r) => ({
      request_id: r.id,
      model: r.model,
      modality: r.modality,
      amount: robinhood ? formatTokenAtomic(r.amount_atomic, config.paymentAssetDecimals, config.paymentAssetSymbol) : microToUsdString(r.amount_micro),
      amount_atomic: r.amount_atomic,
      asset: r.asset,
      amount_usd_quote: microToUsdString(r.amount_micro),
      txid: r.txid,
      explorer_url: r.txid ? `${explorer}${r.txid}` : null,
      at: r.settled_at ?? r.created_at,
    })),
    methodology: robinhood
      ? "Robinhood Chain paid volume and completion metrics use gateway ledger rows with an on-chain transaction hash. Average request-to-settlement includes upstream processing time. WIF amounts are token base units; USD figures are quote-time estimates, not mark-to-market values."
      : "Counted from the gateway ledger and cross-verified with the Algorand x402 facilitator. Every settled request carries its on-chain txid, verifiable on-chain.",
    timestamp: new Date().toISOString(),
  });
}

export async function handleGetJob(c: Context): Promise<Response> {
  const job = await getJob(c.req.param("id") ?? "");
  if (!job) return apiError(c, 404, "job_not_found", "No such job.");
  const request = await getRequest(job.request_id);
  const refund = job.status === "failed" ? await getRefundByRequest(job.request_id) : undefined;
  return c.json({
    id: job.id,
    object: "video.job",
    status: job.status,
    model: job.model_slug,
    video_url: job.status === "completed" ? (job.requires_proxy ? `${config.publicDomain}/v1/jobs/${job.id}/content` : job.video_url) : null,
    error: job.error,
    request_id: job.request_id,
    receipt_url: `${config.publicDomain}/v1/receipts/${job.request_id}`,
    refund: refund ? { status: refund.status, txid: refund.txid, amount: microToUsdString(refund.amount_micro) } : null,
    paid: request ? microToUsdString(request.amount_micro) : null,
    created_at: job.created_at,
    completed_at: job.completed_at,
  });
}

export async function handleJobContent(c: Context): Promise<Response> {
  const job = await getJob(c.req.param("id") ?? "");
  if (!job || job.status !== "completed") return apiError(c, 404, "job_not_ready", "Video is not ready.");
  if (!job.requires_proxy) return c.redirect(job.video_url!, 302);
  const model = defaultModelRegistry.getModel(job.model_slug);
  const provider = model && defaultProviderRegistry.getProvider(model.provider);
  if (!model || !provider?.fetchVideoContent) return apiError(c, 502, "upstream_error", "Video content unavailable.");
  const upstream = await provider.fetchVideoContent(model, job.upstream_job_id!);
  return new Response(upstream.body, {
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "video/mp4", "Cache-Control": "private, max-age=3600" },
  });
}

export async function handleGetReceipt(c: Context): Promise<Response> {
  const request = await getRequest(c.req.param("id") ?? "");
  if (!request) return apiError(c, 404, "receipt_not_found", "No such request.");
  const job = request.modality === "video" ? await getJobByRequest(request.id) : undefined;
  const refund = await getRefundByRequest(request.id);
  const receipt = request.receipt as SignedReceipt | null;
  return c.json({
    request_id: request.id,
    status: request.status,
    receipt,
    signature_valid: receipt ? receiptSigner.verify(receipt) : false,
    amount: microToUsdString(request.amount_micro),
    rebate: microToUsdString(request.rebate_micro),
    txid: request.txid,
    job: job ? { id: job.id, status: job.status } : null,
    refund: refund ? { status: refund.status, txid: refund.txid, amount: microToUsdString(refund.amount_micro) } : null,
    verify:
      "Check `sig` with the key from /.well-known/moltworld-receipts.json over the canonical JSON (sorted keys) of the receipt without `sig`; compare responseSha256 with sha256 of the response body bytes you received.",
  });
}

export function handleReceiptKeys(c: Context): Response {
  return c.json(
    {
      issuer: config.publicDomain,
      algorithm: "Ed25519",
      encoding: "publicKey is the raw 32-byte key, base64; signatures are base64url",
      canonicalization: "JSON with object keys sorted recursively, no whitespace, receipt without `sig`",
      keys: receiptSigner.publicKeys(),
      pay_to: config.payToAddress,
    },
    200,
    { "Cache-Control": "public, max-age=300" }
  );
}
