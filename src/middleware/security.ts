import { Context, Next } from "hono";
import crypto from "crypto";
import { config } from "../config.js";
import { coordination } from "../payments/coordination.js";

// Request ID middleware
export async function requestIdMiddleware(c: Context, next: Next): Promise<void> {
  // Client-supplied ids are only echoed for log correlation (length-capped); ledger ids are server-generated.
  const supplied = c.req.header("x-request-id");
  const reqId = supplied && /^[\w.-]{1,64}$/.test(supplied) ? supplied : crypto.randomUUID();
  c.set("requestId", reqId);
  c.header("x-request-id", reqId);
  await next();
}

// Security & Cache-Control headers (Cloudflare compatibility)
export async function securityHeadersMiddleware(c: Context, next: Next): Promise<void> {
  await next();

  // Basic security headers
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");

  // Cloudflare caching rules:
  // All /v1/* endpoints MUST NOT be cached
  const path = c.req.path;
  if (path.startsWith("/v1/")) {
    c.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
  } else if (path === "/health") {
    c.header("Cache-Control", "public, max-age=5");
  }

  // Ensure x402 and receipt headers are exposed to CORS callers
  c.header(
    "Access-Control-Expose-Headers",
    "Payment-Required, Payment-Response, Moltworld-Receipt, Moltworld-Request-Id, Moltworld-Quote, Moltworld-Replay, Moltworld-Refund, Moltworld-Payment-Status, x-request-id"
  );
}

export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0].trim() || "direct";
}

/** Fixed-window rate limit per client IP, shared across processes when Redis is configured. */
export function rateLimit(bucket: string, max = config.rateLimitMaxRequests, windowMs = config.rateLimitWindowMs) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const result = await coordination.rateLimit(`${bucket}:${clientIp(c)}`, max, windowMs);
    if (!result.allowed) {
      c.header("Retry-After", String(Math.ceil(result.resetMs / 1000)));
      return c.json({ error: { code: "rate_limited", message: "Too many requests. Please slow down." } }, 429);
    }
    await next();
  };
}

export const rateLimitFreeRoutesMiddleware = rateLimit("free");

// Structured request logger
export async function structuredLogger(c: Context, next: Next): Promise<void> {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;

  const logEntry = {
    timestamp: new Date().toISOString(),
    requestId: c.get("requestId") || c.res.headers.get("x-request-id"),
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: duration,
    ip: clientIp(c),
  };

  // Skip noisy healthcheck logs in production if healthy
  if (c.req.path === "/health" && c.res.status === 200 && config.env === "production") {
    return;
  }

  console.log(JSON.stringify(logEntry));
}

// Global safe error handler
export function safeErrorHandler(err: Error, c: Context): Response {
  const reqId = c.get("requestId") || "unknown";
  console.error(
    JSON.stringify({
      level: "error",
      timestamp: new Date().toISOString(),
      requestId: reqId,
      message: err.message,
    })
  );

  let message = "An internal server error occurred.";
  if (config.env !== "production") {
    message = err.message;
  }

  return c.json(
    {
      error: {
        message,
        type: "server_error",
        request_id: reqId,
      },
    },
    500
  );
}
