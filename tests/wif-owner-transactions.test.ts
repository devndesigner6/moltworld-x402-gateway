import { describe, expect, it } from "vitest";
import { waitForWifTransaction } from "../web/mandate.js";
import { isWifMandateRuntime } from "../src/payments/wif-mandate.js";
import { WIF_MANDATE_ARTIFACT } from "../sdk/js/src/wif-mandate-artifact.js";

describe("owner-authorized WIF transactions", () => {
  it("reports reverted transactions as failed rather than confirmed mandate changes", async () => {
    const client = { waitForTransactionReceipt: async () => ({ status: "reverted" }) } as any;
    await expect(waitForWifTransaction(client, `0x${"12".repeat(32)}`)).rejects.toThrow(/reverted/);
  });
  it("pins public mandate lookups to the compiled runtime", () => {
    expect(isWifMandateRuntime(WIF_MANDATE_ARTIFACT.runtimeTemplate)).toBe(true);
    expect(isWifMandateRuntime(`0x00${WIF_MANDATE_ARTIFACT.runtimeTemplate.slice(4)}`)).toBe(false);
    expect(isWifMandateRuntime("0x")).toBe(false);
  });
});
