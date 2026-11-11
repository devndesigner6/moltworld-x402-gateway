import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware } from "@x402/hono";
import { createX402Server } from "./x402/server.js";
import {
  requestIdMiddleware,
  securityHeadersMiddleware,
  rateLimit,
  rateLimitFreeRoutesMiddleware,
  structuredLogger,
  safeErrorHandler,
} from "./middleware/security.js";
import { registerSite } from "./site/pages.js";
import { SITE_PATHS } from "./site/paths.js";
import { handleLlmsTxt, handleX402Discovery } from "./routes/metadata.js";
import { getAgentCard, handleA2a } from "./routes/a2a.js";
import { createMcpRoute } from "./routes/mcp.js";
import {
  handleGetJob,
  handleGetReceipt,
  handleHealth,
  handleJobContent,
  handleListModels,
  handleQuote,
  handleReceiptKeys,
  handleStats,
  warmFacilitatorStats,
  recordCatalogSync,
} from "./routes/public.js";
import { handleModelRequest } from "./routes/models.js";
import { handleMandateDraft, handleMandateGet, handleMandateList, handleMandateRegister, handleMandateRevoke } from "./routes/mandates.js";
import {
  handleCreatorEarnings,
  handleListingCreate,
  handleListingGet,
  handleMarketCall,
  handleMarketList,
  marketplaceEnabledMiddleware,
  prepareMarketRequest,
} from "./routes/market.js";
import {
  handleOpsListingReview,
  handleOpsListings,
  handleOpsPayouts,
  handleOpsWifPayoutPrepare,
  handleOpsWifPayoutConfirm,
  handleOpsRefundRetry,
  handleOpsRefunds,
  requireAdmin,
} from "./routes/ops.js";
import { apiError, commerceMiddleware, prepareModelRequest, setGatewayReady } from "./payments/gateway.js";
import { config } from "./config.js";
import { defaultModelRegistry } from "./models/registry.js";
import { syncCatalog } from "./models/sync.js";
import { getDatabase } from "./ledger/db.js";
import { getLogoBytes, getFaviconBytes, getFavicon32Bytes, getOgBytes } from "./assets/images.js";
import { LOGO_SVG } from "./site/brand.js";

function png(bytes: Uint8Array, type = "image/png") {
  return () =>
    new Response(bytes as unknown as BodyInit, {
      headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" },
    });
}

export function createApp(): { app: Hono; init: () => Promise<void> } {
  const app = new Hono();
  const { server, routes } = createX402Server();
  const handleMcp = createMcpRoute(async (request) => app.fetch(request));

  app.onError(safeErrorHandler);
  app.use("*", requestIdMiddleware);
  app.use("*", structuredLogger);
  app.use("*", securityHeadersMiddleware);
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "Payment-Signature", "X-Payment", "x-request-id"],
      exposeHeaders: [
        "Payment-Required",
        "Payment-Response",
        "Moltworld-Receipt",
        "Moltworld-Request-Id",
        "Moltworld-Quote",
        "Moltworld-Replay",
        "Moltworld-Refund",
        "Moltworld-Payment-Status",
        "x-request-id",
      ],
      maxAge: 86400,
    })
  );

  // Free endpoints
  for (const path of [...SITE_PATHS, "/health", "/v1/models", "/v1/quote", "/v1/stats", "/v1/jobs/*", "/v1/receipts/*", "/v1/mandates", "/v1/mandates/*", "/v1/market", "/v1/market/listings", "/v1/market/listings/*", "/v1/market/creators/*", "/.well-known/*", "/llms.txt", "/a2a", "/mcp"]) {
    app.use(path, rateLimitFreeRoutesMiddleware);
  }
  registerSite(app);
  app.get("/health", handleHealth);
  app.get("/v1/models", handleListModels);
  app.post("/v1/quote", handleQuote);
  app.get("/v1/stats", handleStats);
  app.get("/v1/jobs/:id", handleGetJob);
  app.get("/v1/jobs/:id/content", handleJobContent);
  app.get("/v1/receipts/:id", handleGetReceipt);
  app.get("/.well-known/moltworld-receipts.json", handleReceiptKeys);
  app.get("/llms.txt", handleLlmsTxt);
  app.get("/.well-known/x402", handleX402Discovery);
  app.get("/.well-known/agent-card.json", (c) => c.json(getAgentCard(), 200, { "Cache-Control": "public, max-age=300" }));
  app.post("/a2a", (c) => handleA2a(c.req.raw));
  app.all("/mcp", (c) => handleMcp(c.req.raw));

  const algorandOnly: MiddlewareHandler = async (c, next) => {
    if (config.paymentChain === "robinhood") return apiError(c, 503, "migration_incomplete", "This feature is still Algorand-specific and is disabled on the Robinhood WIF rail.");
    return next();
  };
  const mandateRail: MiddlewareHandler = (c, next) => c.req.method === "GET" ? next() : algorandOnly(c, next);
  app.use("/v1/mandates", mandateRail);
  app.use("/v1/mandates/*", mandateRail);
  app.use("/v1/ops/refunds", algorandOnly);
  app.use("/v1/ops/refunds/*", algorandOnly);

  // Legacy Algorand spending mandates remain disabled on the Robinhood payment rail.
  app.post("/v1/mandates/draft", handleMandateDraft);
  app.post("/v1/mandates", handleMandateRegister);
  app.get("/v1/mandates", handleMandateList);
  app.get("/v1/mandates/:id", handleMandateGet);
  app.post("/v1/mandates/:id/revoke", handleMandateRevoke);

  // Marketplace (free parts)
  app.use("/v1/market", marketplaceEnabledMiddleware);
  app.use("/v1/market/*", marketplaceEnabledMiddleware);
  app.get("/v1/market", handleMarketList);
  app.post("/v1/market/listings", handleListingCreate);
  app.post("/v1/market/listings/draft", handleListingCreate);
  app.get("/v1/market/listings/:slug", handleListingGet);
  app.get("/v1/market/creators/:address/earnings", handleCreatorEarnings);

  // Operator endpoints
  app.use("/v1/ops/*", requireAdmin);
  app.get("/v1/ops/refunds", handleOpsRefunds);
  app.post("/v1/ops/refunds/:id/retry", handleOpsRefundRetry);
  app.get("/v1/ops/payouts", handleOpsPayouts);
  app.post("/v1/ops/payouts/prepare", handleOpsWifPayoutPrepare);
  app.post("/v1/ops/payouts/:id/confirm", handleOpsWifPayoutConfirm);
  app.get("/v1/ops/listings", handleOpsListings);
  app.post("/v1/ops/listings/:id/review", handleOpsListingReview);

  app.get("/logo.png", png(getLogoBytes()));
  app.get("/apple-touch-icon.png", png(getLogoBytes()));
  app.get("/favicon.png", png(getFaviconBytes()));
  app.get("/favicon-32.png", png(getFavicon32Bytes()));
  app.get("/favicon.ico", png(getFavicon32Bytes(), "image/x-icon"));
  app.get("/og.png", png(getOgBytes()));
  app.get("/logo.svg", (c) => c.body(LOGO_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" }));

  // Paid endpoints. Completed payment replays are returned before quote expiry
  // checks; new calls still validate and quote before x402 can accept payment.
  app.use("/v1/models/:model/*", rateLimit("paid", 600));
  app.use("/v1/market/:slug/call", rateLimit("paid", 600));
  app.use("/v1/models/:model/*", commerceMiddleware);
  app.use("/v1/market/:slug/call", commerceMiddleware);
  app.use("/v1/models/:model/*", prepareModelRequest);
  app.use("/v1/market/:slug/call", prepareMarketRequest);
  app.use(paymentMiddleware(routes, server, undefined, undefined, false));
  app.post("/v1/models/:model/chat/completions", handleModelRequest);
  app.post("/v1/models/:model/images/generations", handleModelRequest);
  app.post("/v1/models/:model/audio/speech", handleModelRequest);
  app.post("/v1/models/:model/videos/generations", handleModelRequest);
  app.post("/v1/market/:slug/call", handleMarketCall);

  const init = async () => {
    await getDatabase();
    warmFacilitatorStats();
    const report = await syncCatalog(defaultModelRegistry);
    recordCatalogSync(report);
    if (Object.keys(report.unverified).length) {
      console.warn("Models withheld (upstream not verified):", report.unverified);
    }
    try {
      await server.initialize();
      setGatewayReady(true);
      console.log("x402 facilitator initialized. Gateway is READY.");
    } catch (err: any) {
      const msg = err?.message || String(err);
      setGatewayReady(false, msg);
      console.error("CRITICAL: x402 facilitator initialization failed. Gateway failing closed:", msg);
      throw err;
    }
  };

  return { app, init };
}

export const { app, init } = createApp();
