import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

// Load this unit under the Robinhood test network so the EIP-712 domain has a
// numeric chain id. The production default remains disabled unless explicitly enabled.
process.env.PAYMENT_CHAIN = "robinhood";
process.env.ROBINHOOD_NETWORK = "testnet";
delete process.env.ROBINHOOD_MARKETPLACE_ENABLED;

const evm = await import("../src/payments/marketplace-evm.js");
const market = await import("../src/routes/market.js");
const ledger = await import("../src/ledger/index.js");
const db = await import("../src/ledger/db.js");
const { usdMicroToTokenAtomic } = await import("../src/pricing/wif.js");

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const PAY_TO = "0x00000000000000000000000000000000000000aa";
const listing = {
  action: "list" as const,
  creator: account.address,
  slug: "weather-api",
  name: "Weather API",
  description: "Returns current weather for a requested city.",
  upstream_url: "https://creator.example/weather",
  price_micro: 20_000,
  input_example: { city: "Lagos" },
  nonce: "nonce-001",
  issued_at: Math.floor(Date.now() / 1000),
};

beforeEach(async () => {
  await db.resetDatabaseForTests();
  delete process.env.ROBINHOOD_MARKETPLACE_ENABLED;
});

describe("WIF marketplace safeguards", () => {
  const creditAsset = { assetAddress: "0x5173b8eA6923c2d40267890D45C46a3480954773", assetSymbol: "WIF", assetDecimals: 18, network: "eip155:46630" };
  async function requestForCompletion() {
    await ledger.createRequest({ id: "req_atomic", paymentHash: "atomic-test", kind: "market", resource: "/v1/market/weather-api/call", payer: account.address, payTo: PAY_TO, network: creditAsset.network, asset: creditAsset.assetAddress, amountMicro: 1000, amountAtomic: "1000000000000000000", paymentFlow: "authorization", requestSha256: "0".repeat(64) });
    return { responseSha256: "1".repeat(64), responseStatus: 200, responseContentType: "application/json", responseBody: new Uint8Array([123, 125]), receipt: { id: "req_atomic" } };
  }

  it("rolls completion back when creator credit cannot be recorded", async () => {
    const completion = await requestForCompletion();
    await expect(ledger.completeRequest("req_atomic", completion, [{ account: account.address, kind: "creator", amountMicro: 850, amountAtomic: "invalid", asset: creditAsset }])).rejects.toThrow(/atomic amount/);
    expect((await ledger.getRequest("req_atomic"))?.status).toBe("verified");
  });

  it("records completion and exact creator credit together and makes retries idempotent", async () => {
    const completion = await requestForCompletion();
    const credits = [{ account: account.address, kind: "creator" as const, amountMicro: 850, amountAtomic: "850000000000000000", asset: creditAsset }];
    await ledger.completeRequest("req_atomic", completion, credits);
    await ledger.completeRequest("req_atomic", completion, credits);
    expect((await ledger.getRequest("req_atomic"))?.status).toBe("completed");
    expect((await ledger.creatorEarnings(account.address, creditAsset.assetAddress, creditAsset.network)).unpaidAtomic).toBe("850000000000000000");
  });

  it("batches concurrent credits once, retains old unpaid batches and rejects transfer reuse", async () => {
    await requestForCompletion();
    await ledger.addCredit(account.address, "creator", 850, "req_atomic", "850000000000000000", creditAsset);
    const batches = (await Promise.all([ledger.createPayoutsFromCredits("creator", 1, creditAsset), ledger.createPayoutsFromCredits("creator", 1, creditAsset)])).flat();
    expect(batches).toHaveLength(1);
    const first = batches[0];
    const query = await db.getDatabase();
    await query.query(`INSERT INTO mw_payouts (id, account, kind, amount_micro, amount_atomic, asset_address, asset_symbol, asset_decimals, network, status)
      SELECT 'newer_' || i, $1, 'creator', 1, '1', $2, 'WIF', 18, $3, 'sent' FROM generate_series(1, 1001) i`, [account.address, creditAsset.assetAddress, creditAsset.network]);
    expect((await ledger.listUnsentPayouts(creditAsset)).map(p => p.id)).toEqual([first.id]);
    const hash = `0x${"ab".repeat(32)}`;
    expect((await ledger.confirmWifPayout(first.id, hash)).status).toBe("sent");
    expect((await ledger.confirmWifPayout(first.id, hash.toUpperCase())).txid).toBe(hash);
    await expect(ledger.confirmWifPayout(first.id, `0x${"cd".repeat(32)}`)).rejects.toThrow(/different transaction/);
    await query.query(`INSERT INTO mw_payouts (id, account, kind, amount_micro, amount_atomic, asset_address, asset_symbol, asset_decimals, network, status)
      VALUES ('second', $1, 'creator', 1, '1', $2, 'WIF', 18, $3, 'pending')`, [account.address, creditAsset.assetAddress, creditAsset.network]);
    await expect(ledger.confirmWifPayout("second", hash)).rejects.toThrow();
    expect((await ledger.getPayout("second"))?.status).toBe("pending");
  });

  it("verifies the EIP-712 domain and configured chain, and rejects nonce or domain replay", async () => {
    const typed = evm.marketplaceListingTypedData(listing);
    const signature = await account.signTypedData(typed as any);
    expect(await evm.verifyCreatorListingSignature(listing, signature)).toBe(true);

    expect(await evm.verifyCreatorListingSignature({ ...listing, nonce: "nonce-002" }, signature)).toBe(false);
    const wrongDomainSignature = await account.signTypedData({
      ...typed,
      domain: { ...typed.domain, chainId: 1 },
    } as any);
    expect(await evm.verifyCreatorListingSignature(listing, wrongDomainSignature)).toBe(false);
  });

  it("binds the USD quote to an exact WIF base-unit amount and credits exact creator units", () => {
    expect(usdMicroToTokenAtomic(20_000, 2_000_000_000_000_000_000n, 18)).toBe("10000000000000000");
    expect(usdMicroToTokenAtomic(20_000, 3_000_000_000_000_000_000n, 18)).toBe("6666666666666667");
    expect(evm.creatorShareAtomic("10000000000000000", 15)).toBe("8500000000000000");
  });

  it("consumes a creator nonce at the ledger boundary and rejects replay", async () => {
    const common = {
      slug: "replay-safe",
      name: "Replay Safe",
      description: "A listing used to test nonce replay protection.",
      creator: listing.creator.toLowerCase(),
      upstream_url: listing.upstream_url,
      price_micro: listing.price_micro,
      input_example: null,
      signing_secret: "secret",
      listing_nonce: listing.nonce,
    };
    expect(await ledger.createListing({ id: "lst_first", ...common })).toBeTruthy();
    expect(await ledger.createListing({ id: "lst_replay", ...common })).toBeUndefined();
  });

  it("keeps creator credits and payout batches in exact WIF base units", async () => {
    const requestId = "req_wif_creator_credit";
    const network = "eip155:46630";
    const asset = "0x5173b8eA6923c2d40267890D45C46a3480954773";
    expect(await ledger.createRequest({
      id: requestId,
      paymentHash: "0x" + "ab".repeat(32),
      kind: "market",
      resource: "/v1/market/weather-api/call",
      listingId: "lst_weather",
      payer: listing.creator,
      payTo: PAY_TO,
      network,
      asset,
      amountMicro: 100_000,
      amountAtomic: "100000000000000000",
      paymentFlow: "authorization",
      requestSha256: "0".repeat(64),
    })).toBe(true);
    await ledger.addCredit(listing.creator.toLowerCase(), "creator", 85_000, requestId, "85000000000000000", {
      assetAddress: asset,
      assetSymbol: "WIF",
      assetDecimals: 18,
      network,
    });

    const legacyRequestId = "req_legacy_creator_credit";
    expect(await ledger.createRequest({
      id: legacyRequestId,
      paymentHash: "0x" + "cd".repeat(32),
      kind: "market",
      resource: "/v1/market/weather-api/call",
      listingId: "lst_legacy_weather",
      payer: listing.creator,
      payTo: PAY_TO,
      network: "algorand:mainnet",
      asset: "10458941",
      amountMicro: 10_000,
      amountAtomic: "10000",
      paymentFlow: "upfront",
      requestSha256: "1".repeat(64),
    })).toBe(true);
    await ledger.addCredit(listing.creator.toLowerCase(), "creator", 10_000, legacyRequestId);

    const earnings = await ledger.creatorEarnings(listing.creator.toLowerCase(), asset, network);
    expect(earnings.unpaidMicro).toBe(85_000);
    expect(earnings.unpaidAtomic).toBe("85000000000000000");
    const combinedLegacyEarnings = await ledger.creatorEarnings(listing.creator.toLowerCase(), asset, network, true);
    expect(combinedLegacyEarnings.unpaidMicro).toBe(95_000);
    const legacyPayouts = await ledger.createPayoutsFromCredits("creator", 5_000, {
      assetAddress: "10458941", assetSymbol: "USDC", assetDecimals: 6, network: "algorand:mainnet",
    }, true);
    expect(legacyPayouts).toHaveLength(1);
    const wifPayouts = await ledger.createPayoutsFromCredits("creator", 5_000, {
      assetAddress: asset, assetSymbol: "WIF", assetDecimals: 18, network,
    });
    expect(wifPayouts).toHaveLength(1);
    const wifPayout = wifPayouts[0];
    const legacyPayout = legacyPayouts[0];
    expect(wifPayout?.amount_atomic).toBe("85000000000000000");
    expect(legacyPayout?.amount_atomic).toBe("10000");
    const earningsAfterBatching = await ledger.creatorEarnings(listing.creator.toLowerCase(), asset, network);
    expect(earningsAfterBatching.unpaidMicro).toBe(85_000);

    const legacyWorkerBatch = await ledger.claimPendingPayouts(16, {
      assetAddress: "10458941", assetSymbol: "USDC", assetDecimals: 6, network: "algorand:mainnet",
    }, true);
    expect(legacyWorkerBatch).toHaveLength(1);
    expect(legacyWorkerBatch[0].asset_symbol).toBe("USDC");
    expect(legacyWorkerBatch[0].asset_address).toBe("");
    const wifWorkerBatch = await ledger.claimPendingPayouts(16, {
      assetAddress: asset, assetSymbol: "WIF", assetDecimals: 18, network,
    });
    expect(wifWorkerBatch).toHaveLength(1);
    expect(wifWorkerBatch[0].asset_symbol).toBe("WIF");
  });

  it("is disabled by default on Robinhood and only enables explicitly", () => {
    expect(market.robinhoodMarketplaceEnabled()).toBe(false);
    process.env.ROBINHOOD_MARKETPLACE_ENABLED = "true";
    expect(market.robinhoodMarketplaceEnabled()).toBe(true);
  });

  it("verifies exact WIF payouts and rejects a failed, young or wrong-recipient receipt", () => {
    const asset = creditAsset.assetAddress;
    const recipient = account.address;
    const transfer = {
      status: "success", blockNumber: 100n,
      logs: [{ address: asset, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + PAY_TO.slice(2).padStart(64, "0"), "0x" + recipient.slice(2).toLowerCase().padStart(64, "0")], data: "0x" + (850n).toString(16).padStart(64, "0") }],
    };
    const expected = { asset, sender: PAY_TO, recipient, amountAtomic: "850" };
    expect(() => evm.validateWifPayoutReceipt(transfer as any, 101n, expected)).not.toThrow();
    expect(() => evm.validateWifPayoutReceipt({ ...transfer, status: "reverted" } as any, 101n, expected)).toThrow(/failed/);
    expect(() => evm.validateWifPayoutReceipt(transfer as any, 100n, expected)).toThrow(/confirmations/);
    expect(() => evm.validateWifPayoutReceipt(transfer as any, 101n, { ...expected, recipient: PAY_TO })).toThrow(/transfer/);
    expect(() => evm.validateWifPayoutReceipt(transfer as any, 101n, { ...expected, amountAtomic: "851" })).toThrow(/transfer/);
  });
});
