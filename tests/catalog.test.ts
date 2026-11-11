import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Harness, startHarness } from "./helpers/harness.js";
import { INITIAL_MODELS, ModelRegistry } from "../src/models/registry.js";
import { estimateInputTokens, microToUsdString, priceFromCost, quoteRequest } from "../src/pricing/index.js";
import { validateBody } from "../src/middleware/validation.js";
import { applyEnvCostOverride } from "../src/models/sync.js";
import { buildFalImageInput, buildFalVideoInput, pcm16ToWav } from "../src/providers/index.js";
import { isPublicAddress, validateCreatorUrl } from "../src/market/safeFetch.js";
import { canonicalJson, ReceiptSigner, verifyReceiptWithKey, publicKeyFromRaw } from "../src/receipts/index.js";

describe("catalog", () => {
  it("replaces the retired OpenAI image model with a separately named supported model", () => {
    const registry = new ModelRegistry();
    expect(registry.getModel("gpt-image-1")).toBeUndefined();
    expect(registry.getModel("gpt-image-1.5")).toMatchObject({ provider: "openai", upstreamModelId: "gpt-image-1.5", displayName: "GPT Image 1.5" });
  });
  it("names every model after the upstream that actually serves it", () => {
    expect(INITIAL_MODELS.some(m => m.provider === "fal")).toBe(false);
    expect(INITIAL_MODELS.some(m => m.modality === "video")).toBe(false);
    expect(INITIAL_MODELS.every((m) => !m.upstreamModelId.includes("openrouter/free"))).toBe(true);
  });

  it("has unique slugs and a cost basis matching each modality", () => {
    const slugs = INITIAL_MODELS.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const expected = { chat: "tokens", image: "per_image", voice: "per_1k_chars", video: "per_second" } as const;
    for (const m of INITIAL_MODELS) expect(m.cost.kind).toBe(expected[m.modality]);
  });

  it("withholds models whose upstream could not be verified", () => {
    const registry = new ModelRegistry();
    registry.markUnverified("gpt", "not listed");
    expect(registry.getEnabledModels().some((m) => m.slug === "gpt")).toBe(false);
    registry.clearUnverified("gpt");
    expect(registry.getEnabledModels().some((m) => m.slug === "gpt")).toBe(true);
  });
});

describe("pricing", () => {
  const gpt4o = INITIAL_MODELS.find((m) => m.slug === "gpt-4o")!;

  it("is cost plus margin, rounded up to the micro-USDC, with a floor", () => {
    expect(priceFromCost(0.01, 0.3).microUsdc).toBe(13_000);
    expect(priceFromCost(0.0000001, 0.3).microUsdc).toBe(1_000);
    expect(microToUsdString(1_234_500)).toBe("$1.2345");
    expect(microToUsdString(2_000_000)).toBe("$2");
  });

  it("counts UTF-8 bytes so CJK prompts are not under-quoted", () => {
    const ascii = estimateInputTokens([{ content: "a".repeat(300) }]);
    const cjk = estimateInputTokens([{ content: "語".repeat(300) }]);
    expect(cjk).toBeGreaterThan(ascii * 2.5);
  });

  it("charges the full max_tokens budget and is deterministic", () => {
    const req = { messages: [{ role: "user" as const, content: "hi" }], max_tokens: 1000 };
    const a = quoteRequest(gpt4o, req);
    const b = quoteRequest(gpt4o, req);
    expect(a).toEqual(b);
    const expectedCost = (estimateInputTokens(req.messages) * 2.5 + 1000 * 10) / 1e6;
    expect(a.upstreamCostUsd).toBeCloseTo(expectedCost, 5);
  });

  it("supports per-model env cost overrides", () => {
    const m = structuredClone(INITIAL_MODELS.find((x) => x.slug === "gpt-image-1.5")!);
    expect(applyEnvCostOverride(m, { COST_GPT_IMAGE_1_5: "0.09" } as any)).toBe(true);
    expect(m.cost).toEqual({ kind: "per_image", usd: 0.09 });
    expect(m.costSource).toBe("env-override");
  });
});

describe("validation", () => {
  const model = (slug: string) => INITIAL_MODELS.find((m) => m.slug === slug)!;

  it("always sets max_tokens so upstream usage is bounded by the quote", () => {
    const r = validateBody({ messages: [{ role: "user", content: "x" }] }, model("gpt"));
    expect(r.valid && (r.request as any).max_tokens).toBe(1024);
  });

  it("rejects streaming, bad roles, oversize max_tokens", () => {
    expect(validateBody({ messages: [{ role: "user", content: "x" }], stream: true }, model("gpt")).valid).toBe(false);
    expect(validateBody({ messages: [{ role: "tool", content: "x" }] }, model("gpt")).valid).toBe(false);
    expect(validateBody({ messages: [{ role: "user", content: "x" }], max_tokens: 99999 }, model("gpt")).valid).toBe(false);
  });

  it("enforces per-model image, voice and video specs", () => {
    expect(validateBody({ prompt: "x", n: 5 }, model("gpt-image-1.5")).valid).toBe(false);
    expect(validateBody({ prompt: "x", n: 2 }, model("gpt-image-1.5")).valid).toBe(true);
    expect(validateBody({ input: "x", response_format: "mp3" }, model("gpt-audio")).valid).toBe(false);
    expect(validateBody({ input: "x", voice: "robot" }, model("tts-1")).valid).toBe(false);
  });
});

describe("provider request mapping", () => {
  it("wraps streamed PCM16 audio in a valid WAV header", () => {
    const wav = pcm16ToWav(Buffer.alloc(4800));
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(40)).toBe(4800);
  });
});

describe("receipts", () => {
  it("canonicalizes key order and verifies only untampered receipts", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    const signer = new ReceiptSigner(Buffer.alloc(32, 7).toString("base64"));
    const receipt = signer.sign({
      id: "req_1",
      network: "n",
      asset: "a",
      payer: "P",
      payTo: "Q",
      amountMicro: 1000,
      txid: "T",
      resource: "/r",
      model: "gpt",
      upstreamProvider: "openrouter",
      upstreamModel: "openai/gpt-4o-mini",
      requestSha256: "aa",
      responseSha256: "bb",
      rebateMicro: 0,
    });
    expect(signer.verify(receipt)).toBe(true);
    expect(signer.verify({ ...receipt, amountMicro: 1 })).toBe(false);
    const key = signer.publicKeys()[0];
    expect(verifyReceiptWithKey(receipt, publicKeyFromRaw(Buffer.from(key.publicKey, "base64")))).toBe(true);
    // A persistent key gives a stable key id across restarts.
    expect(new ReceiptSigner(Buffer.alloc(32, 7).toString("base64")).kid).toBe(signer.kid);
  });
});

describe("marketplace SSRF guard", () => {
  it("only accepts public https hostnames", () => {
    expect(() => validateCreatorUrl("http://api.example.com")).toThrow();
    expect(() => validateCreatorUrl("https://10.0.0.1/x")).toThrow();
    expect(() => validateCreatorUrl("https://localhost/x")).toThrow();
    expect(() => validateCreatorUrl("https://api.example.com:8443/x")).toThrow();
    expect(validateCreatorUrl("https://api.example.com/v1").hostname).toBe("api.example.com");
  });

  it("classifies private, loopback, link-local and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicAddress(ip)).toBe(true);
  });
});

describe("catalog sync", () => {
  async function withOpenAI(run: (config: typeof import("../src/config.js").config, sync: typeof import("../src/models/sync.js").syncCatalog) => Promise<void>) {
    const { config } = await import("../src/config.js");
    const { syncCatalog } = await import("../src/models/sync.js");
    const previous = { skipUpstreamVerification: config.skipUpstreamVerification, openaiApiKey: config.openaiApiKey };
    config.skipUpstreamVerification = false;
    config.openaiApiKey = "test-openai-key";
    try { await run(config, syncCatalog); } finally { Object.assign(config, previous); }
  }

  it("authenticates OpenAI discovery and withholds account-inaccessible models", async () => withOpenAI(async (_config, sync) => {
    const registry = new ModelRegistry(INITIAL_MODELS.filter(m => ["gpt-image-1.5", "tts-1"].includes(m.slug)));
    let checked = false;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      if (url === "https://api.openai.com/v1/models") {
        checked = true;
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-openai-key");
        // Models are unavailable while the authenticated check is still in flight.
        expect(registry.getEnabledModels()).toHaveLength(0);
        return Response.json({ data: [{ id: "gpt-image-1.5", shutdown_date: "2999-01-01" }, { id: "tts-1", shutdown_date: "2020-01-01" }] });
      }
      return Response.json({ data: [], prices: [] });
    }) as typeof fetch;
    const report = await sync(registry, fakeFetch);
    expect(checked).toBe(true);
    expect(report.unverified).toEqual({ "tts-1": "tts-1" });
    expect(registry.getEnabledModels().map(m => m.slug)).toEqual(["gpt-image-1.5"]);
  }));

  it("fails closed on initial OpenAI discovery failure and recovers after a successful check", async () => withOpenAI(async (_config, sync) => {
    const registry = new ModelRegistry(INITIAL_MODELS.filter(m => m.slug === "gpt-image-1.5"));
    let available = false;
    const fakeFetch = (async (url: string) => url === "https://api.openai.com/v1/models"
      ? available ? Response.json({ data: [{ id: "gpt-image-1.5" }] }) : new Response("unavailable", { status: 503 })
      : Response.json({ data: [], prices: [] })) as typeof fetch;
    const report = await sync(registry, fakeFetch);
    expect(report.errors).toContain("OpenAI sync failed: OpenAI model list returned 503");
    expect(registry.getEnabledModels()).toHaveLength(0);
    available = true;
    await sync(registry, fakeFetch);
    expect(registry.getEnabledModels()).toHaveLength(1);
    available = false;
    await sync(registry, fakeFetch);
    expect(registry.getEnabledModels()).toHaveLength(1);
  }));

  it("does not query or advertise OpenAI models when its key is missing", async () => withOpenAI(async (config, sync) => {
    config.openaiApiKey = undefined;
    const registry = new ModelRegistry(INITIAL_MODELS.filter(m => m.slug === "gpt-image-1.5"));
    const fakeFetch = (async (url: string) => {
      expect(url).not.toContain("api.openai.com");
      return Response.json({ data: [], prices: [] });
    }) as typeof fetch;
    const report = await sync(registry, fakeFetch);
    expect(report.unverified).toEqual({ "gpt-image-1.5": "gpt-image-1.5" });
    expect(registry.getEnabledModels()).toHaveLength(0);
  }));

  it("disables OpenRouter models that are not listed and adopts live prices", async () => {
    process.env.SKIP_UPSTREAM_VERIFICATION = "false";
    const { syncCatalog } = await import("../src/models/sync.js");
    const { config } = await import("../src/config.js");
    const prev = config.skipUpstreamVerification;
    config.skipUpstreamVerification = false;
    const registry = new ModelRegistry(INITIAL_MODELS.filter((m) => ["gpt", "gpt-4o"].includes(m.slug)));
    const fakeFetch = (async (url: string) => {
      if (url.startsWith("https://openrouter.ai")) {
        return new Response(JSON.stringify({ data: [{ id: "openai/gpt-4o-mini", pricing: { prompt: "0.0000002", completion: "0.0000008" } }] }));
      }
      return new Response(JSON.stringify({ models: [{ endpoint_id: "fal-ai/flux-2-pro", metadata: { status: "active" } }] }));
    }) as typeof fetch;
    const report = await syncCatalog(registry, fakeFetch);
    config.skipUpstreamVerification = prev;
    expect(report.unverified).toEqual({ "gpt-4o": "openai/gpt-4o" });
    expect(registry.getEnabledModels().map((m) => m.slug).sort()).toEqual(["gpt"]);
    expect(registry.getModel("gpt")!.cost).toEqual({ kind: "tokens", inputPerMillionUsd: 0.2, outputPerMillionUsd: 0.8 });
  });
});

describe("public surfaces", () => {
  let harness: Harness;
  let app: any;
  beforeAll(async () => {
    harness = await startHarness();
    process.env.FACILITATOR_URL = harness.facilitatorUrl;
    process.env.ALGOD_URL = harness.algodUrl;
    // Pricing tests import config before the local facilitator is started.
    const { config } = await import("../src/config.js");
    config.facilitatorUrl = harness.facilitatorUrl;
    config.algodUrl = harness.algodUrl;
    const mod = await import("../src/application.js");
    app = mod.app;
    await mod.init();
  });
  afterAll(() => harness.close());

  const get = (path: string) => app.fetch(new Request(`http://localhost${path}`)) as Promise<Response>;

  it("reports health with ledger, receipt key and catalog status", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ledger).toBe("pglite");
    expect(body.receipts.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(body.enabled_models).toBe(INITIAL_MODELS.length);
    expect(JSON.stringify(body)).not.toMatch(/sk-|api[_-]?key/i);
  });

  it("lists models with from-prices, cost basis and flow", async () => {
    const body = await (await get("/v1/models?modality=video")).json();
    expect(body.data.length).toBe(0);
    for (const m of body.data) {
      expect(m.from_price).toMatch(/^\$\d/);
      expect(m.payment_flow).toBe("upfront");
      expect(m.durations.length).toBeGreaterThan(0);
    }
  });

  it("publishes discovery metadata that agents can act on", async () => {
    const llms = await (await get("/llms.txt")).text();
    expect(llms).toContain("/v1/quote");
    expect(llms).toContain("Moltworld-Receipt");
    const x402 = await (await get("/.well-known/x402")).json();
    expect(x402.resources.length).toBe(INITIAL_MODELS.length);
    expect(Number(x402.resources[0].amount)).toBeGreaterThan(0);
    const card = await (await get("/.well-known/agent-card.json")).json();
    expect(card.supportedInterfaces[0].url).toContain("/a2a");
  });

  it("answers A2A and MCP queries", async () => {
    const a2a = await app.fetch(
      new Request("http://localhost/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "cheapest chat model", mediaType: "text/plain" }] } } }),
      })
    );
    expect((await a2a.json()).result.message.parts[0].text).toContain("from $");

    const mcp = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Host: "localhost" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_payment_requirements", arguments: { model: "gpt", body: { messages: [{ role: "user", content: "hi" }] } } } }),
      })
    );
    const text = await mcp.text();
    const rpc = text.trimStart().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("data: ")[1].split("\n")[0]);
    const payload = JSON.parse(rpc.result.content[0].text);
    expect(payload.status).toBe(402);
    expect(payload.paymentRequired).toBeTruthy();
  });

  it("renders the landing page", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Moltworld");
  });
});
