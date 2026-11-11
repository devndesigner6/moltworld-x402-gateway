import { describe, expect, it } from "vitest";
import { discoveryProfile } from "../src/routes/metadata.js";
import { SITE_PATHS } from "../src/site/paths.js";

describe("Robinhood machine-readable discovery", () => {
  it("describes the live WIF chat-only EVM rail without a fake fixed amount", () => {
    const profile = discoveryProfile({
      paymentChain: "robinhood",
      networkCaip2: "eip155:4663",
      paymentAssetAddress: "0x5173b8eA6923c2d40267890D45C46a3480954773",
      paymentAssetSymbol: "WIF",
      paymentAssetDecimals: 18,
    });

    expect(profile.title).toContain("WIF");
    expect(profile.description).toContain("Robinhood Chain");
    expect(profile.description).toContain("EIP-1193");
    expect(profile.description).toContain("chat-only");
    expect(profile.payment).toMatchObject({
      scheme: "exact",
      network: "eip155:4663",
      asset: "0x5173b8eA6923c2d40267890D45C46a3480954773",
      assetSymbol: "WIF",
      assetDecimals: 18,
      tokenStandard: "ERC-20",
      permit2: true,
      supportedModalities: ["chat"],
    });
    expect(profile.payment.unsupportedFeatures).toEqual(expect.arrayContaining(["marketplace", "automatic refunds"]));
    expect(profile.payment.unsupportedFeatures).not.toContain("agent mandates");
  });

  it("keeps the legacy Algorand profile distinguishable", () => {
    const profile = discoveryProfile({
      paymentChain: "algorand",
      networkCaip2: "algorand:legacy",
      paymentAssetAddress: "10458941",
      paymentAssetSymbol: "USDC",
      paymentAssetDecimals: 6,
    });

    expect(profile.title).toContain("Legacy Algorand");
    expect(profile.payment.tokenStandard).toBe("Algorand ASA");
    expect(profile.payment.permit2).toBe(false);
  });

  it("advertises marketplace checkout only when explicitly enabled", () => {
    const previous = process.env.ROBINHOOD_MARKETPLACE_ENABLED;
    process.env.ROBINHOOD_MARKETPLACE_ENABLED = "true";
    try {
      const profile = discoveryProfile({ paymentChain: "robinhood", networkCaip2: "eip155:4663", paymentAssetAddress: "0x5173b8eA6923c2d40267890D45C46a3480954773", paymentAssetSymbol: "WIF", paymentAssetDecimals: 18 });
      expect(profile.description).toContain("reviewed creator APIs");
      expect(profile.description).toContain("live WIF payments");
      expect(profile.payment.unsupportedFeatures).not.toContain("marketplace");
    } finally {
      if (previous === undefined) delete process.env.ROBINHOOD_MARKETPLACE_ENABLED;
      else process.env.ROBINHOOD_MARKETPLACE_ENABLED = previous;
    }
  });

  it("declares the real HTML quickstart route", () => {
    expect(SITE_PATHS).toContain("/quickstart");
  });
});
