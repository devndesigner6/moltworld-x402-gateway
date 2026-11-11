import type { Context, Hono } from "hono";
import { config, marketplaceEnabled } from "../config.js";
import { defaultModelRegistry } from "../models/registry.js";
import { quoteRequest, type ValidatedRequest } from "../pricing/index.js";
import { icon } from "./icons.js";
import { ASSET_NAMES, esc, handleAsset, renderPage, vercelPaymentPreviewDisabled } from "./layout.js";
import { agentTypes, PAYS_LABEL } from "./agents.js";
import { AUDIENCES, builtIn, PRODUCTS, WORKFLOWS } from "./nav.js";
import {
  catalog,
  CatalogEntry,
  catalogScript,
  catalogWidget,
  codeBlock,
  codeTabs,
  earningsWidget,
  logo,
  logoBand,
  mandateLookupWidget,
  marketWidget,
  MODALITY_LABEL,
  modelRails,
  payConfigScript,
  quoteWidget,
  receiptWidget,
  statsWidget,
  vendorName,
  vendors,
} from "./widgets.js";
import { mark } from "./brand.js";

const docs = () => config.docsUrl;
const network = () => config.paymentChain === "robinhood"
  ? `Robinhood Chain ${config.isMainnet ? "Mainnet" : "Testnet"}`
  : (config.isMainnet ? "Algorand Mainnet" : "Algorand Testnet");
const share = () => 100 - config.marketplaceFeePercent;
const margin = () => Math.round(config.priceMargin * 100);
/** Whether this deployment caps mandates on-chain; copy only claims it when it is true. */
const onChainCap = () => config.mandateCounterAppId !== null;
const MODALITIES = ["chat", "image", "voice"] as const;

/** Exact price of a request body for a model, or null when the model is not sold here. */
function quoteFor(slug: string, request: ValidatedRequest): string | null {
  const m = defaultModelRegistry.getModel(slug);
  if (!m || !catalog().some((c) => c.slug === slug)) return null;
  try {
    return quoteRequest(m, request).formattedPrice;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const btn = (href: string, label: string, kind: "primary" | "ghost" = "primary") =>
  `<a class="btn${kind === "ghost" ? " btn-ghost" : ""}" href="${esc(href)}" data-magnetic>${label}${kind === "primary" ? ` ${icon("arrow", 16)}` : ""}</a>`;

const arrowLink = (href: string, label: string) => `<a class="link-arrow" href="${esc(href)}">${label} ${icon("arrow", 16)}</a>`;

/** Section heading, with an optional action on the right instead of a subtitle. */
function secHead(title: string, action = ""): string {
  return `<div class="sec-head"><h2 data-split>${title}</h2>${action ? `<div data-reveal>${action}</div>` : ""}</div>`;
}

function pageHero(opts: { title: string; ctas?: string; visual?: string; crumbs?: Array<[string, string]> }): string {
  const crumbs = opts.crumbs
    ? `<nav class="crumbs" aria-label="Breadcrumb">${opts.crumbs.map(([l, h]) => `<a href="${esc(h)}">${esc(l)}</a>`).join(`<span aria-hidden="true">/</span>`)}</nav>`
    : "";
  return `
    <section class="page-hero">
      <div class="wrap page-hero-grid${opts.visual ? "" : " solo"}">
        <div>
          ${crumbs}
          <h1 data-split>${opts.title}</h1>
          ${opts.ctas ? `<div class="cta-row" data-reveal style="--d:3">${opts.ctas}</div>` : ""}
        </div>
        ${opts.visual ? `<div class="page-hero-visual" data-reveal style="--d:2">${opts.visual}</div>` : ""}
      </div>
    </section>`;
}

function sec(content: string, opts: { line?: boolean; id?: string } = {}): string {
  return `
    <section class="sec${opts.line === false ? "" : " line"}"${opts.id ? ` id="${opts.id}"` : ""}>
      <div class="wrap">${content}</div>
    </section>`;
}

function ctaFinal(title: string, ctas?: string): string {
  return `
    <section class="cta-final">
      <div class="orbit-deco" data-clip aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="wrap">
        <h2 data-split>${title}</h2>
        <div class="cta-row" data-reveal style="--d:2">${ctas ?? `${btn("/playground", "Open Playground")}${btn(`${docs()}/quickstart`, "Quickstart", "ghost")}`}</div>
      </div>
    </section>`;
}

/** Facts, each one sentence that stands on its own. */
function facts(items: Array<[string, string]>): string {
  return `<ul class="facts">${items.map(([ic, text], i) => `<li data-reveal style="--d:${i % 3}">${icon(ic, 22)}<span>${text}</span></li>`).join("")}</ul>`;
}

function linkCards(cards: Array<{ title: string; href: string; icon?: string }>, cols: 2 | 3 = 3): string {
  return `<div class="grid-${cols}">${cards
    .map(
      (c, i) =>
        `<a class="card link-card" href="${esc(c.href)}" data-reveal data-tilt style="--d:${i % 3}">${c.icon ? `<span class="card-ic">${icon(c.icon, 20)}</span>` : ""}<h3>${esc(c.title)}</h3><span class="go">${icon("arrow", 16)}</span></a>`
    )
    .join("")}</div>`;
}

const stepsList = (steps: string[]) => `<ol class="steps">${steps.map((t, i) => `<li style="--d:${i}"><strong>${t}</strong></li>`).join("")}</ol>`;

const PAYMENT_STEPS = [
  "Send a request. Get a 402 with its exact price.",
  "Sign one USDC transfer. No ALGO needed.",
  "Get the result. Failed media is refunded.",
  "Keep the signed receipt.",
];

function snippets(model = "gpt-4o") {
  const origin = config.publicDomain;
  return {
    mcp: config.paymentChain === "robinhood" ? `{
  "mcpServers": {
    "moltworld": {
      "type": "http",
      "url": "${origin}/mcp"
    }
  }
}

// Remote MCP lists models, quotes requests, and relays caller-signed chat.
// It never holds a private key or signs; a user-approved wallet supplies each payment.
// Agent mandates use a local session key. Marketplace calls require approved listings.
// This is configuration example text; it does not claim a completed call.
` : `{
  "mcpServers": {
    "moltworld": {
      "command": "npx",
      "args": ["-y", "-p", "moltworld-sdk", "moltworld-mcp"],
      "env": { "MOLTWORLD_MANDATE": "<credential>", "MOLTWORLD_BUDGET_USD": "5" }
    }
  }
}

// The agent now has moltworld_chat, moltworld_image, moltworld_speech,
// moltworld_quote, and pays within the mandate.`,
    claude: `claude mcp add -e MOLTWORLD_MANDATE=<credential> -e MOLTWORLD_BUDGET_USD=5 \\
  moltworld -- npx -y -p moltworld-sdk moltworld-mcp

# Discovery and quotes only, no wallet:
claude mcp add --transport http moltworld-remote ${origin}/mcp`,
    ts: config.paymentChain === "robinhood" ? `import { MoltworldClient } from "moltworld-sdk";

// Provide an EIP-1193/viem-compatible signer for Robinhood Chain.
const client = new MoltworldClient({
  baseUrl: "${origin}",
  evmSigner,
  maxPerRequestUsd: 0.25,
  budgetUsd: 5,
});
const res = await client.chat("${model}", {
  messages: [{ role: "user", content: "Summarize x402 in one line" }],
  max_tokens: 200,
});
console.log(res.data.choices[0].message.content);` : `import { MoltworldClient } from "moltworld-sdk";

const client = new MoltworldClient({
  mnemonic: process.env.ALGORAND_MNEMONIC,
  maxPerRequestUsd: 0.25, // never signs more than this
  budgetUsd: 5,           // total for this client
});

const res = await client.chat("${model}", {
  messages: [{ role: "user", content: "Summarize x402 in one line" }],
  max_tokens: 200,
});

console.log(res.data.choices[0].message.content);
console.log(res.receipt?.txid, res.verification?.ok);`,
    py: config.paymentChain === "robinhood" ? `import json
from urllib.request import Request, urlopen

payload = {
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hi"}],
    "max_tokens": 200,
}
request = Request(
    "${origin}/v1/quote",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
)
with urlopen(request) as response:
    print(json.load(response))

# This is a free quote. A paid chat call needs a caller-authorized wallet signature.
` : `from moltworld import MoltworldClient

client = MoltworldClient(mnemonic="...", max_per_request_usd=0.25, budget_usd=5)
res = client.chat("${model}", [{"role": "user", "content": "Summarize x402 in one line"}], max_tokens=200)

print(res.data["choices"][0]["message"]["content"])
print(res.receipt["txid"], res.verified)`,
    curl: `# Exact price, free
curl -s ${origin}/v1/quote -H 'Content-Type: application/json' \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"Hi"}],"max_tokens":200}'

# The same body without payment returns 402 + Payment-Required.
# Retry with a Payment-Signature header from ${config.paymentChain === "robinhood" ? "an x402 EVM client for Robinhood Chain" : "any x402 client that supports Algorand"}.
curl -si ${origin}/v1/models/${model}/chat/completions \\
  -H 'Content-Type: application/json' \\
  -d '{"messages":[{"role":"user","content":"Hi"}],"max_tokens":200}'`,
  };
}

// ---------------------------------------------------------------------------
// Product demos (animated by site.js)
// ---------------------------------------------------------------------------

function termDemo(models: CatalogEntry[]): string {
  const m = models.find((x) => x.slug === "gpt-4o") ?? models.find((x) => x.modality === "chat") ?? models[0];
  const slug = m?.slug ?? "gpt-4o";
  if (config.paymentChain === "robinhood") return `<div class="term" data-term aria-label="Illustrative WIF checkout flow; no request is sent">
      <div class="term-bar" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="term-body"><span class="l t-cmd" data-wait="200">Preview only &middot; no request is sent</span><span class="l t-cmd" data-wait="300">POST /v1/models/${esc(slug)}/chat/completions</span><span class="l t-402">&larr; 402 &middot; exact WIF amount comes from the live quote</span><span class="l t-cmd" data-wait="900">caller authorizes Payment-Signature</span><span class="l t-ok">200 OK &middot; response after successful paid call</span><span class="l t-ok">signed receipt accompanies completed response</span><span class="l" data-wait="200"><span class="caret"></span></span></div>
    </div>`;
  const price = m?.from ?? "$0.003";
  return `<div class="term" data-term>
      <div class="term-bar" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="term-body"><span class="l t-cmd" data-wait="300">POST /v1/models/${esc(slug)}/chat/completions</span><span class="l t-402">&larr; 402 Payment Required &middot; ${esc(price)} USDC</span><span class="l t-cmd" data-wait="900">retry with Payment-Signature</span><span class="l t-ok">&larr; 200 OK &middot; settled on Algorand</span><span class="l t-ok">&larr; Moltworld-Receipt &check;</span><span class="l" data-wait="200"><span class="caret"></span></span></div>
    </div>`;
}

function meterDemo(): string {
  if (config.paymentChain === "robinhood") return `<div class="meter" data-reveal aria-label="WIF mandate policy preview; connect a wallet to inspect your mandate">
      <div class="meter-top"><span>Live mandates &middot; wallet not connected</span><b>&mdash;</b></div>
      <div class="meter-bar">${"<i></i>".repeat(20)}</div>
      <div class="limits"><span class="limit">per call <b>owner-set</b></span><span class="limit">total cap <b>finite</b></span><span class="limit">expiry <b>owner-set</b></span></div>
      <div class="meter-actions"><button class="switch" type="button" role="switch" aria-checked="false" aria-label="No active mandate" disabled></button><span>not active</span></div>
    </div>`;
  return `<div class="meter" data-meter data-reveal data-cap="5">
      <div class="meter-top"><span>Spent today</span><b data-spent>$0.00</b></div>
      <div class="meter-bar">${"<i></i>".repeat(20)}</div>
      <div class="limits"><span class="limit">per call <b>$0.25</b></span><span class="limit">daily cap <b>$5.00</b></span><span class="limit">expires <b>30 days</b></span></div>
      <div class="meter-actions"><button class="switch" type="button" role="switch" aria-checked="true" aria-label="Mandate active"></button><span data-state>active</span></div>
    </div>`;
}

function splitDemo(): string {
  const s = share();
  const dash = ((2 * Math.PI * 58 * s) / 100).toFixed(1);
  if (config.paymentChain === "robinhood" && !marketplaceEnabled()) return `<div class="split-wrap" data-reveal aria-label="Marketplace is disabled on Robinhood Chain; no creator split or payout is live">
      <svg class="split-ring" viewBox="0 0 150 150" role="img" aria-label="Marketplace off; no live earnings"><circle class="bg" cx="75" cy="75" r="58"/><text x="75" y="84" text-anchor="middle">OFF</text></svg>
      <div class="split-legend"><span><i></i>Creator payouts</span><span><i class="o"></i>Disabled on WIF</span></div>
    </div>`;
  return `<div class="split-wrap" data-reveal>
      <svg class="split-ring" viewBox="0 0 150 150" role="img" aria-label="${s}% of each sale goes to the API seller"><circle class="bg" cx="75" cy="75" r="58"/><circle class="fg" cx="75" cy="75" r="58" style="--dash:${dash}"/><text x="75" y="84" text-anchor="middle">${s}%</text></svg>
      <div class="split-legend"><span><i></i>You</span><span><i class="o"></i>Moltworld, ${config.marketplaceFeePercent}%</span></div>
    </div>`;
}

function receiptDemo(): string {
  if (config.paymentChain === "robinhood") return `<div class="rcpt" data-reveal aria-label="Receipt format preview; not a real receipt">
      <div class="rcpt-row"><span>network</span><span>Robinhood Chain</span></div>
      <div class="rcpt-row"><span>asset</span><span>WIF</span></div>
      <div class="rcpt-row"><span>amountAtomic</span><span>per completed payment</span></div>
      <div class="rcpt-row"><span>txid</span><span>recorded after settlement</span></div>
      <div class="rcpt-row"><span>hashes &amp; signature</span><span>generated per real response</span></div>
      <span class="stamp">${icon("receipt", 14)} format preview &middot; not a receipt</span>
    </div>`;
  return `<div class="rcpt" data-receipt data-reveal>
      <div class="rcpt-row"><span>model</span><span>illustrative chat</span></div>
      <div class="rcpt-row"><span>asset</span><span>USDC / Algorand</span></div>
      <div class="rcpt-row"><span>requestSha256</span><span>example digest</span></div>
      <div class="rcpt-row"><span>responseSha256</span><span>example digest</span></div>
      <div class="rcpt-row"><span>sig</span><span>example signature</span></div>
      <span class="stamp">${icon("check", 14)} illustrative</span>
    </div>`;
}

function chatDemo(models: CatalogEntry[]): string {
  if (config.paymentChain === "robinhood") {
    const model = models.find((m) => m.modality === "chat");
    const slug = model?.slug ?? "configured-chat-model";
    return `<div class="chat" data-chat data-reveal aria-label="Illustrative WIF chat flow; no model call or payment is made">
    <div class="chat-head">Flow preview &middot; no request sent</div>
    <div class="msg user" data-step data-wait="300">Explain x402 payments in one sentence.</div>
    <div class="tool" data-step><span class="fn">moltworld_quote</span>({ model: "${esc(slug)}", body: { messages: [...] } })<br>&rarr; live quote is body-specific; none is fetched in this preview</div>
    <div class="tool" data-step data-wait="900">wallet authorization &middot; user reviews and approves the exact 402</div>
    <div class="tool" data-step data-wait="1100">signed receipt &middot; returned only after a successful paid request</div>
    <div class="msg bot" data-step>Open the Playground for a real call. This card did not call AI or move WIF.</div>
    <div class="typing hidden" aria-hidden="true"><i></i><i></i><i></i></div>
  </div>`;
  }
  const model = models.find(m => m.modality === "image");
  const slug = model?.slug ?? "gpt-image-1.5";
  const price = quoteFor(slug, { prompt: "Product hero photograph", n: 1 } as ValidatedRequest) ?? model?.from ?? "unavailable";
  return `<div class="chat" data-chat data-reveal>
    <div class="chat-head">Example session</div>
    <div class="msg user" data-step data-wait="300">Make a product hero photo for tomorrow's launch.</div>
    <div class="tool" data-step><span class="fn">moltworld_quote</span>({ model: "${esc(slug)}", body: { prompt: "Product hero photograph" } })<br>&rarr; ${esc(price)} USDC</div>
    <div class="tool" data-step data-wait="900"><span class="fn">moltworld_image</span>({ model: "${esc(slug)}", prompt: "&hellip;" })<br>&rarr; <span class="ok">paid</span> &middot; image generated</div>
    <div class="tool" data-step data-wait="1100">receipt &middot; <span class="ok">signature valid</span> &middot; ${esc(network())}</div>
    <div class="msg bot" data-step>Done for ${esc(price)}. Image and receipt attached.</div>
    <div class="typing hidden" aria-hidden="true"><i></i><i></i><i></i></div>
  </div>`;
}

const WORLD_FALLBACK = `<svg viewBox="0 0 400 400" aria-hidden="true" fill="none" stroke="currentColor" style="color:var(--line-2)"><circle cx="200" cy="200" r="150"/><ellipse cx="200" cy="200" rx="60" ry="150"/><ellipse cx="200" cy="200" rx="115" ry="150"/><path d="M50 200h300M70 125h260M70 275h260"/><ellipse cx="200" cy="200" rx="190" ry="54" transform="rotate(-18 200 200)" stroke-dasharray="3 6"/><circle cx="352" cy="148" r="6" fill="var(--signal)" stroke="none"/></svg>`;

function flowBand(): string {
  const left = Array.from({ length: 9 }, (_, i) => { const y = 30 + i * 42.5; return `<path class="in" d="M0 ${y} C 260 ${y}, 360 200, 500 200"/>`; }).join("");
  const lanes = [70, 155, 245, 330];
  const right = lanes.map((y, i) => `<path class="out o${i}" d="M500 200 C 640 200, 700 ${y}, 1000 ${y}"/>`).join("");
  return `<div class="flow" data-reveal>
      <svg class="flow-fallback" viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">${left}${right}</svg>
      <canvas id="flow" role="img" aria-label="Requests pass through the x402 gate and fan out to chat, image and voice models"></canvas>
      <span class="flow-gate" aria-hidden="true"></span>
      <span class="flow-label c" aria-hidden="true">x402</span>
      <div class="flow-lanes" aria-hidden="true">${(["voice", "image", "chat"] as const)
        .map((k, i) => `<span style="top:${(18.5 + i * 21).toFixed(1)}%">${MODALITY_LABEL[k]}<i style="background:var(--${k})"></i></span>`)
        .join("")}</div>
    </div>`;
}

function robinhoodFlowBand(): string {
  const left = Array.from({ length: 9 }, (_, i) => { const y = 30 + i * 42.5; return `<path class="in" d="M0 ${y} C 260 ${y}, 360 200, 500 200"/>`; }).join("");
  const right = `<path class="out o2" d="M500 200 C 640 200, 700 200, 1000 200"/>`;
    return `<div class="flow" data-reveal>
      <svg class="flow-fallback" viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">${left}${right}</svg>
      <canvas id="flow" role="img" aria-label="Illustrative requests pass through the x402 gate to chat on Robinhood Chain"></canvas>
      <span class="flow-gate" aria-hidden="true"></span>
      <span class="flow-label c" aria-hidden="true">x402</span>
      <div class="flow-lanes" aria-hidden="true"><span style="top:50%">Chat<i style="background:var(--chat)"></i></span></div>
  </div>`;
}

function wifModalityRow(models: CatalogEntry[]): string {
  const cards = MODALITIES.map((key, i) => {
    const available = models.filter((model) => model.modality === key);
    const heading = `<div class="k"><i></i>${MODALITY_LABEL[key]}</div>`;
    const bars = `<div class="bars" aria-hidden="true">${[0, 1, 2, 3].map((j) => `<b style="--j:${j + i}"></b>`).join("")}</div>`;
    if (available.length) return `<a class="mod dot-${key}" href="/models?type=${key}" data-reveal style="--d:${i}">${heading}<div class="lab-stack">${vendors(available).slice(0, 4).map((v) => `<span title="${esc(vendorName(v))}">${logo(v)}</span>`).join("")}</div>${bars}</a>`;
    return `<div class="mod dot-${key} disabled" data-reveal style="--d:${i}" role="img" aria-disabled="true" aria-label="${MODALITY_LABEL[key]} models are not enabled on WIF">${heading}<div class="lab-stack"></div><div class="mod-status">Not enabled on WIF</div>${bars}</div>`;
  }).join("");
  return `<div class="mod-row">${cards}</div>`;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function home(c: Context) {
  const models = catalog();
  if (config.paymentChain === "robinhood") {
    const chatModels = models.filter((model) => model.modality === "chat");
    const s = snippets();
    const body = `
      <section class="hero">
        <div class="wrap hero-grid">
          <div class="hero-copy">
            <h1 data-split>Every AI model, <em>paid per request.</em></h1>
            <div class="cta-row" data-reveal style="--d:4">${btn("/playground", "Open Playground")}<span class="cmd"><b>npm i moltworld-sdk</b><button type="button" class="icon-btn" data-copy="npm i moltworld-sdk" aria-label="Copy install command">${icon("copy", 15)}</button></span></div>
          </div>
          <div class="hero-visual" data-clip><div class="world-fallback">${WORLD_FALLBACK}</div><canvas id="world" role="img" aria-label="Globe of payments settling between agents and models. Drag to spin, tap to send a request."></canvas></div>
        </div>
      </section>
      ${logoBand(chatModels)}
      ${sec(`${secHead("AI is sold by the seat. <em>Agents don't have seats.</em>")}
        <ul class="problems"><li data-reveal>Whoever holds a key spends the account.</li><li data-reveal style="--d:1">Credits and plans are prepaid to the provider.</li><li data-reveal style="--d:2">Dashboards can't prove what ran.</li></ul>
        <p class="answer" data-reveal>Moltworld prices every request with HTTP 402. <em>Compatible wallets can pay in WIF on Robinhood Chain.</em></p>`)}
      ${sec(`${secHead("Three products. <em>Proof on every call.</em>", arrowLink("/products", "All products"))}
        <div class="bento">
          <a class="tile wide" href="/products/gateway" data-reveal><div class="tile-head"><h3>Gateway</h3><span class="go">${icon("arrow", 16)}</span></div><div class="tile-visual">${termDemo(chatModels)}</div></a>
          <a class="tile narrow" href="/products/mandates" data-reveal style="--d:1"><div class="tile-head"><h3>Mandates</h3><span class="go">${icon("arrow", 16)}</span></div><div class="tile-visual">${meterDemo()}</div></a>
          <a class="tile narrow" href="/products/marketplace" data-reveal><div class="tile-head"><h3>Marketplace</h3><span class="go">${icon("arrow", 16)}</span></div><div class="tile-visual">${splitDemo()}</div></a>
          <a class="tile wide" href="/products/receipts" data-reveal style="--d:1"><div class="tile-head"><h3>Receipts</h3><span class="go">${icon("arrow", 16)}</span></div><div class="tile-visual">${receiptDemo()}</div></a>
        </div>`)}
      ${sec(`${secHead("Request to receipt <em>in one round trip.</em>")}
        ${robinhoodFlowBand()}
        ${stepsList(["Send a chat request and receive its exact quote.", "Authorize the quoted WIF payment on Robinhood Chain; first use can require Permit2 approval and native ETH for gas.", "The answer is generated first. WIF settlement completes before the response is returned.", "Keep or verify the signed receipt."])}`)}
      ${sec(`${secHead("Every chat model. <em>Priced per call.</em>", arrowLink("/models", "Chat models"))}${wifModalityRow(chatModels)}`)}
      <div class="rails-band">${modelRails(chatModels)}</div>
      ${sec(`<div class="agent-grid"><div><h2 data-split>Built for software <em>that spends money.</em></h2><ul class="feature-list" data-reveal><li>${icon("plug", 20)}<b>Remote and local MCP servers</b></li><li>${icon("mandate", 20)}<b>Live WIF mandates with verified mainnet settlement</b></li><li>${icon("globe", 20)}<b>A2A agent card and llms.txt</b></li></ul><div class="cta-row" data-reveal>${btn("/solutions/agents", "Connect your agent")}${btn(`${docs()}/agents/mcp`, "MCP docs", "ghost")}</div></div>${chatDemo(chatModels)}</div>`)}
      ${sec(`<div class="dev-grid"><div><h2 data-split>One config for agents. <em>A few lines for apps.</em></h2><div class="sdk-list" data-reveal><a class="sdk" href="${docs()}/agents/mcp">${icon("plug", 20)}<b>MCP server</b>${icon("arrow", 16)}</a><a class="sdk" href="${docs()}/sdks/typescript">${icon("package", 20)}<b>TypeScript SDK</b>${icon("arrow", 16)}</a><a class="sdk" href="${docs()}/sdks/python">${icon("package", 20)}<b>Python SDK</b>${icon("arrow", 16)}</a><a class="sdk" href="${docs()}/api-reference/introduction">${icon("braces", 20)}<b>HTTP API / curl</b>${icon("arrow", 16)}</a></div></div><div data-reveal style="--d:2">${codeTabs("hero", [["mcp", "MCP", s.mcp, "json"], ["ts", "TypeScript", s.ts], ["py", "Python", s.py], ["curl", "curl", s.curl, "sh"]])}</div></div>`)}
      ${sec(`${secHead("A wallet <em>instead of an account.</em>")}<div class="compare" data-reveal role="table" aria-label="Moltworld on Robinhood Chain compared with API keys and plans"><div class="compare-row head" role="row"><div role="columnheader"></div><div class="us" role="columnheader">Moltworld on Robinhood</div><div role="columnheader">API keys and plans</div></div>${[["Sign-up", "No account; connect an EVM wallet", "An account per provider"], ["Your money", "In your wallet until a WIF request settles", "Prepaid to the provider, or billed later"], ["Per-call spend", "Exact quote and WIF amount", "Provider-side limits"], ["A leaked credential", "A payment still needs wallet authorization", "May spend up to the key's limit"], ["Failed chat request", "Payment is not settled before a response", "Depends on the provider"], ["Proof of each call", "Signed receipt and on-chain settlement", "Usage logs"], ["Mandates and marketplace", "Not enabled on this payment rail", "Build billing yourself"]].map(([k, us, them]) => `<div class="compare-row" role="row"><div role="rowheader">${k}</div><div class="us" role="cell">${icon("check", 16)}${us}</div><div role="cell">${them}</div></div>`).join("")}</div>`)}
      ${sec(`${secHead("Every payment <em>has on-chain proof.</em>", arrowLink("/stats", "Live network"))}${statsWidget()}<p class="note" data-reveal>Stats are loaded from the gateway ledger. USD figures are quote-time estimates, not mark-to-market WIF totals.</p>`)}
      ${sec(`${secHead("Every kind of agent. <em>One chat payment path.</em>", arrowLink("/use-cases", "All use cases"))}<p class="note" data-reveal>These agent categories can use the live WIF chat endpoint. Image, voice, and video generation are not enabled on this payment rail.</p><div class="uc-grid" data-reveal>${agentTypes().map(agentCard).join("")}</div>`)}
      ${sec(robinhoodFaq())}
      ${ctaFinal("Stop managing keys. <em>Pay per call.</em>")}`;
    return renderPage(c, { path: "/", title: "Moltworld | Every AI model, paid per request", description: "The pay-per-request chat gateway for AI. Eligible chat models are paid in WIF on Robinhood Chain through x402, with exact quotes and signed receipts.", body, data: catalogScript(chatModels) });
  }
  const s = snippets();
  const body = `
    <section class="hero">
      <div class="wrap hero-grid">
        <div class="hero-copy">
          <h1 data-split>Every AI model, <em>paid per request.</em></h1>
          <div class="cta-row" data-reveal style="--d:4">
            ${btn("/playground", "Open Playground")}
            <span class="cmd"><b>npm i moltworld-sdk</b><button type="button" class="icon-btn" data-copy="npm i moltworld-sdk" aria-label="Copy install command">${icon("copy", 15)}</button></span>
          </div>
        </div>
        <div class="hero-visual" data-clip>
          <div class="world-fallback">${WORLD_FALLBACK}</div>
          <canvas id="world" role="img" aria-label="Globe of payments settling between agents and models. Drag to spin, tap to send a request."></canvas>
        </div>
      </div>
    </section>

    ${logoBand(models)}

    ${sec(`
      ${secHead("AI is sold by the seat. <em>Agents don't have seats.</em>")}
      <ul class="problems">
        <li data-reveal>Whoever holds a key spends the account.</li>
        <li data-reveal style="--d:1">Credits and plans are prepaid to the provider.</li>
        <li data-reveal style="--d:2">Dashboards can't prove what ran.</li>
      </ul>
      <p class="answer" data-reveal>Moltworld prices every request with HTTP 402. <em>Anything with a wallet can pay.</em></p>
    `)}

    ${sec(`
      ${secHead("Three products. <em>Proof on every call.</em>", arrowLink("/products", "All products"))}
      <div class="bento">
        <a class="tile wide" href="/products/gateway" data-reveal>
          <div class="tile-head"><h3>Gateway</h3><span class="go">${icon("arrow", 16)}</span></div>
          <div class="tile-visual">${termDemo(models)}</div>
        </a>
        <a class="tile narrow" href="/products/mandates" data-reveal style="--d:1">
          <div class="tile-head"><h3>Mandates</h3><span class="go">${icon("arrow", 16)}</span></div>
          <div class="tile-visual">${meterDemo()}</div>
        </a>
        <a class="tile narrow" href="/products/marketplace" data-reveal>
          <div class="tile-head"><h3>Marketplace</h3><span class="go">${icon("arrow", 16)}</span></div>
          <div class="tile-visual">${splitDemo()}</div>
        </a>
        <a class="tile wide" href="/products/receipts" data-reveal style="--d:1">
          <div class="tile-head"><h3>Receipts</h3><span class="go">${icon("arrow", 16)}</span></div>
          <div class="tile-visual">${receiptDemo()}</div>
        </a>
      </div>
    `)}

    ${sec(`
      ${secHead("Request to receipt <em>in one round trip.</em>")}
      ${flowBand()}
      ${stepsList(PAYMENT_STEPS)}
    `)}

    ${sec(`
      ${secHead("Every model. <em>Priced per call.</em>", arrowLink("/models", "All models"))}
      <div class="mod-row">
        ${MODALITIES.map(
          (k, i) =>
            `<a class="mod dot-${k}" href="/models?type=${k}" data-reveal style="--d:${i}"><div class="k"><i></i>${MODALITY_LABEL[k]}</div><div class="lab-stack">${vendors(models.filter((m) => m.modality === k)).slice(0, 4).map((v) => `<span title="${esc(vendorName(v))}">${logo(v)}</span>`).join("")}</div><div class="bars" aria-hidden="true">${[0, 1, 2, 3].map((j) => `<b style="--j:${j + i}"></b>`).join("")}</div></a>`
        ).join("")}
      </div>
    `)}
    <div class="rails-band">${modelRails(models)}</div>

    ${sec(`
      <div class="agent-grid">
        <div>
          <h2 data-split>Built for software <em>that spends money.</em></h2>
          <ul class="feature-list" data-reveal>
            <li>${icon("plug", 20)}<b>Remote and local MCP servers</b></li>
            <li>${icon("mandate", 20)}<b>Mandates bound to the agent's own key</b></li>
            <li>${icon("globe", 20)}<b>A2A agent card and llms.txt</b></li>
          </ul>
          <div class="cta-row" data-reveal>${btn("/solutions/agents", "Connect your agent")}${btn(`${docs()}/agents/mcp`, "MCP docs", "ghost")}</div>
        </div>
        ${chatDemo(models)}
      </div>
    `)}

    ${sec(`
      <div class="dev-grid">
        <div>
          <h2 data-split>One config for agents. <em>A few lines for apps.</em></h2>
          <div class="sdk-list" data-reveal>
            <a class="sdk" href="${docs()}/agents/mcp">${icon("plug", 20)}<b>MCP servers</b>${icon("arrow", 16)}</a>
            <a class="sdk" href="${docs()}/sdks/typescript">${icon("package", 20)}<b>TypeScript SDK</b>${icon("arrow", 16)}</a>
            <a class="sdk" href="${docs()}/sdks/python">${icon("package", 20)}<b>Python SDK</b>${icon("arrow", 16)}</a>
            <a class="sdk" href="${docs()}/api-reference/introduction">${icon("braces", 20)}<b>HTTP API reference</b>${icon("arrow", 16)}</a>
          </div>
        </div>
        <div data-reveal style="--d:2">${codeTabs("hero", [["mcp", "MCP", s.mcp, "json"], ["claude", "Claude Code", s.claude, "sh"], ["ts", "TypeScript", s.ts], ["py", "Python", s.py], ["curl", "curl", s.curl]])}</div>
      </div>
    `)}

    ${sec(`
      ${secHead("A wallet <em>instead of an account.</em>")}
      <div class="compare" data-reveal role="table" aria-label="Moltworld compared with API keys and plans">
        <div class="compare-row head" role="row"><div role="columnheader"></div><div class="us" role="columnheader">Moltworld</div><div role="columnheader">API keys and plans</div></div>
        ${[
          ["Sign-up", "None. A wallet is enough", "An account per provider"],
          ["Your money", "In your wallet until each call settles", "Prepaid to the provider, or billed later"],
          ["Spending limits enforced by", "Algorand, plus the gateway", "The provider's servers"],
          ["A leaked credential", "Can't pay without the agent's own key", "Spends up to the key's limit"],
          ["If the provider is compromised", "Can't take more than each call's on-chain cap", "Your balance is at its discretion"],
          ["Failed generations", "Free or refunded on-chain", "Depends on the provider"],
          ["Proof of each call", "Signed receipt and on-chain settlement", "Usage logs"],
          ["Selling your API", `Built in, ${share()}% to you`, "Build billing yourself"],
        ]
          .map(([k, us, them]) => `<div class="compare-row" role="row"><div role="rowheader">${k}</div><div class="us" role="cell">${icon("check", 16)}${us}</div><div role="cell">${them}</div></div>`)
          .join("")}
      </div>
    `)}

    ${sec(`
      ${secHead("Every number <em>is on-chain.</em>", arrowLink("/stats", "Live network"))}
      ${statsWidget()}
    `)}

    ${sec(`
      ${secHead("Every kind of agent. <em>One wallet.</em>", arrowLink("/use-cases", "All use cases"))}
      <div class="rail" data-reveal>
        ${agentTypes().map((t) => agentCard(t)).join("")}
      </div>
    `)}

    ${sec(faq())}

    ${ctaFinal("Stop managing keys. <em>Pay per call.</em>")}`;
  return renderPage(c, {
    path: "/",
    title: "Moltworld | Every AI model, paid per request",
    description: `The pay-per-request gateway for AI. Every chat, image and voice model, paid per call in USDC on Algorand through x402. No accounts, no API keys, signed receipts.`,
    body,
    data: catalogScript(models),
  });
}

function robinhoodFaq(): string {
  const qa: Array<[string, string]> = [
    ["What is live on Robinhood production?", "Real chat calls paid in WIF on Robinhood Chain, with an exact quote, x402 authorization, and a signed receipt when the call completes."],
    ["Which clients can connect?", "An EVM wallet in the Playground, the TypeScript or Python SDK, remote MCP for discovery, or a local MCP server configured with its own EVM key file. curl can request a free quote or unpaid 402 terms; it does not sign a payment."],
    ["Are media, mandates, or marketplace calls available?", marketplaceEnabled() ? "WIF marketplace calls and verified creator payout reconciliation are enabled. Owner-funded agent mandates support live WIF payments. Image, voice, video and automatic refunds remain unavailable." : "Robinhood production supports chat calls. Owner-funded mandates are live. Marketplace checkout, media and automatic refunds remain disabled."],
    ["Where do WIF amounts come from?", "The gateway returns a quote-bound WIF amount in the 402 payment requirements using the live price snapshot. The displayed USD value is a quote, not a mark-to-market balance."],
    ["Can I see example receipts or hashes?", "No fabricated transaction values or hashes are displayed. Verify a receipt from a completed real request in the Playground."],
  ];
  return `<div class="faq"><h2 data-split>Questions.</h2><div data-reveal>${qa.map(([q, a], i) => `<details class="qa"${i === 0 ? " open" : ""}><summary>${q}</summary><div class="ans"><p>${a}</p></div></details>`).join("")}</div></div>`;
}

function faq(): string {
  const qa: Array<[string, string]> = [
    ["Do I need an account or ALGO?", "No. You need a wallet with USDC on Algorand. The x402 facilitator pays the network fee, and there is nothing to sign up for."],
    ["How is a request priced?", `From the request itself: input tokens plus <code>max_tokens</code> for chat, images, characters or seconds for media, at the upstream's live rate plus a ${margin()}% margin (minimum $${config.priceMinFloor}). <code>POST /v1/quote</code> returns the same price for free.`],
    ["What if a model fails?", "Chat settles only after the answer exists. Image and voice settle first and are refunded on-chain automatically if the model fails, when generation fails."],
    ["Am I charged for unused tokens?", "Chat is authorized for its full <code>max_tokens</code> budget. The part the model didn't use is credited back and paid out in USDC."],
    ["Which clients can pay?", "Any x402 client that supports Algorand's exact scheme, the TypeScript and Python SDKs, or an agent through the remote or local MCP server."],
    [
      "How do agents spend safely?",
      `With a mandate: a small Algorand program that can only pay Moltworld, only up to a per-call limit, only until it expires, and only with a signature from the agent's own key, which never leaves the agent. ${
        onChainCap() ? "Its daily cap is enforced on-chain by an immutable spend counter. The gateway adds" : "The gateway adds a daily cap,"
      } a model list and instant revocation.`,
    ],
    [
      "How is a mandate different from an API key with a limit?",
      `An API key is a bearer secret to a balance the provider holds, and its limits live in the provider's database. A mandate leaves the money in your wallet, its per-call cap, payee and expiry${
      onChainCap() ? ", and its daily cap," : ""
      } are enforced by Algorand, and the credential is useless without the agent's key. Every call settles on-chain with a signed receipt.`,
    ],
    ["Is it open source?", `Yes. The gateway, SDKs and docs are MIT licensed on <a href="https://github.com/devndesigner6/moltworld-x402-gateway">GitHub</a>.`],
  ];
  return `<div class="faq">
      <h2 data-split>Questions.</h2>
      <div data-reveal>${qa.map(([q, a], i) => `<details class="qa"${i === 0 ? " open" : ""}><summary>${q}</summary><div class="ans"><p>${a}</p></div></details>`).join("")}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

function products(c: Context) {
  const models = catalog();
  if (config.paymentChain === "robinhood") {
    const visual: Record<string, string> = { "/products/gateway": termDemo(models), "/products/mandates": meterDemo(), "/products/marketplace": splitDemo() };
    const claim: Record<string, string> = {
      "/products/gateway": "Chat gateway, <em>paid per call in WIF.</em>",
      "/products/mandates": "Live agent mandates, <em>owner-controlled.</em>",
      "/products/marketplace": marketplaceEnabled() ? "Sell your API <em>per WIF-paid call.</em>" : "Marketplace <em>disabled on this rail.</em>",
    };
    const [receiptsLink] = builtIn();
    const body = `
      ${pageHero({ title: "The payment layer <em>for AI.</em>", ctas: `${btn("/playground", "Open Playground")}${btn("/models", "Chat models", "ghost")}` })}
      <section><div class="wrap">
        ${PRODUCTS.map(
          (p) => `<div class="prow">
            <div data-reveal><h2>${claim[p.href]}</h2>${arrowLink(p.href, esc(p.label))}</div>
            <div class="prow-visual" data-reveal style="--d:1">${visual[p.href]}</div>
          </div>`
        ).join("")}
      </div></section>
      ${sec(`${secHead("Built into <em>every eligible chat call.</em>")}
        <div class="grid-2">
          <div data-reveal>${receiptDemo()}</div>
          ${facts([
            ["receipt", `A <a href="${receiptsLink.href}">signed receipt</a> can tie a completed WIF chat response to its exact request.`],
            ["wallet", "The caller authorizes the exact quote-bound WIF amount in the wallet."],
            ["shield", "The gateway fails closed when the WIF quote or wallet payment cannot be verified."],
            ["tag", marketplaceEnabled() ? "Marketplace checkout and verified creator payout reconciliation are enabled. Mandates support live payments; media and automatic refunds are unavailable." : "Agent mandates support live payments. Image, voice, video, marketplace listings and automatic refunds are unavailable here."],
          ])}
        </div>
      `)}
      ${ctaFinal("Try the WIF <em>chat playground.</em>", `${btn("/playground", "Open Playground")}${btn("/stats", "Gateway ledger", "ghost")}`)}`;
    return renderPage(c, { path: "/products", title: "Products", description: "Moltworld WIF payments, owner-controlled agent mandates, marketplace APIs and verifiable receipts on Robinhood Chain.", body });
  }
  const visual: Record<string, string> = { "/products/gateway": termDemo(models), "/products/mandates": meterDemo(), "/products/marketplace": splitDemo() };
  const claim: Record<string, string> = {
    "/products/gateway": "One API for every model, <em>paid per call.</em>",
    "/products/mandates": "Budgets agents <em>can't exceed.</em>",
    "/products/marketplace": `Sell your API per call. <em>Keep ${share()}%.</em>`,
  };
  const [receiptsLink, refundsLink] = builtIn();
  const body = `
    ${pageHero({ title: "The payment layer <em>for AI.</em>", ctas: `${btn("/playground", "Open Playground")}${btn("/models", "Models", "ghost")}` })}
    <section><div class="wrap">
      ${PRODUCTS.map(
        (p) => `<div class="prow">
          <div data-reveal><h2>${claim[p.href]}</h2>${arrowLink(p.href, esc(p.label))}</div>
          <div class="prow-visual" data-reveal style="--d:1">${visual[p.href]}</div>
        </div>`
      ).join("")}
    </div></section>
    ${sec(`
      ${secHead("Built into <em>every call.</em>")}
      <div class="grid-2">
        <div data-reveal>${receiptDemo()}</div>
        ${facts([
          ["receipt", `A <a href="${receiptsLink.href}">signed receipt</a> ties the payment to the exact request and response.`],
          ["refund", `Failed media is <a href="${refundsLink.href}">refunded on-chain</a>.`],
          ["wallet", "Unused chat tokens are paid back in USDC."],
          ["shield", "Retries never charge twice."],
        ])}
      </div>
    `)}
    ${ctaFinal("See it work <em>in seconds.</em>")}`;
  return renderPage(c, { path: "/products", title: "Products", description: "Moltworld's products: the gateway, mandates for agents and the marketplace, with signed receipts, refunds and rebates built into every call.", body });
}

function gateway(c: Context) {
  if (config.paymentChain === "robinhood") {
    const models = catalog();
    const s = snippets();
    const checkoutDisabled = vercelPaymentPreviewDisabled();
    const availabilityNote = checkoutDisabled
      ? '<p class="note">This deployment has live API and payment routes disabled (503) until its real database and provider credentials are configured. It does not simulate responses or payments.</p>'
      : "";
    const body = `
      ${pageHero({
        crumbs: [["Product", "/products"]],
        title: checkoutDisabled ? "WIF chat, <em>preview only.</em>" : "Chat models, <em>paid per call in WIF.</em>",
        ctas: `${btn("/playground", "Open Playground")}${btn("/v1/models", "Model catalog", "ghost")}`,
        visual: termDemo(models),
      })}
      ${availabilityNote}
      ${sec(`${secHead("Priced from <em>the request itself.</em>", arrowLink("/pricing", "Pricing"))}${facts([
        ["tag", "Every eligible chat request is quoted from the body. <code>POST /v1/quote</code> is free."],
        ["layers", `The USD quote uses the configured upstream rate plus ${margin()}%, with a $${config.priceMinFloor} minimum; the 402 binds the WIF amount to its price snapshot.`],
        ["wallet", "The caller authorizes the exact WIF amount with an EVM wallet on Robinhood Chain."],
        ["shield", marketplaceEnabled() ? "Chat and approved marketplace APIs support WIF checkout. Media and automatic refunds are unavailable." : "Only chat checkout is enabled on this rail; media, marketplace, and automatic refunds are not live."],
        ["receipt", "A completed paid chat response can include a signed Moltworld receipt."],
      ])}`)}
      ${sec(`${secHead("Endpoints.")}
        <div class="table-wrap" data-reveal><table class="stack">
          <thead><tr><th>Type</th><th>Endpoint</th><th>Priced by</th><th>Status</th></tr></thead>
          <tbody>
            <tr><td data-label="Type">Chat</td><td data-label="Endpoint"><code>/v1/models/{model}/chat/completions</code></td><td data-label="Priced by">Input tokens + max_tokens</td><td data-label="Status">WIF checkout when deployment is enabled</td></tr>
            <tr><td data-label="Type">Image</td><td data-label="Endpoint"><code>/v1/models/{model}/images/generations</code></td><td data-label="Priced by">—</td><td data-label="Status">Not enabled on WIF</td></tr>
            <tr><td data-label="Type">Voice</td><td data-label="Endpoint"><code>/v1/models/{model}/audio/speech</code></td><td data-label="Priced by">—</td><td data-label="Status">Not enabled on WIF</td></tr>
          </tbody></table></div>
      `)}
      ${sec(`<div class="dev-grid"><h2 data-split>Start <em>in a few lines.</em></h2><div data-reveal>${codeTabs("gw", [["mcp", "MCP", s.mcp, "json"], ["ts", "TypeScript", s.ts], ["py", "Python", s.py], ["curl", "curl", s.curl]])}</div></div>`)}
      ${sec(`${secHead("How a chat call <em>gets paid.</em>")}${robinhoodFlowBand()}${stepsList([
        "Request a free quote and receive the exact USD estimate plus WIF amount.",
        "Submit the same chat body, receive the 402 challenge, and authorize it with an EVM x402 client.",
        "The gateway returns the chat response and signed receipt when the enabled payment path completes.",
      ])}`)}
      ${ctaFinal(checkoutDisabled ? "WIF chat checkout is <em>preview-only here.</em>" : "Connect a wallet and <em>try a chat call.</em>", btn("/playground", checkoutDisabled ? "View Playground" : "Open Playground"))}`;
    return renderPage(c, { path: "/products/gateway", title: checkoutDisabled ? "Gateway preview" : "Gateway", description: checkoutDisabled ? "The public site preview is available, but live API and WIF checkout are disabled until production configuration is complete." : "Chat API paid per request in WIF on Robinhood Chain through x402.", body });
  }
  const models = catalog();
  const s = snippets();
  const body = `
    ${pageHero({
      crumbs: [["Product", "/products"]],
      title: "One API for every model, <em>paid per call.</em>",
      ctas: `${btn("/playground", "Open Playground")}${btn("/models", "Models", "ghost")}`,
      visual: termDemo(models),
    })}
    ${sec(`
      ${secHead("Priced from <em>the request itself.</em>", arrowLink("/pricing", "Pricing"))}
      ${facts([
        ["tag", "Every request is quoted from what you send. <code>POST /v1/quote</code> is free."],
        ["layers", `Upstream cost plus ${margin()}%, minimum $${config.priceMinFloor} per call.`],
        ["refund", "Chat is charged after the answer. Failed media is refunded on-chain."],
        ["wallet", "Unused chat tokens are paid back in USDC."],
        ["shield", "Retrying a payment returns the original response, never a second charge."],
        ["users", "Parallel calls can't spend more than the wallet holds."],
      ])}
    `)}
    ${sec(`
      ${secHead("Endpoints.")}
      <div class="table-wrap" data-reveal><table class="stack">
        <thead><tr><th>Type</th><th>Endpoint</th><th>Priced by</th><th>Charged</th></tr></thead>
        <tbody>
          <tr><td data-label="Type">Chat</td><td data-label="Endpoint"><code>/v1/models/{model}/chat/completions</code></td><td data-label="Priced by">Input tokens + max_tokens</td><td data-label="Charged">After the answer</td></tr>
          <tr><td data-label="Type">Image</td><td data-label="Endpoint"><code>/v1/models/{model}/images/generations</code></td><td data-label="Priced by">Images</td><td data-label="Charged">First, refunded on failure</td></tr>
          <tr><td data-label="Type">Voice</td><td data-label="Endpoint"><code>/v1/models/{model}/audio/speech</code></td><td data-label="Priced by">Characters</td><td data-label="Charged">First, refunded on failure</td></tr>
        </tbody></table></div>
    `)}
    ${sec(`<div class="dev-grid"><h2 data-split>Start <em>in a few lines.</em></h2><div data-reveal>${codeTabs("gw", [["mcp", "MCP", s.mcp, "json"], ["claude", "Claude Code", s.claude, "sh"], ["ts", "TypeScript", s.ts], ["py", "Python", s.py], ["curl", "curl", s.curl]])}</div></div>`)}
    ${sec(`${secHead("How a call <em>gets paid.</em>")}${flowBand()}${stepsList(PAYMENT_STEPS)}`)}
    ${ctaFinal("Try a model <em>now.</em>")}`;
  return renderPage(c, { path: "/products/gateway", title: "Gateway", description: "One API for chat, image and voice models, paid per request in USDC through x402.", body });
}

function modelsPage(c: Context) {
  const allModels = catalog();
  const models = config.paymentChain === "robinhood" ? allModels.filter((model) => model.modality === "chat") : allModels;
  const vs = vendors(models).slice(0, 10);
  const orbit = `<div class="orbit3d" data-clip aria-hidden="true">
      <div class="core">${mark(54)}</div>
      <div class="ring">${vs.map((v, i) => `<span class="node" style="--a:${((360 / vs.length) * i).toFixed(1)}deg" title="${esc(vendorName(v))}">${logo(v)}</span>`).join("")}</div>
    </div>`;
  const body = `
    ${pageHero({
      title: "Every model, <em>priced per request.</em>",
      ctas: `${btn("/playground", "Open Playground")}${btn("/v1/models", "Catalog JSON", "ghost")}`,
      visual: orbit,
    })}
    <section class="sec" style="padding-top:48px"><div class="wrap">${catalogWidget(models)}</div></section>
    ${ctaFinal("Price your <em>exact request.</em>")}`;
  return renderPage(c, { path: "/models", title: "Models", description: "Moltworld model catalog with upstream ids, limits and per-request prices. Models a provider can't confirm are not sold.", body });
}

function mandates(c: Context) {
  if (config.paymentChain === "robinhood") {
    if (!config.isMainnet) {
      const body = `${pageHero({ crumbs: [["Product", "/products"]], title: "WIF mandates are <em>mainnet-only.</em>" })}${sec(`<p class="note">The owner setup page is deliberately unavailable on testnet. The WIF mandate contract is pinned to Robinhood Chain mainnet.</p>`)}`;
      return renderPage(c, { path: "/products/mandates", title: "WIF mandates", description: "WIF mandates use a Robinhood Chain mainnet EIP-1271 policy wallet.", body });
    }
    const body = `
      ${pageHero({ crumbs: [["Product", "/products"]], title: "Give an agent a budget, <em>not your keys.</em>", ctas: `${btn("/playground", "Test direct WIF checkout")}${btn("/quickstart", "WIF quickstart", "ghost")}`, visual: meterDemo() })}
      ${sec(`
        ${secHead("Owner-controlled budgets <em>with live settlement.</em>")}
        <div class="split-table">
          <div class="enforce" data-reveal><h3>${icon("shield", 20)} Owner wallet</h3><ul><li>Deploys and owns the policy contract</li><li>Transfers WIF into the contract</li><li>Arms a finite Permit2 allowance</li><li>Can revoke and withdraw</li></ul></div>
          <div class="enforce" data-reveal style="--d:1"><h3>${icon("gateway", 20)} On-chain policy</h3><ul><li>Per-call WIF cap and finite total allowance</li><li>Agent session key is separate from the owner</li><li>Expiry and epoch checks are enforced by the contract</li><li>Mainnet settlement verified with a signed receipt</li></ul></div>
        </div>
        <div class="grid-2" style="margin-top:24px"><div class="card" data-reveal><h3>Configuration code</h3><p class="mono">wif-session-keygen &middot; share only the printed agent address</p></div><div class="card" data-reveal style="--d:1"><h3>Mandate lookup</h3><p class="note">Read live policy and balance at <code>GET /v1/mandates/{contract-address}</code>. The wizard verifies the pinned contract and current gateway recipient.</p></div></div>
      `)}
      ${sec(`
        <div data-wif-mandate-root class="mandate-setup">
        <div class="mandate-warning" role="note">
          <strong>Live on Robinhood Chain</strong>
          <p>A local MCP agent completed a real WIF payment through this EIP-1271 mandate on mainnet. View the <a href="https://robinhoodchain.blockscout.com/tx/0x879e7e15f7b2cd4cd540f2e725ca3d3ce78ea552389588c6c95f539c35df43f3" target="_blank" rel="noopener noreferrer">settlement transaction</a> and <a href="https://moltworldd.vercel.app/v1/receipts/req_uPG_4T8Lt9AlG3qS" target="_blank" rel="noopener noreferrer">signed receipt</a>. The contract has not had an independent security audit. Use a limited balance and review every wallet prompt. Keep owner and session private keys off this page.</p>
        </div>
        <div class="grid-2 mandate-top-grid">
          <div class="card">
            <h2>1. Connect the owner wallet</h2>
            <p>Use MetaMask or another injected EVM wallet. It stays in control of every deployment, WIF transfer, arm, revoke, and withdrawal transaction.</p>
            <button class="btn" type="button" data-action="connect">Connect owner wallet</button>
            <p class="mandate-owner-line">Connected owner: <span class="mono" data-owner-address>Not connected</span></p>
          </div>
          <div class="card">
            <h2>2. Create a separate agent key</h2>
            <p>Run this source-build command on the machine that will run your <strong>local stdio MCP</strong>. It stores the session private key locally with restricted file permissions and prints only its public address.</p>
            <pre class="mandate-code"><code>git clone https://github.com/devndesigner6/moltworld-x402-gateway.git
cd moltworld-x402-gateway
pnpm install --frozen-lockfile
pnpm --dir sdk/js build
node sdk/js/dist/mcp.js wif-session-keygen</code></pre>
            <p>Copy only the printed address into the form. Never paste the session key here. The hosted remote MCP stays keyless.</p>
          </div>
        </div>
        <div class="card mandate-card">
          <h2>3. Deploy and configure the mandate</h2>
          <div class="mandate-fields">
            <label>Existing mandate address (optional)<input data-field="mandate-address" autocomplete="off" placeholder="0x…"></label>
            <label>Local agent public address<input data-field="agent-address" autocomplete="off" placeholder="0x…"></label>
            <label>Maximum WIF per call<input data-field="per-call" inputmode="decimal" placeholder="e.g. 1" value="1"></label>
            <label>Finite total WIF allowance<input data-field="total-cap" inputmode="decimal" placeholder="e.g. 10" value="10"></label>
            <label>Mandate duration (days)<input data-field="duration-days" type="number" min="1" max="7" step="1" value="1"></label>
          </div>
          <div class="mandate-actions">
            <button class="btn btn-ghost" type="button" data-action="refresh">Verify existing contract</button>
            <button class="btn" type="button" data-action="deploy">Deploy new contract</button>
          </div>
          <p class="note">Deployment creates an empty contract and costs gas; it does not move WIF. The contract fixes its owner, the WIF token, Permit2, the x402 payment proxy, and the current live gateway pay-to.</p>
          <p class="mandate-details" data-mandate-details>Connect the owner wallet to verify live chain, token, recipient, and contract state.</p>
          <a class="mono mandate-tx" data-deploy-tx hidden target="_blank" rel="noopener"></a>
        </div>
        <div class="grid-2 mandate-top-grid">
          <div class="card">
            <h2>4. Fund and arm</h2>
            <p>WIF is transferred into the contract, then the owner arms a finite Permit2 allowance. The contract will reject an unlimited allowance, an allowance above its WIF balance, a different token/proxy/payee, an expired request, or a stale session epoch.</p>
            <label>WIF to transfer<input data-field="fund-amount" inputmode="decimal" placeholder="small test amount"></label>
            <button class="btn btn-ghost" type="button" data-action="fund">Transfer WIF to mandate</button>
            <button class="btn" type="button" data-action="arm">Arm this mandate</button>
          </div>
          <div class="card">
            <h2>5. Revoke or withdraw</h2>
            <p>Revocation advances the policy epoch and zeroes the Permit2 allowance. Wait for the revoke transaction to confirm before withdrawing WIF to the owner wallet.</p>
            <label>WIF to withdraw<input data-field="withdraw-amount" inputmode="decimal" placeholder="amount"></label>
            <div class="mandate-actions"><button class="btn btn-ghost" type="button" data-action="revoke">Revoke mandate</button><button class="btn btn-ghost" type="button" data-action="withdraw">Withdraw WIF</button></div>
          </div>
        </div>
        <div class="card mandate-card">
          <label class="mandate-ack"><input data-field="risk-ack" type="checkbox"> I understand this contract has not had an independent security audit. I will use a limited balance, review the spending limits and inspect every wallet prompt.</label>
          <div class="mandate-actions"><button class="btn btn-ghost" type="button" data-action="copy-config">Copy local MCP settings</button></div>
          <p class="mandate-status" data-mandate-status role="status" aria-live="polite">Ready. Connect the owner wallet to verify the live WIF settings.</p>
        </div>
        </div>
      `)}
      ${ctaFinal("An agent key. <em>A bounded WIF budget.</em>", `${btn("/playground", "Try direct checkout")}${btn("/quickstart", "Read MCP setup", "ghost")}`)}`;
    return renderPage(c, { path: "/products/mandates", title: "WIF Agent Mandates", description: "Live owner-controlled WIF session mandates on Robinhood Chain with a finite Permit2 allowance, per-call cap, expiry, and revocation.", body });
  }
  const origin = config.publicDomain;
  const body = `
    ${pageHero({
      crumbs: [["Product", "/products"]],
      title: "Let an agent spend, <em>within limits.</em>",
      ctas: `${btn(`${docs()}/products/mandates`, "Create a mandate")}${btn("/use-cases/agent-allowance", "Use case", "ghost")}`,
      visual: meterDemo(),
    })}
    ${sec(`
      ${secHead("Two layers <em>of enforcement.</em>")}
      <div class="split-table">
        <div class="enforce" data-reveal><h3>${icon("shield", 20)} Algorand</h3><ul><li>Pays only Moltworld, only USDC</li><li>Maximum per call</li><li>Co-signed by the agent's own key</li>${onChainCap() ? "<li>Daily cap, by the spend counter</li>" : ""}<li>Zero fee, no rekey, expiry round</li></ul></div>
        <div class="enforce" data-reveal style="--d:1"><h3>${icon("gateway", 20)} Gateway</h3><ul><li>${onChainCap() ? "Rolling 24-hour cap, a second check" : "Rolling 24-hour cap"}</li><li>Allowed models</li><li>Instant revocation</li><li>Spend per mandate</li></ul></div>
      </div>
    `)}
    ${sec(`
      ${secHead("Create one <em>in a few lines.</em>")}
      <div class="grid-2">
        <div data-reveal>${codeTabs("mandate", [
          [
            "key",
            "1. Agent key",
            `# On the agent's machine. The key stays there; only the address is shared.
npx -y -p moltworld-sdk moltworld-mcp keygen
# -> AGENTADDRESS...   (saved to ~/.moltworld/agent.key)`,
            "sh",
          ],
          [
            "owner",
            "2. Owner",
            `import algosdk from "algosdk";
import { createMandate } from "moltworld-sdk";

const owner = algosdk.mnemonicToSecretKey(process.env.OWNER_MNEMONIC);
// The SDK checks the program against these limits before you sign it.
const { mandateId, credential } = await createMandate("${origin}", owner, {
  agent: "AGENTADDRESS...", // every payment must be co-signed by this key
  maxPerCallUsd: 0.25,
  dailyCapUsd: 5,
  validDays: 30,
  allowedModels: ["gpt-4o", "claude-sonnet-5"],
});`,
            "ts",
          ],
          [
            "agent",
            "3. Agent",
            `import { MoltworldClient } from "moltworld-sdk";

// The credential alone can't pay: the agent's own key co-signs every payment.
const agent = new MoltworldClient({ mandate: credential, agentKey: process.env.AGENT_KEY });
await agent.chat("gpt-4o", {
  messages: [{ role: "user", content: "Draft a reply" }],
});`,
            "ts",
          ],
          ["revoke", "Revoke", `import { revokeMandate } from "moltworld-sdk";

// Stops all spending: the program can only pay Moltworld.
await revokeMandate("${origin}", owner, mandateId);`, "ts"],
        ])}</div>
        <div data-reveal style="--d:1">${mandateLookupWidget()}</div>
      </div>
    `)}
    ${ctaFinal("Give your agent <em>a budget.</em>")}`;
  return renderPage(c, { path: "/products/mandates", title: "Mandates", description: "Delegated spending for AI agents: per-call limit and expiry on-chain, daily cap and model list on the gateway, revocable at any time.", body });
}

function marketplace(c: Context) {
  if (config.paymentChain === "robinhood" && marketplaceEnabled()) {
    const input = (name: string, label: string, type = "text") => `<label>${label}<input name="${name}" type="${type}" required autocomplete="off"></label>`;
    const body = `${pageHero({ crumbs: [["Product", "/products"]], title: `Sell your API in WIF. <em>Keep ${share()}%.</em>` })}
      <div data-wif-market-root>
      ${sec(`<div class="actions" data-market-wallets></div><p class="note" role="status" data-market-status>Loading the live marketplace…</p>
        <p class="note">Each successful call credits ${share()}% of its exact WIF payment to the creator. Listings require review. Creator payouts are authorized by the merchant wallet and marked sent after on-chain verification.</p>`)}
      ${sec(`<div class="grid-2"><div class="card"><h2>Call an API</h2>
        <label>Approved listing<select name="listing"></select></label><p class="note" data-listing-description></p>
        <label>Request JSON<textarea name="request-body" spellcheck="false"></textarea></label>
        <label>Maximum USD quote per call<input name="max-usd" type="number" value="0.25" min="0.001" step="0.001"></label>
        <div class="actions"><button class="btn btn-ghost" type="button" data-market-refresh>Refresh listings</button><button class="btn btn-ghost" type="button" data-market-quote>Get WIF quote</button><button class="btn" type="button" data-market-pay>Pay and call</button></div></div>
        <form class="card" data-earnings-form><h2>Creator earnings</h2>${input("earnings-address", "Creator wallet address")}
        <button class="btn btn-ghost" type="submit">Check earnings and payouts</button><p class="note">Unpaid and paid amounts use exact WIF base units. A pending payout remains unpaid until its transfer is verified.</p></form></div>`)}
      ${sec(`<form class="card" data-listing-form><h2>Submit your API</h2>
        <div class="grid-2"><div>${input("slug", "Listing slug")}${input("name", "API name")}${input("upstream-url", "Public HTTPS endpoint", "url")}</div>
        <div>${input("description", "Description")}${input("price-usd", "USD price per call")}<label>Example request JSON<textarea name="input-example" spellcheck="false"></textarea></label></div></div>
        <p class="note">Your wallet signs the exact listing terms. Save the returned signing secret and use it to verify Moltworld's forwarded-call signatures. The operator reviews the endpoint before it accepts payments.</p>
        <div class="actions"><button class="btn" type="submit">Sign and submit listing</button><button class="btn btn-ghost" type="button" data-listing-status>Check listing status</button></div></form>`)}
      ${sec(`<div class="card"><h2>Response and receipt</h2><pre style="max-width:100%;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere" data-market-result></pre></div>`)}
      </div>${ctaFinal("APIs paid <em>per call in WIF.</em>")}`;
    return renderPage(c, { path: "/products/marketplace", title: "WIF marketplace", description: "Discover creator APIs, pay per call in WIF, and verify exact creator earnings and wallet-authorized payouts.", body, data: payConfigScript() });
  }
  if (config.paymentChain === "robinhood") {
    const body = `
      ${pageHero({ crumbs: [["Product", "/products"]], title: "Creator payouts are <em>not enabled here.</em>", ctas: `${btn("/products", "Product overview")}${btn("/solutions/api-creators", "For API sellers", "ghost")}`, visual: splitDemo() })}
      ${sec(`${secHead("From listing <em>to payout.</em>")}${stepsList([
        "Listing registration is disabled on the Robinhood Chain WIF rail.",
        "No marketplace review or buyer checkout is available here.",
        "Creator payouts, refunds, buybacks, and flywheel mechanisms are not live.",
        "Do not submit a listing or assume creator earnings will occur.",
      ])}`)}
      ${sec(`<div class="grid-2"><div class="card" data-reveal><h3>Listings</h3><p class="note">Disabled for WIF. No live listings are loaded or represented.</p></div><div class="card" data-reveal style="--d:1"><h3>Creator earnings</h3><p class="note">Disabled for WIF. No payout balance, refund, or buyback is shown.</p></div></div>`)}
      ${sec(`${secHead("Create a listing <em>when this rail is ready.</em>")}${codeBlock("// Marketplace is disabled on Robinhood Chain.\n// No listing or payout request is sent from this page.", "sh")}`)}
      ${ctaFinal("Marketplace <em>is not live on WIF.</em>", `${btn("/products", "Back to products")}${btn("/playground", "Try chat checkout", "ghost")}`)}`;
    return renderPage(c, { path: "/products/marketplace", title: "Marketplace unavailable", description: "The marketplace is disabled on the Robinhood Chain deployment; no creator listings or payouts are represented as live.", body });
  }
  const origin = config.publicDomain;
  const body = `
    ${pageHero({
      crumbs: [["Product", "/products"]],
      title: `Sell your API per call. <em>Keep ${share()}%.</em>`,
      ctas: `${btn(`${docs()}/products/marketplace`, "List your API")}${btn("/solutions/api-creators", "For API sellers", "ghost")}`,
      visual: splitDemo(),
    })}
    ${sec(`
      ${secHead("From listing <em>to payout.</em>")}
      ${stepsList([
        "Sign a listing with your Algorand wallet.",
        "We review the endpoint.",
        "Buyers pay per call through x402.",
        `Payouts in USDC once you pass $${config.creatorPayoutMinUsd}.`,
      ])}
    `)}
    ${sec(`<div class="grid-2"><div data-reveal>${marketWidget()}</div><div data-reveal style="--d:1">${earningsWidget()}</div></div>`)}
    ${sec(`
      ${secHead("Create a listing.")}
      <div data-reveal>${codeBlock(`const listing = {
  action: "list",
  creator: wallet.addr.toString(), // payouts can only go here
  slug: "weather-now",
  name: "Weather Now",
  description: "Current weather for a city, as JSON.",
  upstream_url: "https://api.example.com/weather",
  price_usd: 0.002,
  input_example: { city: "Lagos" },
  issued_at: Math.floor(Date.now() / 1000),
};

await fetch("${origin}/v1/market/listings", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ listing, creator_sig: signOwnerMessage(listing, wallet.sk) }),
});
// Buyers call ${origin}/v1/market/weather-now/call`)}</div>
    `)}
    ${ctaFinal("Turn your API <em>into revenue.</em>")}`;
  return renderPage(c, { path: "/products/marketplace", title: "Marketplace", description: "Sell your own API through Moltworld's x402 checkout and get paid per call in USDC.", body });
}

function receipts(c: Context) {
  const robinhood = config.paymentChain === "robinhood";
  const fields: Array<[string, string]> = robinhood ? [
    ["<code>txid</code>", "Robinhood Chain transaction that settled the payment"],
    ["<code>payer</code>", "EVM wallet that authorized the x402 payment"],
    ["<code>amountAtomic</code>, <code>assetSymbol</code>", "Exact WIF amount in ERC-20 base units and token metadata"],
    ["<code>quotedUsdMicro</code>", "USD quote bound to the WIF price snapshot; not mark-to-market value"],
    ["<code>requestSha256</code>", "Hash of the request body you sent"],
    ["<code>responseSha256</code>", "Hash of the exact response bytes"],
    ["<code>kid</code>, <code>sig</code>", "Ed25519 key id and signature"],
  ] : [
    ["<code>txid</code>", "Algorand transaction that settled the payment"],
    ["<code>payer</code>, <code>amountMicro</code>", "Who paid, and how much in micro-USDC"],
    ["<code>upstreamProvider</code>, <code>upstreamModel</code>", "The model that actually answered"],
    ["<code>requestSha256</code>", "Hash of the request body you sent"],
    ["<code>responseSha256</code>", "Hash of the exact response bytes"],
    ["<code>rebateMicro</code>", "Unused chat budget paid back"],
    ["<code>kid</code>, <code>sig</code>", "Ed25519 key id and signature"],
  ];
  const body = `
    ${pageHero({
      crumbs: [["Product", "/products"]],
      title: "Proof of what you paid for <em>and what you got.</em>",
      ctas: `${btn("#verify", "Verify a receipt")}${btn("/.well-known/moltworld-receipts.json", "Signing keys", "ghost")}`,
      visual: receiptDemo(),
    })}
    ${sec(`
      ${secHead("Every paid response <em>carries one.</em>", robinhood ? "" : arrowLink(`${docs()}/concepts/receipts`, "Receipt docs"))}
      <ul class="anatomy-list" data-reveal>${fields.map(([f, d]) => `<li><span>${f}</span><span>${d}</span></li>`).join("")}</ul>
    `)}
    ${sec(`${secHead("Verify <em>a receipt.</em>")}<div data-reveal>${receiptWidget()}</div>`, { id: "verify" })}
    ${ctaFinal("Every call <em>comes with proof.</em>")}`;
  return renderPage(c, { path: "/products/receipts", title: "Receipts", description: robinhood ? "Ed25519-signed receipts bind each Robinhood Chain WIF payment to the exact request and response." : "Ed25519-signed receipts that tie each payment to the exact request and response.", body });
}

// ---------------------------------------------------------------------------
// Pricing and developers
// ---------------------------------------------------------------------------

function pricing(c: Context) {
  if (config.paymentChain === "robinhood") {
    const models = catalog().filter((model) => model.modality === "chat");
    const examples = models.slice(0, 8);
    const body = `
      ${pageHero({ title: "USD-priced requests. <em>Paid in WIF.</em>", ctas: `${btn("/playground", "Quote a chat request")}${btn("/models", "Chat models", "ghost")}` })}
      ${sec(`<div class="formula" data-reveal role="img" aria-label="USD quote equals upstream cost times ${(1 + config.priceMargin).toFixed(2)}, with a minimum of $${config.priceMinFloor} per chat call"><span class="term-box">Upstream cost</span><span class="op">&times;</span><span class="term-box">${(1 + config.priceMargin).toFixed(2)}</span><span class="op">min</span><span class="term-box">$${config.priceMinFloor}</span></div>`, { line: false })}
      ${sec(`${secHead("Never billed.")}<div class="free-list">${["Accounts and plans", "Quotes and 402 challenges", "Unsupported media requests", "Unrequested marketplace actions"].map((t, i) => `<div class="free" data-reveal style="--d:${i}"><b>$0</b><span>${t}</span></div>`).join("")}</div>`)}
      ${sec(`${secHead("What a chat call <em>costs today.</em>", arrowLink("/models", "Chat models"))}<p class="note">Prices shown are USD starting estimates. Your WIF amount depends on the live quote-time price and exact request.</p><div class="table-wrap" data-reveal><table class="stack"><thead><tr><th>Model</th><th>Type</th><th>Request</th><th>Price</th><th><span class="sr-only">Action</span></th></tr></thead><tbody>${examples.map((m) => `<tr><td data-label="Model">${esc(m.name)}</td><td data-label="Type">Chat</td><td data-label="Request">Short prompt, 256 max_tokens</td><td data-label="Price"><strong>${esc(m.from)}</strong></td><td data-label=""><a class="link-arrow" href="/playground?model=${encodeURIComponent(m.slug)}">Price yours ${icon("arrow", 14)}</a></td></tr>`).join("")}</tbody></table></div>`)}
      ${sec(`${secHead(marketplaceEnabled() ? "Sell APIs <em>per WIF-paid call.</em>" : "Selling <em>is disabled on WIF.</em>")}<div class="grid-2"><div data-reveal>${splitDemo()}</div>${facts([["tag", marketplaceEnabled() ? "Creator listings require a wallet signature and operator approval." : "Marketplace listings are not enabled on Robinhood Chain."], ["wallet", marketplaceEnabled() ? "Creator payouts use merchant-authorized WIF transfers and on-chain reconciliation. Automatic refunds and buybacks are unavailable." : "No creator payout, refund, buyback, or flywheel mechanism is live."], ["shield", "The illustrative split is not a payment or earnings record."]])}</div>`)}
      ${ctaFinal("See the quote <em>before you authorize.</em>", btn("/playground", "Open Playground"))}`;
    return renderPage(c, { path: "/pricing", title: "Pricing", description: "USD-based chat request quotes converted to WIF on Robinhood Chain at the time of x402 authorization.", body });
  }
  const models = catalog();
  const examples = ["gpt", "claude-sonnet-5", "gemini", "gpt-image-1.5", "eleven-multilingual"]
    .map((slug) => models.find((m) => m.slug === slug))
    .filter((m): m is CatalogEntry => !!m);
  const reference: Record<string, string> = { chat: "Short prompt, 256 max_tokens", image: "One image", voice: "One sentence", video: "Shortest clip" };
  const body = `
    ${pageHero({
      title: "Pay for the request. <em>Nothing else.</em>",
      ctas: `${btn("/playground", "Price a request")}${btn(`${docs()}/concepts/pricing`, "Pricing docs", "ghost")}`,
    })}
    ${sec(`
      <div class="formula" data-reveal role="img" aria-label="Price equals upstream cost times ${(1 + config.priceMargin).toFixed(2)}, with a minimum of $${config.priceMinFloor} per call">
        <span class="term-box">Upstream cost</span><span class="op">&times;</span><span class="term-box">${(1 + config.priceMargin).toFixed(2)}</span><span class="op">min</span><span class="term-box">$${config.priceMinFloor}</span>
      </div>
    `, { line: false })}
    ${sec(`
      ${secHead("Never billed.")}
      <div class="free-list">
        ${["Accounts and plans", "Quotes and 402 challenges", "Failed generations", "Unused chat tokens"].map((t, i) => `<div class="free" data-reveal style="--d:${i}"><b>$0</b><span>${t}</span></div>`).join("")}
      </div>
    `)}
    ${sec(`
      ${secHead("What a call <em>costs today.</em>", arrowLink("/models", "All models"))}
      <div class="table-wrap" data-reveal><table class="stack">
        <thead><tr><th>Model</th><th>Type</th><th>Request</th><th>Price</th><th><span class="sr-only">Action</span></th></tr></thead>
        <tbody>${examples
          .map(
            (m) =>
              `<tr><td data-label="Model">${esc(m.name)}</td><td data-label="Type">${MODALITY_LABEL[m.modality]}</td><td data-label="Request">${reference[m.modality]}</td><td data-label="Price"><strong>${esc(m.from)}</strong></td><td data-label=""><a class="link-arrow" href="/playground?model=${encodeURIComponent(m.slug)}">Price yours ${icon("arrow", 14)}</a></td></tr>`
          )
          .join("")}</tbody>
      </table></div>
    `)}
    ${sec(`
      ${secHead("Selling <em>on the marketplace.</em>")}
      <div class="grid-2">
        <div data-reveal>${splitDemo()}</div>
        ${facts([
          ["tag", "You set the price per call."],
          ["wallet", `${share()}% goes to you, ${config.marketplaceFeePercent}% to Moltworld.`],
          ["refund", `Batched USDC payouts from $${config.creatorPayoutMinUsd}.`],
        ])}
      </div>
    `)}
    ${ctaFinal("See the price <em>before you pay.</em>")}`;
  return renderPage(c, { path: "/pricing", title: "Pricing", description: `Pay per request: upstream cost plus a published ${margin()}% margin, no plans or seats, failed calls refunded and unused tokens paid back.`, body });
}

function developers(c: Context) {
  if (config.paymentChain === "robinhood") {
    const s = snippets();
    const body = `
      ${pageHero({ title: "Build on the <em>WIF x402 rail.</em>", ctas: `${btn("/quickstart", "WIF Quickstart")}${btn("/v1/models", "Model catalog", "ghost")}`, visual: codeTabs("dev", [["mcp", "MCP", s.mcp, "json"], ["ts", "TypeScript", s.ts], ["py", "Python", s.py], ["curl", "curl", s.curl]]) })}
      ${sec(`${secHead("First call <em>in minutes.</em>")}${stepsList(["Connect an EVM wallet on Robinhood Chain.", "Hold WIF and native ETH for any first-use Permit2 approval.", "Request a free quote and inspect the 402 challenge.", marketplaceEnabled() ? "Call an enabled chat model or approved marketplace API. Owner-funded agent mandates support live WIF payments." : "Call an enabled chat model directly or through a funded mandate. Media and marketplace calls are unavailable here."])}`)}
      ${sec(`${secHead("Tools.")}${linkCards([{ title: "TypeScript SDK", href: `${docs()}/sdks/typescript`, icon: "package" }, { title: "Python SDK", href: `${docs()}/sdks/python`, icon: "package" }, { title: "Remote MCP", href: `${docs()}/agents/mcp`, icon: "plug" }, { title: "Chat API reference", href: `${docs()}/api-reference/introduction`, icon: "braces" }, { title: "Playground", href: "/playground", icon: "play" }, { title: "Gateway ledger", href: "/stats", icon: "pulse" }])}`)}
      ${sec(`${secHead("Machine-readable <em>by default.</em>")}<div class="table-wrap" data-reveal><table class="stack"><thead><tr><th>Endpoint</th><th>Contents</th></tr></thead><tbody>${[["/llms.txt", "The service, written for language models"], ["/v1/models", "Chat catalog with upstream ids and starting estimates"], ["/.well-known/x402", "x402 resource descriptor"], ["/.well-known/moltworld-receipts.json", "Receipt signing keys"], ["/mcp", "Remote MCP for discovery and caller-signed relay"], ["/health", "Readiness and network"]].map(([p, d]) => `<tr><td data-label="Endpoint"><a href="${p}"><code>${config.publicDomain}${p}</code></a></td><td data-label="Contents">${d}</td></tr>`).join("")}</tbody></table></div>`)}
      ${ctaFinal("Inspect and authorize <em>every payment.</em>", btn("/playground", "Open Playground"))}`;
    return renderPage(c, { path: "/developers", title: "WIF Developer quickstart", description: "Build with the Moltworld x402 chat API using WIF on Robinhood Chain and an EVM wallet.", body });
  }
  const origin = config.publicDomain;
  const s = snippets();
  const body = `
    ${pageHero({
      title: "Everything you need <em>to build.</em>",
      ctas: `${btn(`${docs()}/quickstart`, "Quickstart")}${btn("/playground", "Playground", "ghost")}`,
      visual: codeTabs("dev", [["mcp", "MCP", s.mcp, "json"], ["claude", "Claude Code", s.claude, "sh"], ["ts", "TypeScript", s.ts], ["py", "Python", s.py], ["curl", "curl", s.curl]]),
    })}
    ${sec(`
      ${secHead("First call <em>in minutes.</em>")}
      ${stepsList(["Fund a wallet with USDC.", "<code>npm i moltworld-sdk</code>", "Set a per-request cap.", "Call any model."])}
    `)}
    ${sec(`
      ${secHead("Tools.")}
      ${linkCards([
        { title: "TypeScript SDK", href: `${docs()}/sdks/typescript`, icon: "package" },
        { title: "Python SDK", href: `${docs()}/sdks/python`, icon: "package" },
        { title: "MCP servers", href: `${docs()}/agents/mcp`, icon: "plug" },
        { title: "API reference", href: `${docs()}/api-reference/introduction`, icon: "braces" },
        { title: "Playground", href: "/playground", icon: "play" },
        { title: "Live network", href: "/stats", icon: "pulse" },
      ])}
    `)}
    ${sec(`
      ${secHead("Machine-readable <em>by default.</em>")}
      <div class="table-wrap" data-reveal><table class="stack">
        <thead><tr><th>Endpoint</th><th>Contents</th></tr></thead>
        <tbody>
          ${[
            ["/llms.txt", "The service, written for language models"],
            ["/v1/models", "Catalog with upstream ids, cost basis and prices"],
            ["/.well-known/x402", "x402 resource descriptor"],
            ["/.well-known/agent-card.json", "A2A agent card"],
            ["/.well-known/moltworld-receipts.json", "Receipt signing keys"],
            ["/mcp", "Remote MCP server, streamable HTTP"],
            ["/health", "Readiness and network"],
          ]
            .map(([p, d]) => `<tr><td data-label="Endpoint"><a href="${p}"><code>${origin}${p}</code></a></td><td data-label="Contents">${d}</td></tr>`)
            .join("")}
        </tbody></table></div>
    `)}
    ${ctaFinal("Build with <em>Moltworld.</em>")}`;
  return renderPage(c, { path: "/developers", title: "Developers", description: "Moltworld SDKs, API reference, MCP servers and discovery endpoints for apps and agents.", body });
}

function quickstart(c: Context) {
  if (config.paymentChain !== "robinhood") return c.redirect(`${docs()}/quickstart`, 302);
  const chain = config.networkCaip2;
  const token = config.paymentAssetAddress || "the configured WIF ERC-20 contract";
  const body = `
    ${pageHero({
      crumbs: [["Developers", "/developers"]],
      title: "WIF chat, <em>one approved call at a time.</em>",
      ctas: `${btn("/playground", "Open the wallet playground")}${btn("/developers", "Developer hub", "ghost")}`,
    })}
    ${sec(`
      ${secHead("For users <em>with a wallet.</em>")}
      <p class="lead" data-reveal>Robinhood production currently supports chat-only x402 payments. Connect an injected EIP-1193 wallet in the browser, review the exact quote, and authorize each WIF payment yourself.</p>
      ${facts([
        ["wallet", "Use a compatible injected EIP-1193 wallet such as MetaMask or Robinhood Wallet."],
        ["globe", `Switch to Robinhood Chain Mainnet (${chain}) and keep WIF in the wallet.`],
        ["tag", `WIF is the ERC-20 payment token at <code>${esc(token)}</code> with 18 decimals.`],
        ["shield", "First use may ask for an exact Permit2 allowance approval; that separate transaction needs native ETH for gas."],
      ])}
      ${stepsList([
        "Connect your injected wallet in the Playground and switch to Robinhood Chain mainnet.",
        "Choose an enabled chat model and submit the request to receive a free exact quote.",
        "Review the quote-bound WIF amount and the receiving address in the 402 challenge.",
        "Approve Permit2 once if your wallet asks, then sign the exact per-call payment in your wallet.",
        "Receive the chat response and keep the signed Moltworld receipt for verification.",
      ])}
    `, { id: "user-wallet" })}
    ${sec(`
      ${secHead("For developers <em>building the flow.</em>")}
      <p class="lead" data-reveal>Use the free quote endpoint first, then send the identical chat body to the chat endpoint. An x402 EVM client implementing ExactEvmScheme and Permit2 creates the <code>Payment-Signature</code>; the server's 402 challenge is authoritative.</p>
      ${codeBlock(`const body = {
  messages: [{ role: "user", content: "Hello from Robinhood Chain" }],
  max_tokens: 200,
};

// Free: inspect the exact USD quote and WIF conversion snapshot.
await fetch("/v1/quote", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "gpt-4o", ...body }),
});

// 1. POST the same body to /v1/models/{model}/chat/completions.
// 2. Receive HTTP 402 and decode Payment-Required.
// 3. Let an x402 EVM ExactEvmScheme + Permit2 client sign it.
// 4. Retry the byte-for-byte identical body with Payment-Signature.
// Use an injected EIP-1193 wallet; WalletConnect is available when REOWN_PROJECT_ID is configured.`)}
      ${facts([
        ["bolt", "Live paid surface: POST /v1/models/{model}/chat/completions."],
        ["receipt", "Successful responses include Moltworld-Request-Id and a signed Moltworld-Receipt."],
        ["check", "Use /v1/models and /v1/quote for discovery and preflight; neither takes payment."],
        ["tag", marketplaceEnabled() ? "Approved marketplace APIs support WIF checkout. Agent mandates support live payments; media and automatic refunds are unavailable." : "Agent mandates support live payments. Image, voice, video, marketplace calls and automatic refunds are unavailable here."],
      ])}
    `, { id: "developer" })}
    ${sec(`
      ${secHead("Per-call signing and <em>agent mandates are live.</em>")}
      <p class="note" data-reveal>An owner-funded EIP-1271 mandate has completed a real WIF-paid task through the local MCP and live facilitator. Inspect the <a href="https://robinhoodchain.blockscout.com/tx/0x879e7e15f7b2cd4cd540f2e725ca3d3ce78ea552389588c6c95f539c35df43f3">transaction</a> and <a href="https://moltworldd.vercel.app/v1/receipts/req_uPG_4T8Lt9AlG3qS">receipt</a>. The remote MCP stays keyless; local stdio MCP uses a separate session key within the owner's contract limits. The contract has not had an independent security audit. Algorand LogicSig mandates are a separate legacy implementation.</p>
    `)}
    ${ctaFinal("Review every quote. <em>Authorize only what you intend.</em>", `${btn("/playground", "Try a chat call")}${btn("/llms.txt", "Machine-readable guide", "ghost")}`)}`;
  return renderPage(c, { path: "/quickstart", title: "WIF Quickstart", description: "Use an injected wallet or configured WalletConnect session to authorize chat-only WIF x402 payments, or integrate the exact EVM challenge as a developer.", body });
}

// ---------------------------------------------------------------------------
// Solutions
// ---------------------------------------------------------------------------

function workflowTitle(u: (typeof WORKFLOWS)[number]): string {
  if (config.paymentChain !== "robinhood") return u.title;
  const status: Record<string, string> = {
    "agent-allowance": "",
    "content-pipelines": " (not live on WIF)",
    "agent-commerce": marketplaceEnabled() ? "" : " (disabled)",
    "team-budgets": " (not live on WIF)",
  };
  return `${u.title}${status[u.slug] ?? ""}`;
}

function audienceTitle(a: (typeof AUDIENCES)[number]): string {
  return config.paymentChain === "robinhood" && !marketplaceEnabled() && a.label === "API sellers" ? "API sellers (marketplace disabled)" : a.label;
}

function solutions(c: Context) {
  const body = `
    ${pageHero({ title: "Built for agents, apps <em>and API sellers.</em>" })}
    ${sec(`${secHead("By customer.")}${linkCards(AUDIENCES.map((a) => ({ title: audienceTitle(a), href: a.href, icon: a.icon })))}`)}
    ${sec(`${secHead("By workflow.", arrowLink("/use-cases", "Use cases by agent"))}${linkCards(WORKFLOWS.map((u) => ({ title: workflowTitle(u), href: `/solutions/${u.slug}`, icon: "spark" })))}`)}
    ${ctaFinal("Start <em>in the Playground.</em>")}`;
  return renderPage(c, { path: "/solutions", title: "Solutions", description: "Moltworld for AI agents, app developers and API sellers.", body });
}

function solutionsAgents(c: Context) {
  const origin = config.publicDomain;
  const models = catalog();
  const tools: Array<[string, string]> = config.paymentChain === "robinhood"
    ? [["moltworld_quote", "Exact price of an enabled chat request"], ["moltworld_chat", "Caller-authorized WIF chat request"], ["moltworld_receipt", "Inspect a signed receipt when returned"]]
    : [["moltworld_quote", "Exact price of a request"], ["moltworld_chat", "Paid chat; unused tokens paid back"], ["moltworld_image", "Paid image; refunded on failure"], ["moltworld_speech", "Paid text-to-speech"], ["moltworld_spend", "Wallet and spend this session"]];
  const agentTabs: Array<[string, string, string, string?]> = config.paymentChain === "robinhood"
    ? [["chat", "Chat-only MCP", `// Remote MCP is keyless and does not pay.
// A caller-signed EVM x402 client authorizes enabled chat requests.
// Image, voice, video, marketplace, and autonomous mandates are unavailable.`, "sh"]]
    : [];
  const body = `
    ${pageHero({
      crumbs: [["Solutions", "/solutions"]],
      title: "Give your agent models it doesn't have, <em>with a budget.</em>",
      ctas: `${btn(`${docs()}/agents/mcp`, "Connect your agent")}${btn("/use-cases/agent-allowance", "Use case", "ghost")}`,
      visual: chatDemo(models),
    })}
    ${sec(`
      ${secHead("Two ways <em>to connect.</em>")}
      <div class="table-wrap" data-reveal><table class="stack">
        <thead><tr><th><span class="sr-only">Property</span></th><th>Remote MCP</th><th>Local MCP</th></tr></thead>
        <tbody>
          <tr><td data-label="">Address</td><td data-label="Remote"><code>${origin}/mcp</code></td><td data-label="Local"><code>moltworld-mcp</code></td></tr>
          <tr><td data-label="">Holds</td><td data-label="Remote">Nothing</td><td data-label="Local">A mandate credential and its own agent key, never the owner's key</td></tr>
          <tr><td data-label="">Can</td><td data-label="Remote">List, quote, relay requests you signed</td><td data-label="Local">Pay for chat when the caller supplies a compatible WIF authorization</td></tr>
          <tr><td data-label="">For</td><td data-label="Remote">Discovery, or a person approving each payment</td><td data-label="Local">Agents that run on their own</td></tr>
        </tbody></table></div>
    `)}
    ${sec(`
      ${secHead("Drop-in <em>configuration.</em>", arrowLink(`${docs()}/agents/mcp`, "Framework docs"))}
      <div data-reveal>${codeTabs("agents", config.paymentChain === "robinhood" ? agentTabs : [
        [
          "hermes",
          "Hermes Agent",
          `# ~/.hermes/config.yaml
mcp_servers:
  moltworld:
    command: npx
    args: ["-y", "-p", "moltworld-sdk", "moltworld-mcp"]
    env:
      MOLTWORLD_MANDATE: "<credential from createMandate()>"
      MOLTWORLD_MAX_PER_REQUEST_USD: "0.25"
      MOLTWORLD_BUDGET_USD: "5"`,
          "sh",
        ],
        [
          "openclaw",
          "OpenClaw",
          `// OpenClaw gateway config: mcp.servers
{
  "mcp": {
    "servers": {
      "moltworld": {
        "command": "npx",
        "args": ["-y", "-p", "moltworld-sdk", "moltworld-mcp"],
        "env": {
          "MOLTWORLD_MANDATE": "<credential from createMandate()>",
          "MOLTWORLD_MAX_PER_REQUEST_USD": "0.25",
          "MOLTWORLD_BUDGET_USD": "5"
        }
      },
      "moltworld-remote": { "transport": "streamable-http", "url": "${origin}/mcp" }
    }
  }
}`,
          "json",
        ],
        [
          "claude",
          "Claude Code",
          `claude mcp add --transport http moltworld ${origin}/mcp

# Paid calls with a mandate:
claude mcp add -e MOLTWORLD_MANDATE=<credential> -e MOLTWORLD_BUDGET_USD=5 \\
  moltworld-wallet -- npx -y -p moltworld-sdk moltworld-mcp`,
          "sh",
        ],
        [
          "a2a",
          "A2A",
          `# Agent card
curl -s ${origin}/.well-known/agent-card.json

# JSON-RPC endpoint
POST ${origin}/a2a`,
          "sh",
        ],
        [
          "json",
          "Any MCP client",
          `{
  "mcpServers": {
    "moltworld": { "type": "http", "url": "${origin}/mcp" },
    "moltworld-wallet": {
      "command": "npx",
      "args": ["-y", "-p", "moltworld-sdk", "moltworld-mcp"],
      "env": { "MOLTWORLD_MANDATE": "<credential>", "MOLTWORLD_BUDGET_USD": "5" }
    }
  }
}`,
          "json",
        ],
      ])}</div>
    `)}
    ${sec(`
      ${secHead("Tools <em>the agent gets.</em>")}
      <div class="table-wrap" data-reveal><table class="stack">
        <thead><tr><th>Tool</th><th>Does</th></tr></thead>
        <tbody>${tools.map(([t, d]) => `<tr><td data-label="Tool"><code>${t}</code></td><td data-label="Does">${d}</td></tr>`).join("")}</tbody>
      </table></div>
    `)}
    ${ctaFinal("Connect <em>your agent.</em>")}`;
  return renderPage(c, { path: "/solutions/agents", title: "AI agents", description: config.paymentChain === "robinhood" ? "Use Moltworld from an MCP client for chat-only WIF quotes and caller-authorized requests; owner-funded mandates support live agent payments." : "Use Moltworld from OpenClaw, Hermes Agent, Claude Code, A2A or any MCP client, with mandate spending limits.", body, data: catalogScript(models) });
}

function solutionsDevelopers(c: Context) {
  const s = snippets();
  const body = `
    ${pageHero({
      crumbs: [["Solutions", "/solutions"]],
      title: "Add AI to your app <em>without keys or plans.</em>",
      ctas: `${btn(`${docs()}/quickstart`, "Quickstart")}${btn("/playground", "Playground", "ghost")}`,
    })}
    ${sec(`
      ${secHead("Less plumbing.")}
      ${facts([
        ["layers", config.paymentChain === "robinhood" ? "Chat behind one OpenAI-style API body; image, voice, and video are not enabled on WIF." : "Chat, image, voice and video behind one API with OpenAI-style bodies."],
        ["tag", "Every call is quoted first. Set a per-request cap and a budget."],
        ["refund", config.paymentChain === "robinhood" ? "Chat payment is authorized per request; no automatic WIF media refund is live." : "Chat is charged after the answer. Failed media is refunded."],
        ["shield", "Retries return the original response, never a second charge."],
        ["receipt", "A signed receipt and transaction id for every call."],
        ["users", "Users can pay for their own calls from their own wallets."],
      ])}
    `)}
    ${sec(`<div class="dev-grid"><h2 data-split>Start <em>in a few lines.</em></h2><div data-reveal>${codeTabs("devs", [["ts", "TypeScript", s.ts], ["py", "Python", s.py], ["curl", "curl", s.curl]])}</div></div>`)}
    ${ctaFinal("Build with <em>Moltworld.</em>")}`;
  return renderPage(c, { path: "/solutions/developers", title: "App developers", description: config.paymentChain === "robinhood" ? "Add chat to an app with per-request WIF authorization on Robinhood Chain; other modalities are not enabled." : "Add chat, image and voice models to your app with per-request USDC payments and no API keys.", body });
}

function solutionsCreators(c: Context) {
  if (config.paymentChain === "robinhood" && marketplaceEnabled()) return c.redirect("/products/marketplace");
  if (config.paymentChain === "robinhood") {
    const body = `${pageHero({ crumbs: [["Solutions", "/solutions"]], title: "API sellers can prepare now. <em>Payouts are not live on WIF.</em>", ctas: `${btn("/products/marketplace", "Marketplace status")}${btn("/developers", "Developer hub", "ghost")}`, visual: splitDemo() })}${sec(`${secHead("Billing <em>is staged, not enabled.</em>")}${facts([["agent", "WIF currently supports caller-authorized chat only."], ["layers", "Marketplace listing, forwarding, reconciliation, and settlement are not verified on this rail."], ["wallet", "No creator payout, refund, buyback, or flywheel mechanism is represented as live."], ["globe", "The split visual is schematic only; it is not an earnings record."]])}`)}${sec(`${secHead("Prepare an integration <em>without submitting it.</em>")}${codeBlock("// Marketplace is disabled on Robinhood Chain.\n// Do not submit listings or assume a payout.", "sh")}`)}${ctaFinal("Keep your API ready <em>for a future rail.</em>", btn("/products/marketplace", "View marketplace status"))}`;
    return renderPage(c, { path: "/solutions/api-creators", title: "API sellers", description: "Marketplace and creator payouts are disabled on the Robinhood Chain WIF deployment.", body });
  }
  const body = `
    ${pageHero({
      crumbs: [["Solutions", "/solutions"]],
      title: `Charge per call for your API. <em>Keep ${share()}%.</em>`,
      ctas: `${btn(`${docs()}/products/marketplace`, "List your API")}${btn("/products/marketplace", "Marketplace", "ghost")}`,
      visual: splitDemo(),
    })}
    ${sec(`
      ${secHead("Billing <em>you don't build.</em>")}
      ${facts([
        ["agent", "Any x402 client or MCP agent can buy from you."],
        ["layers", "Quotes, payment, settlement and receipts are handled."],
        ["key", "Every forwarded request is HMAC-signed."],
        ["check", "Buyers are charged only when you answer 2xx."],
        ["wallet", `USDC payouts to your wallet from $${config.creatorPayoutMinUsd}.`],
        ["globe", "Listed where agents already look: HTTP, MCP and A2A."],
      ])}
    `)}
    ${sec(`
      ${secHead("Verify <em>Moltworld's signature.</em>")}
      <div data-reveal>${codeBlock(`import crypto from "crypto";

// X-Moltworld-Timestamp, X-Moltworld-Request-Id, X-Moltworld-Signature
function fromMoltworld(req, rawBody, signingSecret) {
  const ts = req.headers["x-moltworld-timestamp"];
  const id = req.headers["x-moltworld-request-id"];
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const expected = crypto.createHmac("sha256", signingSecret)
    .update(\`\${ts}.\${id}.\${bodyHash}\`).digest("base64url");
  return Math.abs(Date.now() / 1000 - Number(ts)) < 300 &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-moltworld-signature"]));
}`)}</div>
    `)}
    ${ctaFinal("List your <em>first API.</em>")}`;
  return renderPage(c, { path: "/solutions/api-creators", title: "API sellers", description: "Sell your API per call to apps and agents, paid in USDC through Moltworld.", body });
}

// ---------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------

interface UseCaseDetail {
  problem: string;
  how: string[];
  code: string;
  products: Array<[string, string]>;
}

function useCaseDetails(): Record<string, UseCaseDetail> {
  const origin = config.publicDomain;
  return {
    "agent-allowance": {
      problem:
        "Personal agents like OpenClaw and Hermes Agent run all day on one model and one subscription. When a task needs an image, a voice reply or a stronger model, you either hand the agent an API key with no limit, or the task fails.",
      how: [
        "Create a mandate: $0.25 per call, $5 a day, chosen models, 30 days.",
        "Give the agent the credential. It contains no private key.",
        "The agent adds Moltworld as an MCP server and pays as it goes.",
        "Every call returns a receipt. Revoke the mandate any time.",
      ],
      code: `// On the agent: npx -y -p moltworld-sdk moltworld-mcp keygen  ->  agent address
const { credential } = await createMandate("${origin}", owner, {
  agent: agentAddress, maxPerCallUsd: 0.25, dailyCapUsd: 5, validDays: 30,
});
// Give MOLTWORLD_MANDATE=<credential> to the agent's MCP server.`,
      products: [["Mandates", "/products/mandates"], ["AI agents", "/solutions/agents"]],
    },
    "model-escalation": {
      problem:
        "Running every step of an agent or app on a frontier model is expensive, and paying for a second subscription to use one occasionally is wasteful.",
      how: [
        "Run the normal workload on a cheap model, or your own.",
        "Send only the hard step to a frontier model through Moltworld.",
        "Quote it first, then pay for that one call.",
        "Unused max_tokens budget is paid back.",
      ],
      code: `const quote = await client.quote("gpt-5.4-pro", body);
if (quote.microUsdc < 200_000) {
  const res = await client.chat("gpt-5.4-pro", body);
}`,
      products: [["Gateway", "/products/gateway"], ["Models", "/models"]],
    },
    "content-pipelines": {
      problem:
        "Content workflows need several models: an image model for the thumbnail, a voice model for narration, an image model for the hero asset. Each usually means a separate account and subscription.",
      how: [
        "Script, image and voice-over through one API.",
        "Use GPT Image 1.5 for the hero asset.",
        "Failed or unfinished generations are refunded on-chain.",
        "Receipts give a cost record per asset.",
      ],
      code: `const image = await client.image("gpt-image-1.5", { prompt });
const voice = await client.speech("tts-1-hd", { input: script });`,
      products: [["Gateway", "/products/gateway"], ["Receipts", "/products/receipts"]],
    },
    "agent-commerce": {
      problem:
        "Agents increasingly call other agents and specialised APIs, but there's no simple way for an agent to pay another service per call, or for a builder to charge for one.",
      how: [
        "List your API or agent skill with a price per call.",
        "Other agents pay through the same x402 flow as model calls.",
        "Your endpoint receives signed requests and answers as usual.",
        "Your share arrives in batched on-chain payouts.",
      ],
      code: `// Buyer side: the same client that pays for models
const res = await client.market("weather-now", { city: "Lagos" });`,
      products: [["Marketplace", "/products/marketplace"], ["API sellers", "/solutions/api-creators"]],
    },
    "team-budgets": {
      problem:
        "Teams running several agents, or giving staff AI tools, need to know who spent what and to stop runaway spend, without sharing one API key.",
      how: [
        "One mandate per agent or person, each with its own limits.",
        "Payments come from the team wallet, tracked per mandate.",
        "Receipts and the mandate lookup show who spent what.",
        "Revoke a mandate when an agent retires or someone leaves.",
      ],
      code: `for (const member of team) {
  await createMandate("${origin}", teamWallet, {
    agent: member.agentAddress, // each agent's own key, from moltworld-mcp keygen
    maxPerCallUsd: 0.5, dailyCapUsd: member.dailyBudget,
    allowedModels: member.models, label: member.name,
  });
}`,
      products: [["Mandates", "/products/mandates"], ["Receipts", "/products/receipts"]],
    },
  };
}

function agentCard(t: ReturnType<typeof agentTypes>[number]): string {
  return `<a class="uc" href="/use-cases/${t.slug}"><span class="uc-ic">${icon(t.icon, 22)}</span><h3>${esc(t.short)}</h3><span class="uc-examples">${t.examples.map(esc).join(" &middot; ")}</span><span class="go">${icon("arrow", 16)}</span></a>`;
}

function useCases(c: Context) {
  const mandatesLabel = config.paymentChain === "robinhood" ? "Live mandates" : "Mandates";
  const body = `
    ${pageHero({ title: "Every kind of agent. <em>One wallet.</em>", ctas: `${btn(`${docs()}/agents/mcp`, "Connect an agent")}${btn("/products/mandates", mandatesLabel, "ghost")}` })}
    ${sec(`<div class="uc-grid" data-reveal>${agentTypes().map(agentCard).join("")}</div>`, { line: false })}
    ${sec(`${secHead("By workflow.")}${linkCards(WORKFLOWS.map((u) => ({ title: workflowTitle(u), href: `/solutions/${u.slug}`, icon: "spark" })))}`)}
    ${ctaFinal("Price your <em>first request.</em>")}`;
  return renderPage(c, { path: "/use-cases", title: "Use cases", description: "How every kind of agent uses Moltworld: personal, coding, knowledge-work, computer-use, multi-agent, media and voice agents, self-hosted or in the cloud.", body });
}

/** First step for any agent that pays under a mandate: its own key, created where it runs. */
const AGENT_KEY_STEP: [string, string, string, string] = [
  "key",
  "Agent key",
  `# Once, where the agent runs. The key never leaves this machine.
npx -y -p moltworld-sdk moltworld-mcp keygen
# Prints the agent's address: give it to the wallet owner, who binds a mandate to it.
# The resulting credential goes in MOLTWORLD_MANDATE below; it can't pay without this key.`,
  "sh",
];

function agentPage(slug: string) {
  return (c: Context) => {
    const t = agentTypes().find((a) => a.slug === slug)!;
    const workflow = WORKFLOWS.find((w) => w.slug === t.workflow);
    const others = agentTypes().filter((a) => a.slug !== slug).slice(0, 3);
    const robinhood = config.paymentChain === "robinhood";
    const connects = robinhood ? t.connect.map(([agent, how]) => [agent, how, "quotes"] as [string, string, "quotes"]) : t.connect;
    const configs = robinhood ? [["chat", "Chat-only flow", `// WIF deployment: use remote MCP for discovery and quotes.
// A compatible EVM x402 client must authorize each enabled chat request.
// Image, voice, video, marketplace, and autonomous mandates are unavailable.`, "sh"] as [string, string, string, string]] : t.configs;
    const detailFacts = robinhood ? [["tag", "Robinhood Chain currently supports chat-only WIF checkout."], ["wallet", "A caller-controlled EVM wallet authorizes the exact quote-bound payment."], ["receipt", "Keep the signed receipt returned by a completed paid chat request."], ["shield", "Owner-funded mandates support live payments. Marketplace APIs require enabled checkout and approved listings; media is unavailable."]] as Array<[string, string]> : t.facts;
    const body = `
      ${pageHero({
        crumbs: [["Use cases", "/use-cases"]],
        title: robinhood ? "Chat agents <em>with caller-authorized WIF.</em>" : t.title,
        ctas: `${btn(robinhood ? "/playground" : "/products/mandates", robinhood ? "Try chat checkout" : "Create a mandate")}${btn(`${docs()}/agents/mcp`, "MCP docs", "ghost")}`,
        visual: `<ul class="example-list">${t.examples.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`,
      })}
      ${sec(`
        ${secHead("How it <em>connects.</em>")}
        <div class="table-wrap" data-reveal><table class="stack">
          <thead><tr><th>Agent</th><th>Connects with</th><th>Pays</th></tr></thead>
          <tbody>${connects.map(([agent, how, pays]) => `<tr><td data-label="Agent">${esc(agent)}</td><td data-label="Connects with">${esc(how)}</td><td data-label="Pays"><span class="pays pays-${pays}">${esc(PAYS_LABEL[pays])}</span></td></tr>`).join("")}</tbody>
        </table></div>
      `)}
      ${sec(`<div class="dev-grid"><h2 data-split>Set it <em>up.</em></h2><div data-reveal>${codeTabs("agent", configs)}</div></div>`)}
      ${sec(`
        ${secHead("Why it <em>fits.</em>", workflow ? arrowLink(`/solutions/${workflow.slug}`, esc(workflow.short)) : "")}
        ${facts(detailFacts)}
      `)}
      ${sec(`${secHead("More <em>agents.</em>", arrowLink("/use-cases", "All use cases"))}<div class="uc-grid">${others.map(agentCard).join("")}</div>`)}
      ${ctaFinal("Connect <em>your agent.</em>", `${btn(`${docs()}/agents/mcp`, "Connect an agent")}${btn("/playground", "Playground", "ghost")}`)}`;
    return renderPage(c, { path: `/use-cases/${slug}`, title: t.short, description: t.summary, body });
  };
}

function workflowPage(slug: string) {
  return (c: Context) => {
    const meta = WORKFLOWS.find((u) => u.slug === slug)!;
    const detail = useCaseDetails()[slug];
    const robinhood = config.paymentChain === "robinhood";
    const problem = robinhood ? "This workflow is illustrative on the Robinhood Chain deployment. Chat settlement has live proof. Marketplace checkout uses approved real APIs when enabled; media remains unavailable and creator sales still need live validation." : detail.problem;
    const how = robinhood ? ["Use the Playground or a compatible EVM x402 client for an enabled chat model.", "Review the exact USD quote and quote-bound WIF amount before authorizing.", "Keep the signed receipt returned by a completed paid chat request.", marketplaceEnabled() ? "Use approved marketplace listings for paid API calls or a funded mandate for agent payments." : "Use a funded mandate for agent payments. Marketplace actions are disabled here."] : detail.how;
    const code = robinhood ? "// WIF deployment: chat-only paid surface\n// Request a free quote, then authorize the exact x402 EVM challenge.\n// Marketplace: /v1/market (when enabled). Owner-funded agent mandates are live." : detail.code;
    const body = `
      ${pageHero({ crumbs: [["Solutions", "/solutions"]], title: esc(meta.title), ctas: detail.products.map(([label, href], i) => btn(href, esc(label), i ? "ghost" : "primary")).join("") })}
      ${sec(`
        <div class="dev-grid">
          <div class="prose" data-reveal>
            <p class="problem-text">${esc(problem)}</p>
            <ol>${how.map((step) => `<li>${esc(step)}</li>`).join("")}</ol>
          </div>
          <div data-reveal style="--d:1">${codeBlock(code)}</div>
        </div>
      `, { line: false })}
      ${sec(`${secHead("More <em>workflows.</em>")}${linkCards(WORKFLOWS.filter((u) => u.slug !== slug).slice(0, 3).map((u) => ({ title: u.title, href: `/solutions/${u.slug}`, icon: "spark" })))}`)}
      ${ctaFinal("Try it <em>yourself.</em>")}`;
    return renderPage(c, { path: `/solutions/${slug}`, title: meta.title, description: meta.summary, body });
  };
}

// ---------------------------------------------------------------------------
// Playground and live network
// ---------------------------------------------------------------------------

function playground(c: Context) {
  const models = catalog();
  const body = `
    ${pageHero({ title: config.paymentChain === "robinhood" ? "Run a chat model. <em>Pay per request in WIF.</em>" : "Run any model. <em>Pay per request.</em>" })}
    <section class="sec" style="padding-top:48px"><div class="wrap">${quoteWidget()}</div></section>
    ${sec(`${secHead("Verify <em>a receipt.</em>", arrowLink("/.well-known/moltworld-receipts.json", "Signing keys"))}${receiptWidget()}`, { id: "verify" })}`;
  return renderPage(c, {
    path: "/playground",
    title: "Playground",
    description: config.paymentChain === "robinhood"
      ? "Run an eligible Moltworld chat model with an x402 WIF payment from an EVM wallet on Robinhood Chain; image, voice, and video are not enabled on this rail. Verify the signed receipt in your browser."
      : "Run any Moltworld model with a real x402 payment from your Algorand wallet or an agent mandate, with the receipt verified in your browser. Quotes and 402 challenges are free.",
    body,
    data: catalogScript(models) + payConfigScript(),
  });
}

function usage(c: Context) {
  const body = `
    ${pageHero({
      title: config.paymentChain === "robinhood" ? "WIF payments <em>from the gateway ledger.</em>" : "Usage from <em>the public ledger.</em>",
      ctas: config.paymentChain === "robinhood" ? undefined : `<a class="btn btn-ghost" href="https://facilitator.goplausible.xyz/dashboard/merchants/414f1538ce0d6de4" target="_blank" rel="noopener" style="max-width:100%;white-space:normal;text-align:center">Facilitator dashboard ${icon("arrow", 16)}</a>`,
    })}
    ${config.paymentChain === "robinhood" ? `<p class="note">Dashboard USD values are quote-time estimates for WIF requests, not a live mark-to-market total. Only chat checkout is active; refunds after a confirmed WIF settlement require manual review.</p>` : ""}
    <section class="sec" style="padding-top:56px"><div class="wrap">
      ${statsWidget()}
      <dl class="kv-list" style="margin-top:40px" data-reveal>
        <dt>Gross</dt><dd id="sGross">-</dd>
        <dt>Rebated</dt><dd id="sRebated">-</dd>
      </dl>
    </div></section>
    ${config.paymentChain === "robinhood" ? `
      ${sec(`
        ${secHead("Network <em>mix.</em>")}
        <div class="table-wrap" data-reveal><table class="stack">
          <thead><tr><th>Network</th><th>Settles</th><th>Quoted volume (USD)</th><th>Share</th></tr></thead>
          <tbody><tr><td data-label="Network">Robinhood Chain ${config.isMainnet ? "Mainnet" : "Testnet"}</td><td data-label="Settles" id="networkSettles">-</td><td data-label="Quoted volume" id="networkVolume">-</td><td data-label="Share" id="networkShare">-</td></tr></tbody>
        </table></div>
      `)}
      ${sec(`
        ${secHead("Every <em>endpoint.</em>")}
        <div class="table-wrap" data-reveal><table class="stack">
          <thead><tr><th>Endpoint group</th><th>Type</th><th>Settles</th><th>Quoted volume (USD)</th><th>Price detail</th></tr></thead>
          <tbody id="topModelRows"><tr><td colspan="5">Loading from the gateway ledger</td></tr></tbody>
        </table></div>
        <p class="note">Only aggregate chat totals are published on this WIF deployment; per-model volume breakdown is not currently exposed.</p>
      `)}
      ${sec(`
        ${secHead("Marketplace listings.")}
        <p class="note">${marketplaceEnabled() ? 'Marketplace listings and creator balances are available on the marketplace page. Payouts are marked sent after on-chain verification. Separate marketplace volume metrics are not published.' : 'Marketplace listings, creator balances, and payouts are disabled on WIF. No listing volume is reported.'}</p>
      `)}
    ` : `<div id="facilitatorOnly" hidden>
      ${sec(`
        ${secHead("Network <em>mix.</em>")}
        <div class="table-wrap" data-reveal><table class="stack">
          <thead><tr><th>Network</th><th>Settles</th><th>Volume (USDC)</th><th>Share</th></tr></thead>
          <tbody id="networkRows"></tbody>
        </table></div>
      `)}
    </div>
    ${sec(`
      ${secHead("Every <em>endpoint.</em>")}
      <div class="filters" id="endpointFilters" role="group" aria-label="Filter by type" hidden></div>
      <div class="table-wrap" data-reveal><table class="stack">
        <thead><tr><th>Model</th><th>Type</th><th>Settles</th><th>Volume (USDC)</th><th>Price</th></tr></thead>
        <tbody id="topModelRows"><tr><td colspan="5">Loading</td></tr></tbody>
      </table></div>
    `)}
    <div id="listingOnly" hidden>
      ${sec(`
        ${secHead("Listing.")}
        <dl class="kv-list" id="listingList" data-reveal></dl>
      `)}
    </div>`}
    ${sec(`
      ${secHead("Recent <em>settlements.</em>")}
      <div class="table-wrap" data-reveal><table class="stack">
        <thead><tr><th>When</th><th>Model</th><th>Amount</th><th>Transaction</th></tr></thead>
        <tbody id="recentRows"><tr><td colspan="4">Loading</td></tr></tbody>
      </table></div>
    `)}`;
  return renderPage(c, {
    path: "/stats",
    title: "Live network",
    description: config.paymentChain === "robinhood"
      ? "Robinhood Chain WIF settlement records from the Moltworld gateway ledger, with Blockscout transaction links and USD quote estimates."
      : "Moltworld usage from the public ledger, cross-checked with the x402 facilitator, with on-chain transaction links.",
    body,
  });
}

/** Registers every page route and the shared assets. */
export function registerSite(app: Hono): string[] {
  const pages: Record<string, (c: Context) => Response> = {
    "/": home,
    "/products": products,
    "/products/gateway": gateway,
    "/models": modelsPage,
    "/products/mandates": mandates,
    "/products/marketplace": marketplace,
    "/products/receipts": receipts,
    "/pricing": pricing,
    "/quickstart": quickstart,
    "/developers": developers,
    "/solutions": solutions,
    "/solutions/agents": solutionsAgents,
    "/solutions/developers": solutionsDevelopers,
    "/solutions/api-creators": solutionsCreators,
    "/use-cases": useCases,
    "/playground": playground,
    "/stats": usage,
  };
  for (const w of WORKFLOWS) pages[`/solutions/${w.slug}`] = workflowPage(w.slug);
  for (const t of agentTypes()) pages[`/use-cases/${t.slug}`] = agentPage(t.slug);
  for (const [path, handler] of Object.entries(pages)) app.get(path, handler);
  // Workflows moved from /use-cases to /solutions; keep old links working.
  for (const w of WORKFLOWS) app.get(`/use-cases/${w.slug}`, (c) => c.redirect(`/solutions/${w.slug}`, 301));
  for (const name of ASSET_NAMES) app.get(`/assets/${name}`, handleAsset(name));
  return Object.keys(pages);
}
