import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";

process.env.PAYMENT_CHAIN = "robinhood";
process.env.ROBINHOOD_NETWORK = "testnet";
process.env.WIF_TOKEN_ADDRESS = "0x5173b8eA6923c2d40267890D45C46a3480954773";
process.env.EVM_ADDRESS = "0x00000000000000000000000000000000000000aa";
process.env.ROBINHOOD_MARKETPLACE_ENABLED = "true";

const price = vi.hoisted(() => ({ value: "2000000000000000" }));
vi.mock("../src/pricing/wif.js", async (original) => ({
  ...await original<any>(),
  getWifPriceSnapshot: async () => ({ effectivePriceUsdScaled18: price.value, priceUsd: "0.002", source: "test", observedAt: new Date().toISOString(), liquidityUsd: 100000 }),
}));
const { prepareMarketRequest, handleListingCreate } = await import("../src/routes/market.js");
const { getPaymentState } = await import("../src/payments/state.js");
const { priceFromState, setGatewayReady } = await import("../src/payments/gateway.js");
const ledger = await import("../src/ledger/index.js");
const { resetDatabaseForTests } = await import("../src/ledger/db.js");
const { clearWifQuoteChallengesForTests } = await import("../src/payments/wif-challenges.js");
const { config } = await import("../src/config.js");
const { validateCreatorUrl } = await import("../src/market/safeFetch.js");

const app = new Hono();
app.post("/v1/market/listings", handleListingCreate);
app.post("/v1/market/listings/draft", handleListingCreate);
app.use("/v1/market/:slug/call", prepareMarketRequest);
app.post("/v1/market/:slug/call", c => {
  const state = getPaymentState(c)!;
  const accepted = { ...priceFromState({ adapter: { c } }), scheme: "exact", network: config.networkCaip2, payTo: config.payToAddress, maxTimeoutSeconds: 120 };
  accepted.extra = { ...accepted.extra, tag: "x402-global-challenge" } as any;
  if (c.req.header("payment-signature")) return c.json({ amount: state.amountAtomic });
  c.header("Payment-Required", Buffer.from(JSON.stringify({ accepts: [accepted] })).toString("base64"));
  return c.json({}, 402);
});
const call = (body: string, accepted?: any) => app.request("/v1/market/example-api/call", {
  method: "POST", body, headers: { "Content-Type": "application/json", ...(accepted ? { "Payment-Signature": Buffer.from(JSON.stringify({ accepted })).toString("base64") } : {}) },
});

beforeEach(async () => {
  await resetDatabaseForTests();
  clearWifQuoteChallengesForTests();
  price.value = "2000000000000000";
  setGatewayReady(true);
  await ledger.createListing({ id: "lst_example", slug: "example-api", name: "Example", description: "An approved example endpoint", creator: config.payToAddress, upstream_url: "https://creator.example/api", price_micro: 1000, input_example: null, signing_secret: "test", listing_nonce: "example" });
  await ledger.setListingStatus("lst_example", "approved");
});

describe("marketplace WIF checkout", () => {
  it("prepares a valid typed listing for a wallet to sign and registers only its valid signature", async () => {
    const owner = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const listing = { action: "list", creator: owner.address, slug: "signed-api", name: "Signed API", description: "An independently signed creator API", upstream_url: "https://creator.example/signed", price_usd: "0.001", input_example: { task: "review" }, nonce: "fresh-nonce", issued_at: Math.floor(Date.now() / 1000) };
    const draft = await app.request("/v1/market/listings/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ listing }) });
    expect(draft.status).toBe(200);
    const prepared = await draft.json();
    const signature = await owner.signTypedData(prepared.typed_data);
    const created = await app.request("/v1/market/listings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ listing: prepared.listing, creator_sig: signature }) });
    expect(created.status).toBe(201);
    expect((await created.json()).listing.status).toBe("pending");
  });
  it("retains the original amount after the live price changes", async () => {
    const first = await call('{"task":"review"}');
    const accepted = JSON.parse(Buffer.from(first.headers.get("payment-required")!, "base64").toString()).accepts[0];
    expect(accepted.extra.quoteId).toMatch(/^wq_/);
    price.value = "4000000000000000";
    const retry = await call('{"task":"review"}', accepted);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ amount: accepted.amount });
  });

  it("rejects a signed quote for a different body", async () => {
    const first = await call('{"task":"review"}');
    const accepted = JSON.parse(Buffer.from(first.headers.get("payment-required")!, "base64").toString()).accepts[0];
    const retry = await call('{"task":"different"}', accepted);
    expect(retry.status).toBe(409);
  });

  it("rejects IPv6 literal creator targets before attempting a connection", () => {
    expect(() => validateCreatorUrl("https://[::1]/")).toThrow(/hostname/);
    expect(() => validateCreatorUrl("https://[::ffff:127.0.0.1]/")).toThrow(/hostname/);
  });
});
