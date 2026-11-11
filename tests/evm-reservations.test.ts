import { describe, expect, it } from "vitest";
import { Hono } from "hono";

process.env.PAYMENT_CHAIN = "robinhood";
const { commerceMiddleware } = await import("../src/payments/gateway.js");
const { coordination } = await import("../src/payments/coordination.js");
const { setPaymentState } = await import("../src/payments/state.js");

describe("EVM payer reservations", () => {
  it("releases the lowercase reservation after the facilitator returns a checksum payer", async () => {
    const payer = "0x974d83f30f88D32ad0936934B326D4ca1b47c02A";
    const key = payer.toLowerCase();
    const app = new Hono();
    app.use("/task", commerceMiddleware);
    app.post("/task", async c => {
      if (!await coordination.reserve(key, 1000, 1000, 1)) return c.json({ error: "in flight" }, 402);
      expect(await coordination.reserve(key, 1000, 1000, 1)).toBe(false);
      setPaymentState(c, { requestId: "req_case_release", payer, reservedMicro: 1000, recorded: false } as any);
      return c.json({ ok: true });
    });
    for (let i = 0; i < 8; i++) {
      expect((await app.request("/task", { method: "POST" })).status).toBe(200);
      expect(await coordination.reserved(key)).toBe(0);
    }
  });
});
