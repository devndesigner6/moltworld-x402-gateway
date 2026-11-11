import { config } from "../config.js";
import { defaultModelRegistry, getModelEndpoint, ModelDefinition } from "../models/registry.js";
import { quoteRequest, referenceRequest } from "../pricing/index.js";
import { defaultProviderRegistry } from "../providers/index.js";
import { icon } from "./icons.js";
import { esc, scriptJson } from "./layout.js";
import { PROVIDER_LOGOS } from "./logos.js";

const MODALITIES = ["chat", "image", "voice", "video"];

export function catalog() {
  return defaultModelRegistry
    .getEnabledModels()
    .filter((m) => defaultProviderRegistry.supports(m))
    .filter((m) => config.paymentChain !== "robinhood" || m.modality === "chat")
    .map((m: ModelDefinition) => ({
      slug: m.slug,
      name: m.displayName,
      modality: m.modality,
      provider: m.provider,
      vendor: m.tags.find((t) => !MODALITIES.includes(t)) ?? m.provider,
      upstream: m.upstreamModelId,
      endpoint: getModelEndpoint(m),
      from: quoteRequest(m, referenceRequest(m)).formattedPrice,
      flow: m.modality === "chat" ? "authorization" : "upfront",
      maxOutput: m.limits.maxOutputTokens ?? null,
      maxImages: m.limits.maxImages ?? 1,
      sizes: m.image?.sizes ?? null,
      durations: m.video?.durations ?? null,
      ratios: m.video?.aspectRatios ?? null,
      voices: m.voices ?? null,
    }));
}

export type CatalogEntry = ReturnType<typeof catalog>[number];

export function catalogScript(models: CatalogEntry[]): string {
  return `<script id="catalog" type="application/json">${scriptJson(models)}</script>`;
}

export function modalityCounts(models: CatalogEntry[]) {
  const counts: Record<string, number> = { chat: 0, image: 0, voice: 0, video: 0 };
  for (const m of models) counts[m.modality]++;
  return counts;
}

export const MODALITY_LABEL: Record<string, string> = { chat: "Chat", image: "Image", voice: "Voice", video: "Video" };

export function logo(key: string): string {
  const l = PROVIDER_LOGOS[key];
  if (!l) return icon("models");
  return `<svg viewBox="${l.viewBox}" fill="currentColor" aria-hidden="true">${l.body}</svg>`;
}

export function vendorName(key: string): string {
  return PROVIDER_LOGOS[key]?.name ?? key;
}

/** Labs behind the catalog, most models first. */
export function vendors(models: CatalogEntry[]): string[] {
  const n = new Map<string, number>();
  for (const m of models) n.set(m.vendor, (n.get(m.vendor) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

/** An endlessly scrolling row. The content is repeated so the loop has no seam. */
export function marquee(items: string, opts: { reverse?: boolean; speed?: number; label?: string } = {}): string {
  const style = opts.speed ? ` style="--speed:${opts.speed}s"` : "";
  return `<div class="marquee${opts.reverse ? " reverse" : ""}" data-clip${style}${opts.label ? ` aria-label="${esc(opts.label)}"` : ""}>
      <div class="marquee-track">${items}</div><div class="marquee-track" aria-hidden="true">${items}</div>
    </div>`;
}

export function logoBand(models: CatalogEntry[]): string {
  const items = vendors(models)
    .map((v) => `<span class="logo">${logo(v)}${esc(vendorName(v))}</span>`)
    .join("");
  return `<div class="logo-band" data-reveal>${marquee(items, { label: "Labs whose models are sold here" })}</div>`;
}

export function modelPill(m: CatalogEntry): string {
  return `<a class="mpill dot-${m.modality}" href="/playground?model=${encodeURIComponent(m.slug)}"><span class="lg">${logo(m.vendor)}</span><span><span class="nm">${esc(m.name)}</span><br><span class="pr">from ${esc(m.from)}</span></span><span class="md" title="${MODALITY_LABEL[m.modality]}"></span></a>`;
}

export function modelRails(models: CatalogEntry[]): string {
  const rows = [models.filter((_, i) => i % 3 === 0), models.filter((_, i) => i % 3 === 1), models.filter((_, i) => i % 3 === 2)];
  return `<div class="model-rails">${rows
    .filter((r) => r.length)
    .map((r, i) => marquee(r.map(modelPill).join(""), { reverse: i % 2 === 1, speed: 60 + i * 12 }))
    .join("")}</div>`;
}

export function catalogWidget(models: CatalogEntry[], paymentChain: typeof config.paymentChain = config.paymentChain): string {
  const counts = modalityCounts(models);
  const cards = models
    .map(
      (m) => `
        <li class="model" data-modality="${m.modality}" data-search="${esc(`${m.name} ${m.slug} ${m.upstream} ${m.provider} ${vendorName(m.vendor)}`.toLowerCase())}">
          <div class="model-top">
            <div class="model-id"><span class="lg">${logo(m.vendor)}</span><div><h3>${esc(m.name)}</h3><span class="vendor">${esc(vendorName(m.vendor))} &middot; ${esc(m.provider)}</span></div></div>
            <span class="price" title="Price of a small reference request">from ${esc(m.from)}</span>
          </div>
          <div class="chips">
            <span class="chip dot-${m.modality}"><i></i>${MODALITY_LABEL[m.modality]}</span>
            <span class="chip" title="Upstream model id">${esc(m.upstream)}</span>
          </div>
          <button type="button" class="endpoint" data-copy="${esc(`${config.publicDomain}${m.endpoint}`)}" aria-label="Copy ${esc(m.name)} endpoint URL"><span>POST ${esc(m.endpoint)}</span>${icon("copy", 14)}</button>
          <div class="model-actions">
            <a class="btn btn-small" href="/playground?model=${encodeURIComponent(m.slug)}" aria-label="Try ${esc(m.name)} in the Playground">Try ${icon("arrow", 14)}</a>
          </div>
        </li>`
    )
    .join("");
  const tab = (key: string, label: string, n: number, pressed = false) =>
    `<button class="tab${key === "all" ? "" : ` dot-${key}`}" type="button" data-filter="${key}" aria-pressed="${pressed}">${key === "all" ? "" : "<i></i>"}${label} (${n})</button>`;
  const unavailableTabs = paymentChain === "robinhood"
    ? MODALITIES.filter((key) => counts[key] === 0).map((key) => `<button class="tab dot-${key}" type="button" disabled aria-disabled="true" title="${MODALITY_LABEL[key]} is not enabled on Robinhood Chain"><i></i>${MODALITY_LABEL[key]} (not live on WIF)</button>`).join("")
    : "";
  return `
      <div class="filters" role="group" aria-label="Filter by modality">
        ${tab("all", "All", models.length, true)}${MODALITIES.filter(k => counts[k] > 0).map((k) => tab(k, MODALITY_LABEL[k], counts[k])).join("")}${unavailableTabs}
        <label class="sr-only" for="search">Search models</label>
        <input id="search" type="search" placeholder="Search models, labs or upstream ids">
      </div>
      <ul class="models" id="modelList" data-page="12">${cards}</ul>
      <p class="note hidden" id="noModels">No models match.</p>
      <div class="more"><button class="btn btn-ghost" type="button" id="moreBtn">Show more</button></div>`;
}

// ---------------------------------------------------------------- code

const KEYWORDS = new Set("import from const let var await async new return if else for of in function export print def class true false null None True False await with as try catch".split(" "));

/** Minimal syntax colouring: comments, strings, numbers, keywords and calls. */
export function highlight(code: string, lang = "ts"): string {
  const comment = lang === "ts" || lang === "json" ? String.raw`\/\/[^\n]*` : String.raw`#[^\n]*`;
  const strings = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` + "`[^`]*`";
  const re = new RegExp(String.raw`(${comment})|(${strings})|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)`, "g");
  let out = "";
  let last = 0;
  for (const m of code.matchAll(re)) {
    out += esc(code.slice(last, m.index));
    const [tok, c, s, n, f, w] = m;
    if (c) out += `<span class="tk-c">${esc(c)}</span>`;
    else if (s) out += `<span class="tk-s">${esc(s)}</span>`;
    else if (n) out += `<span class="tk-n">${esc(n)}</span>`;
    else if (f) out += KEYWORDS.has(f) ? `<span class="tk-k">${esc(f)}</span>` : `<span class="tk-f">${esc(f)}</span>`;
    else if (w) out += KEYWORDS.has(w) ? `<span class="tk-k">${esc(w)}</span>` : esc(w);
    else out += esc(tok);
    last = m.index! + tok.length;
  }
  return out + esc(code.slice(last));
}

const LANG: Record<string, string> = { ts: "ts", curl: "sh", py: "py", json: "json" };

/** A tabbed code block with a copy button. Each tab is [id, label, code, lang?]. */
export function codeTabs(name: string, tabs: Array<[string, string, string, string?]>): string {
  const buttons = tabs
    .map(
      ([id, label], i) =>
        `<button role="tab" type="button" id="t-${name}-${id}" aria-controls="p-${name}-${id}" aria-selected="${i === 0}"${i ? ' tabindex="-1"' : ""}>${esc(label)}</button>`
    )
    .join("");
  const panels = tabs
    .map(([id, , code, lang], i) => `<div role="tabpanel" id="p-${name}-${id}" aria-labelledby="t-${name}-${id}"${i ? " hidden" : ""}><pre><code>${highlight(code, lang ?? LANG[id] ?? "sh")}</code></pre></div>`)
    .join("");
  return `<div class="code-card"><div class="code-top"><div role="tablist" aria-label="Code examples">${buttons}</div><button type="button" class="icon-btn" data-copy-tabs="${name}" aria-label="Copy code">${icon("copy", 16)}</button></div>${panels}</div>`;
}

export function codeBlock(code: string, lang = "ts"): string {
  return `<pre class="code"><code>${highlight(code, lang)}</code></pre>`;
}

// ---------------------------------------------------------------- live widgets

/** Who pays for runs: a connected wallet, or an agent mandate that signs within its on-chain limits. */
export function payerWidget(paymentChain: typeof config.paymentChain = config.paymentChain): string {
  const dev = config.playgroundDev;
  if (paymentChain === "robinhood") {
    return `
      <div class="card payer" id="payer">
        <div class="payer-modes" role="group" aria-label="Pay with">
          <button class="tab" type="button" data-payer-mode="wallet" aria-pressed="true">${icon("wallet", 16)}Wallet</button>
          <a class="tab" href="/products/mandates" title="Live WIF mandates with owner-controlled spending limits">${icon("mandate", 16)}Live mandates</a>
        </div>
        <div class="payer-pane" data-pane="wallet">
          <div class="wallet-list" id="walletList"><button class="btn btn-ghost btn-small wallet-btn" type="button" id="walletLoad" aria-label="Connect MetaMask" title="Connect MetaMask directly"><img src="/assets/wallets/metamask.png" alt="" width="18" height="18">Connect MetaMask</button></div>
          <div class="payer-active hidden" id="walletActive"><span class="pulse" aria-hidden="true"></span><span class="mono" id="walletAddr"></span><span class="mono" id="walletBal"></span><button class="btn btn-ghost btn-small" type="button" id="walletOff">Disconnect</button></div>
        </div>
        <div class="payer-cap"><label for="capInput">Max per request (USD)</label><input id="capInput" type="number" min="0.001" step="0.01" value="1" inputmode="decimal"></div>
      </div>`;
  }
  return `
      <div class="card payer" id="payer">
        <div class="payer-modes" role="group" aria-label="Pay with">
          <button class="tab" type="button" data-payer-mode="wallet" aria-pressed="true">${icon("wallet", 16)}Wallet</button>
          <button class="tab" type="button" data-payer-mode="mandate" aria-pressed="false">${icon("mandate", 16)}Mandate</button>
        </div>
        <div class="payer-pane" data-pane="wallet">
          <div class="wallet-list" id="walletList"><button class="btn btn-ghost btn-small" type="button" id="walletLoad">Connect wallet</button></div>
          <div class="payer-active hidden" id="walletActive"><span class="pulse" aria-hidden="true"></span><span class="mono" id="walletAddr"></span><span class="mono" id="walletBal"></span><button class="btn btn-ghost btn-small" type="button" id="walletOff">Disconnect</button></div>
        </div>
        <div class="payer-pane hidden" data-pane="mandate">
          <div class="mandate-entry" id="mandateEntry">
            <span class="agent-chip" id="agentChip" title="This browser's agent key. Bind a mandate to this address."><span class="mono" id="agentAddr"></span><button type="button" class="icon-btn" id="agentCopy" aria-label="Copy this browser's agent address">${icon("copy", 14)}</button></span>
            <label class="sr-only" for="mandateCred">Mandate credential</label>
            <input id="mandateCred" autocomplete="off" spellcheck="false" placeholder="MOLTWORLD_MANDATE credential">
            <button class="btn btn-ghost btn-small" type="button" id="mandateUse">Use</button>
            ${dev.mandate ? `<button class="btn btn-ghost btn-small" type="button" id="mandateDev">Local dev mandate</button>` : ""}
          </div>
          <div class="payer-active hidden" id="mandateActive"><span class="pulse" aria-hidden="true"></span><span class="mono" id="mandateOwner"></span><span class="mono" id="mandateLimits"></span><button class="btn btn-ghost btn-small" type="button" id="mandateOff">Remove</button></div>
        </div>
        <div class="payer-cap">
          <label for="capInput">Max per request</label>
          <input id="capInput" type="number" min="0.001" step="0.01" value="1" inputmode="decimal">
        </div>
      </div>`;
}

/** What the browser client needs to build payments on this gateway's network. */
export function payConfigScript(): string {
  const dev = config.playgroundDev;
  return `<script id="payConfig" type="application/json">${scriptJson({
    paymentChain: config.paymentChain,
    network: config.isMainnet ? "mainnet" : "testnet",
    chainId: config.paymentChain === "robinhood" ? (config.isMainnet ? 4663 : 46630) : undefined,
    paymentAssetAddress: config.paymentAssetAddress,
    paymentAssetSymbol: config.paymentAssetSymbol,
    paymentAssetDecimals: config.paymentAssetDecimals,
    reownProjectId: config.paymentChain === "robinhood" ? config.reownProjectId : undefined,
    robinhoodRpcUrl: config.paymentChain === "robinhood" ? config.robinhoodRpcUrl : undefined,
    usdcAssetId: Number(config.usdcAsaId),
    algodUrl: config.publicAlgodUrl || undefined,
    ...(config.paymentChain === "algorand" ? { devWalletKey: dev.walletKey, devMandate: dev.mandate, devAgentKey: dev.agentKey } : {}),
  })}</script>`;
}

export function quoteWidget(): string {
  const snippetTabs = [["mcp", "MCP", "snipMcp"], ["curl", "curl", "snipCurl"], ["ts", "TypeScript", "snipTs"], ["py", "Python", "snipPy"]];
  const tabButtons = snippetTabs.map(([id, label], index) => `<button role="tab" type="button" id="t-snip-${id}" aria-controls="p-snip-${id}" aria-selected="${index === 0}"${index ? ' tabindex="-1"' : ""}>${label}</button>`).join("");
  const tabPanels = snippetTabs.map(([id, , codeId], index) => `<div role="tabpanel" id="p-snip-${id}" aria-labelledby="t-snip-${id}"${index ? " hidden" : ""}><pre><code id="${codeId}"></code></pre></div>`).join("");
  return `
      ${payerWidget()}
      <div class="grid-2">
        <form class="card" id="quoteForm" novalidate>
          <label for="qModel" style="margin-top:0">Model</label>
          <select id="qModel" name="model"></select>
          <div data-for="chat">
            <label for="qMessage">Message</label>
            <textarea id="qMessage" maxlength="32000">${config.paymentChain === "robinhood" ? "Explain how x402 payments work on Robinhood Chain in two sentences." : "Explain how x402 payments work on Algorand in two sentences."}</textarea>
            <label for="qMaxTokens">max_tokens <span class="note" id="qMaxNote"></span></label>
            <input id="qMaxTokens" type="number" min="1" value="300" inputmode="numeric">
          </div>
          <div data-for="image" class="hidden">
            <label for="qPrompt">Prompt</label>
            <textarea id="qPrompt">A lighthouse on a cliff at dawn, watercolor</textarea>
            <div class="row">
              <div><label for="qN">Images</label><select id="qN"></select></div>
              <div><label for="qSize">Size</label><select id="qSize"></select></div>
            </div>
          </div>
          <div data-for="voice" class="hidden">
            <label for="qInput">Text to speak</label>
            <textarea id="qInput">${config.paymentChain === "robinhood" ? "Welcome to Moltworld, pay-per-request AI on Robinhood Chain." : "Welcome to Moltworld, pay-per-request AI on Algorand."}</textarea>
            <div id="qVoiceWrap"><label for="qVoice">Voice</label><select id="qVoice"></select></div>
          </div>
          <div data-for="video" class="hidden">
            <label for="qVideoPrompt">Prompt</label>
            <textarea id="qVideoPrompt">Slow aerial shot over ocean waves at sunset</textarea>
            <div class="row">
              <div><label for="qDuration">Duration</label><select id="qDuration"></select></div>
              <div><label for="qRatio">Aspect ratio</label><select id="qRatio"></select></div>
            </div>
          </div>
          <div class="actions">
            <button class="btn" type="button" id="runBtn">Run<span class="run-price" id="runPrice"></span> ${icon("arrow", 16)}</button>
            <button class="btn btn-ghost" type="submit" id="quoteBtn">Get price</button>
            <button class="btn btn-ghost" type="button" id="challengeBtn">402 response</button>
          </div>
        </form>
        <div class="card pg-out hidden" aria-live="polite" id="runOut"></div>
        <div class="card pg-out" aria-live="polite" id="quoteOut"></div>
      </div>
      <div class="code-card" style="margin-top:16px">
        <div class="code-top">
          <div role="tablist" aria-label="Request code">
            ${tabButtons}
          </div>
          <button type="button" class="icon-btn" data-copy-tabs="snip" aria-label="Copy code">${icon("copy", 16)}</button>
        </div>
        ${tabPanels}
      </div>`;
}

export function receiptWidget(): string {
  return `
      <form class="card" id="receiptForm" novalidate>
        <label for="receiptInput" style="margin-top:0">Request id or receipt JSON</label>
        <textarea id="receiptInput" spellcheck="false" placeholder="req_... or {&quot;v&quot;:1,&quot;kid&quot;:...}"></textarea>
        <div class="actions"><button class="btn" type="submit">Verify ${icon("check", 16)}</button></div>
        <div class="result" id="receiptOut" aria-live="polite"></div>
      </form>`;
}

export function mandateLookupWidget(): string {
  return `
      <form class="card" id="mandateForm" novalidate>
        <h3>Look up a mandate</h3>
        <label for="mandateQuery">Mandate id or owner address</label>
        <input id="mandateQuery" autocomplete="off" spellcheck="false" placeholder="58-character Algorand address">
        <div class="actions"><button class="btn" type="submit">Look up</button></div>
        <div class="result" id="mandateOut" aria-live="polite"></div>
      </form>`;
}

export function marketWidget(): string {
  return `
      <div class="card">
        <h3>Live listings</h3>
        <div id="marketOut" aria-live="polite"><p class="note">Loading</p></div>
      </div>`;
}

export function earningsWidget(): string {
  return `
      <form class="card" id="earnForm" novalidate>
        <h3>Creator earnings</h3>
        <label for="earnAddr">Creator address</label>
        <input id="earnAddr" autocomplete="off" spellcheck="false" placeholder="58-character Algorand address">
        <div class="actions"><button class="btn btn-ghost" type="submit">Check</button></div>
        <div class="result" id="earnOut" aria-live="polite"></div>
      </form>`;
}

export function statsWidget(): string {
  const tile = (id: string, label: string) => `<div><div class="v" id="${id}">-</div><div class="k">${label}</div></div>`;
  const netLabel = config.paymentChain === "robinhood" ? "Net revenue, USD quoted" : "Net revenue, USDC";
  const refundLabel = config.paymentChain === "robinhood" ? "Pending manual WIF refund reviews" : "Refunded, USDC";
  const successLabel = config.paymentChain === "robinhood" ? "Paid completion rate" : "Success rate";
  const settleLabel = config.paymentChain === "robinhood" ? "Avg. request → settlement" : "Average settlement";
  const ticketLabel = config.paymentChain === "robinhood" ? "Average WIF ticket, USD quoted" : "Average ticket";
  return `
      <div class="stat-row stat-row-3" data-reveal>
        ${tile("sPaid", "Paid requests")}${tile("sNet", netLabel)}${tile("sRefunds", refundLabel)}
      </div>
      <div class="stat-row stat-row-sm stat-row-3" data-reveal>
        ${tile("sSuccessRate", successLabel)}${tile("sAvgLatency", settleLabel)}${tile("sAvgTicket", ticketLabel)}
      </div>`;
}
