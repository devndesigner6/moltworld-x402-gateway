import { describe, expect, it } from "vitest";
import { SITE_JS } from "../src/site/script.js";
import { WORLD_JS } from "../src/site/world.js";
import { FLOW_JS } from "../src/site/flow.js";
import { catalogWidget, payerWidget, quoteWidget } from "../src/site/widgets.js";
import { Hono } from "hono";
import { registerSite } from "../src/site/pages.js";
import { config } from "../src/config.js";
import { getAgentCard } from "../src/routes/a2a.js";

// The client scripts are strings served as-is, so a syntax slip only shows up in a browser.
describe("site scripts", () => {
  it("site.js parses", () => {
    expect(() => new Function(SITE_JS)).not.toThrow();
  });

  it("keeps paid answers separate from quote and 402 diagnostics", () => {
    const html = quoteWidget();
    expect(html).toContain('id="runOut"');
    expect(html).toContain('id="quoteOut"');
    expect(html.indexOf('id="runOut"')).toBeLessThan(html.indexOf('id="quoteOut"'));
    expect(SITE_JS).toContain('let quoteSeq = 0, runSeq = 0, debounce = 0;');
    expect(SITE_JS).toContain('showRunOutput(renderResult(m, result.data), renderReceipt(result));');
  });

  it("keeps sub-cent WIF ledger quotes visible and renders ledger-derived summary metrics", () => {
    expect(SITE_JS).toContain('const digits = Math.abs(num) >= 1 ? 2 : 6');
    expect(SITE_JS).toContain('set("sAvgTicket", fmtUsd(s.avg_ticket_usd_quote), true)');
    expect(SITE_JS).toContain('s.avg_settle_ms != null');
  });

  it("shows only live WIF models while retaining disabled modality filters", () => {
    const chatModel = {
      slug: "chat-model", name: "Chat model", modality: "chat", provider: "openrouter", vendor: "OpenRouter",
      upstream: "gpt-4o-mini", endpoint: "/v1/models/chat-model/chat/completions", from: "$0.001", flow: "authorization",
      maxOutput: 2048, maxImages: 1, sizes: null, durations: null, ratios: null, voices: null,
    } as any;
    const html = catalogWidget([chatModel], "robinhood");
    expect(html).toContain("Image (not live on WIF)");
    expect(html).toContain("Voice (not live on WIF)");
    expect(html).toContain("Video (not live on WIF)");
    expect(html).not.toContain('data-modality="image"');
    expect(html).not.toContain('data-modality="voice"');
  });

  it("shows a MetaMask-first connect action and the live mandate setup link", () => {
    const html = payerWidget("robinhood");
    expect(html).toContain('src="/assets/wallets/metamask.png"');
    expect(html).toContain('aria-label="Connect MetaMask"');
    expect(html).toContain('href="/products/mandates"');
    expect(html).toContain("Live WIF mandates");
    expect(SITE_JS).toContain("loadPay().catch(() => {});");
    expect(SITE_JS).toContain('await wallets.connect(metaMask.id);');
  });

  it("publishes WIF-safe A2A discovery metadata", () => {
    const previousChain = config.paymentChain;
    config.paymentChain = "robinhood";
    try {
      const card = getAgentCard();
      const serialized = JSON.stringify(card);
      expect(card.description).toContain("WIF payments on Robinhood Chain");
      expect(card.description).toContain("discovery-only");
      expect(serialized).not.toContain("Algorand");
      expect(serialized).not.toContain("USDC prices");
      expect(card.skills[0]?.description).toContain("exact body-specific WIF amount");
    } finally {
      config.paymentChain = previousChain;
    }
  });

  it("preserves the original homepage product and agent sections with truthful WIF status", async () => {
    const previousChain = config.paymentChain;
    const previousMainnet = config.isMainnet;
    config.paymentChain = "robinhood";
    config.isMainnet = true;
    try {
      const app = new Hono();
      registerSite(app);
      const html = await (await app.request("/")).text();
      for (const marker of [
        "Every AI model",
        "Three products.",
        "Gateway",
        "Mandates",
        "Marketplace",
        "Receipts",
        "Request to receipt",
        "Every chat model.",
        "Not enabled on WIF",
        "Built for software",
        "Remote and local MCP servers",
        "Live WIF mandates",
        "A2A agent card and llms.txt",
        "Every kind of agent.",
        "uc-grid",
        "Marketplace (disabled)",
      ]) expect(html).toContain(marker);
      expect(html).toContain("Image, voice, and video generation are not enabled");
      expect(html).toContain("The answer is generated first. WIF settlement completes before the response is returned.");
      const solutions = await (await app.request("/solutions")).text();
      expect(solutions).toContain("Agent allowances");
      const mandate = await (await app.request("/products/mandates")).text();
      expect(mandate).toContain("0x879e7e15f7b2cd4cd540f2e725ca3d3ce78ea552389588c6c95f539c35df43f3");
      expect(mandate).toContain("req_uPG_4T8Lt9AlG3qS");
      expect(mandate).toContain('data-field="risk-ack"');
      expect(mandate).toContain("independent security audit");
      expect(mandate).not.toContain("settlement has not yet been proven");
      expect(solutions).toContain("Content pipelines (not live on WIF)");
      expect(solutions).toContain("Agent commerce (disabled)");
      expect(solutions).toContain("Team budgets (not live on WIF)");
    } finally {
      config.paymentChain = previousChain;
      config.isMainnet = previousMainnet;
    }
  });

  it("renders the WIF stats sections from ledger aggregates without fabricated listings or model splits", async () => {
    const previousChain = config.paymentChain;
    const previousMainnet = config.isMainnet;
    config.paymentChain = "robinhood";
    config.isMainnet = true;
    try {
      const app = new Hono();
      registerSite(app);
      const html = await (await app.request("/stats")).text();
      expect(html).toContain('id="networkSettles"');
      expect(html).toContain('id="networkVolume"');
      expect(html).toContain('id="networkShare"');
      expect(html).toContain('id="topModelRows"');
      expect(html).toContain("per-model volume breakdown is not currently exposed");
      expect(html).toContain("Marketplace listings, creator balances, and payouts are disabled on WIF");
      expect(html).not.toContain('id="facilitatorOnly"');
    } finally {
      config.paymentChain = previousChain;
      config.isMainnet = previousMainnet;
    }
  });

  it("serves the local MetaMask logo as a PNG asset", async () => {
    const app = new Hono();
    registerSite(app);
    const response = await app.request("/assets/wallets/metamask.png");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()).slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("scene modules parse", () => {
    for (const source of [WORLD_JS, FLOW_JS]) {
      expect(() => new Function(source.replace(/^export /gm, ""))).not.toThrow();
    }
  });
});
