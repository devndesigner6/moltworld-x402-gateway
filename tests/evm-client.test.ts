import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { MoltworldClient } from "../sdk/js/src/index.js";

const NETWORK = "eip155:4663";
const ASSET = "0x5173b8eA6923c2d40267890D45C46a3480954773";
const PAY_TO = "0xdfF3eC4B06e39BCE04Ece791D2372C03b8AAC78a";
const QUOTE_ID = "wq_testQuote123456";
const QUOTED_USD_MICRO = 1_000;
const EFFECTIVE_PRICE_SCALED18 = 1_900_000_000_000_000n;
const AMOUNT_ATOMIC = ((BigInt(QUOTED_USD_MICRO) * 10n ** 30n + EFFECTIVE_PRICE_SCALED18 - 1n) / EFFECTIVE_PRICE_SCALED18).toString();

function paymentRequiredHeader() {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    error: "Payment required",
    resource: { url: "https://gateway.example/v1/models/test/chat/completions", mimeType: "application/json" },
    accepts: [{
      scheme: "exact",
      network: NETWORK,
      amount: AMOUNT_ATOMIC,
      asset: ASSET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      extra: {
        assetTransferMethod: "permit2",
        decimals: 18,
        symbol: "WIF",
        quotedUsdMicro: QUOTED_USD_MICRO,
        wifPriceUsdScaled18: EFFECTIVE_PRICE_SCALED18.toString(),
        wifSpotPriceUsd: "0.002",
        quoteId: QUOTE_ID,
        tag: "x402-global-challenge",
      },
    }],
  })).toString("base64");
}

describe("Robinhood EVM browser/client spend controls", () => {
  function budgetClient(reply: () => Response | Promise<Response>, allowance?: () => Promise<void>) {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    return new MoltworldClient({
      baseUrl: "https://gateway.example",
      evmSigner: { address: account.address, signTypedData: (data: any) => account.signTypedData(data) },
      budgetUsd: 0.001,
      ensureEvmAllowance: allowance,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/health")) return Response.json({ network_caip2: NETWORK, payment_asset: ASSET, pay_to: PAY_TO });
        if (request.headers.has("payment-signature")) return reply();
        return new Response("{}", { status: 402, headers: { "Payment-Required": paymentRequiredHeader() } });
      },
    });
  }

  it("releases a budget reservation when the gateway confirms an uncharged failure", async () => {
    let fails = true;
    const client = budgetClient(() => fails
      ? Response.json({ error: { code: "upstream_error", message: "No payment settled" } }, { status: 502, headers: { "Moltworld-Payment-Status": "uncharged" } })
      : Response.json({ ok: true }));
    await expect(client.chat("test", { messages: [{ role: "user", content: "first" }] })).rejects.toThrow("No payment settled");
    expect(client.spentUsd).toBe(0);
    fails = false;
    await expect(client.chat("test", { messages: [{ role: "user", content: "retry" }] })).resolves.toBeTruthy();
    expect(client.spentUsd).toBe(0.001);
  });

  it("reserves the budget before asynchronous wallet approval so concurrent calls cannot overspend", async () => {
    let release!: () => void;
    const approval = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const approving = new Promise<void>((resolve) => { entered = resolve; });
    const client = budgetClient(() => Response.json({ ok: true }), async () => { entered(); await approval; });
    const first = client.chat("test", { messages: [{ role: "user", content: "first" }] });
    await approving;
    const second = client.chat("test", { messages: [{ role: "user", content: "second" }] });
    // Observe its rejection immediately, before the first approval is released.
    const rejected = expect(second).rejects.toThrow(/budget/i);
    release();
    await first;
    await rejected;
    expect(client.spentUsd).toBe(0.001);
  });

  it("keeps a reservation when a signed request loses its connection and settlement is uncertain", async () => {
    const client = budgetClient(() => { throw new Error("connection lost"); });
    await expect(client.chat("test", { messages: [{ role: "user", content: "first" }] })).rejects.toThrow("connection lost");
    expect(client.spentUsd).toBe(0.001);
  });

  it("allows only the advertised WIF asset and keeps payment creation behind local caps", async () => {
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const signerCalls: unknown[] = [];
    const allowanceCalls: unknown[] = [];
    const events: string[] = [];
    const requestBodies: string[] = [];
    let signedAccepted: any;
    let paidEndpointCalls = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const url = request?.url ?? String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ network_caip2: NETWORK, payment_asset: ASSET, pay_to: PAY_TO }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/v1/models/test/chat/completions")) {
        paidEndpointCalls++;
        if (request) requestBodies.push(await request.clone().text());
        else requestBodies.push(String(init?.body ?? ""));
        const headers = new Headers(request?.headers);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        if (headers.has("payment-signature") || headers.has("x-payment")) {
          events.push("retry");
          signedAccepted = JSON.parse(Buffer.from(headers.get("payment-signature")!, "base64").toString("utf8")).accepted;
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "local fixture" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 402, headers: { "Payment-Required": paymentRequiredHeader() } });
      }
      throw new Error(`Unexpected mock request: ${url}`);
    };

    const client = new MoltworldClient({
      baseUrl: "https://gateway.example",
      evmSigner: {
        address: account.address,
        signTypedData: async (data: any) => {
          events.push("typed-data");
          signerCalls.push(data);
          return account.signTypedData(data);
        },
      } as any,
      maxPerRequestUsd: 0.25,
      expectedPayTo: PAY_TO,
      ensureEvmAllowance: async (payment) => { events.push("allowance"); allowanceCalls.push(payment); },
      fetch: mockFetch,
    });

    const result = await client.chat("test", { messages: [{ role: "user", content: "local test" }], max_tokens: 10 });

    expect(result.data.choices[0].message.content).toBe("local fixture");
    expect(paidEndpointCalls).toBe(2);
    expect(signerCalls.length).toBeGreaterThan(0);
    expect(allowanceCalls).toEqual([{ asset: ASSET, amount: AMOUNT_ATOMIC, network: NETWORK }]);
    expect(events).toEqual(["allowance", "typed-data", "retry"]);
    expect(requestBodies[0]).toBe(requestBodies[1]);
    expect(signedAccepted?.extra?.quoteId).toBe(QUOTE_ID);
    expect(String(signedAccepted?.amount)).toBe(AMOUNT_ATOMIC);
    expect(client.spentUsd).toBe(QUOTED_USD_MICRO / 1_000_000);
  });
});
