import crypto from "crypto";
import fs from "fs";
import type { Context } from "hono";
import { assertProductionConfig, config, marketplaceEnabled } from "../config.js";
import { wordmark } from "./brand.js";
import { icon } from "./icons.js";
import { agentTypes } from "./agents.js";
import { AUDIENCES, NAV_LINKS, navMenus, PRODUCTS } from "./nav.js";
import { SITE_CSS } from "./styles.js";
import { SITE_JS } from "./script.js";
import { WORLD_JS } from "./world.js";
import { FLOW_JS } from "./flow.js";

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** JSON safe to embed inside a <script> element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

const hash = (s: string | Uint8Array) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
const JS = "text/javascript; charset=utf-8";
const ASSETS: Record<string, { body: string | Uint8Array; type: string; hash: string }> = {
  "site.css": { body: SITE_CSS, type: "text/css; charset=utf-8", hash: hash(SITE_CSS) },
  "site.js": { body: SITE_JS, type: JS, hash: hash(SITE_JS) },
  "world.js": { body: WORLD_JS, type: JS, hash: hash(WORLD_JS) },
  "flow.js": { body: FLOW_JS, type: JS, hash: hash(FLOW_JS) },
};
const metaMaskLogo = fs.readFileSync(new URL("../../public/assets/wallets/metamask.png", import.meta.url));
ASSETS["wallets/metamask.png"] = { body: new Uint8Array(metaMaskLogo), type: "image/png", hash: hash(metaMaskLogo) };

// Browser bundles built by `pnpm vendor` (src/site and dist/site both sit two levels below vendor/):
// three.js, TypeGPU and the Playground's pay module, plus the chunks they import. Without them the
// pages still work; the WebGPU scenes keep their static fallbacks and paid runs are unavailable.
const VENDOR = new URL("../../vendor/", import.meta.url);
function loadVendor(dir: URL, prefix = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) loadVendor(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
    else if (entry.name.endsWith(".js")) {
      const body = fs.readFileSync(new URL(entry.name, dir), "utf8");
      ASSETS[`vendor/${prefix}${entry.name}`] = { body, type: JS, hash: hash(body) };
    }
  }
}
try {
  loadVendor(VENDOR);
} catch {
  console.warn("site: vendor/ missing; run `pnpm vendor` to enable the WebGPU scenes and paid Playground runs");
}
const asset = (name: string) => (ASSETS[name] ? `/assets/${name}?v=${ASSETS[name].hash}` : "");

export function handleAsset(name: string) {
  return (_c: Context): Response => new Response(ASSETS[name].body as BodyInit, {
    status: 200,
    headers: { "Content-Type": ASSETS[name].type, "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
export const ASSET_NAMES = Object.keys(ASSETS);

export function vercelPaymentPreviewDisabled(): boolean {
  if (process.env.VERCEL !== "1") return false;
  if (process.env.ENABLE_LIVE_PAYMENTS !== "true") return true;
  try {
    assertProductionConfig();
    return false;
  } catch {
    return true;
  }
}

const CHEVRON = '<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const isCurrent = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

function header(path: string): string {
  const network = config.paymentChain === "robinhood"
    ? `Robinhood Chain ${config.isMainnet ? "Mainnet" : "Testnet"}`
    : config.isMainnet ? "Algorand Mainnet" : "Algorand Testnet";
  const menus = navMenus()
    .map((menu) => {
      const external = menu.href.startsWith("http");
      const active = !external && (isCurrent(path, menu.href) || (menu.match ?? []).some((m) => isCurrent(path, m)));
      const groups = menu.groups
        .map(
          (g) => `<div class="nav-col${g.minor ? " minor" : ""}"><ul aria-label="${esc(g.title)}">${g.links
            .map((l) => `<li><a class="nav-link" href="${esc(l.href)}">${g.minor ? "" : `<span class="nav-ic">${icon(l.icon, 16)}</span>`}${esc(l.label)}</a></li>`)
            .join("")}</ul></div>`
        )
        .join("");
      return `<li class="nav-item${active ? " active" : ""}">
          <button class="nav-trigger" type="button" aria-expanded="false" aria-controls="menu-${menu.id}">${menu.label}${CHEVRON}</button>
          <div class="nav-menu" id="menu-${menu.id}" hidden>
            <div class="nav-cols">${groups}</div>
          </div>
        </li>`;
    })
    .join("");
  const links = NAV_LINKS.map((l) => `<li class="nav-item${isCurrent(path, l.href) ? " active" : ""}"><a class="nav-direct" href="${l.href}">${l.label}</a></li>`).join("");
  const quickstartUrl = `${config.docsUrl}/quickstart`;
  const githubUrl = config.paymentChain === "robinhood" ? "https://github.com/devndesigner6/moltworld-x402-gateway" : "https://github.com/hackcat29/moltworld-x402";
  return `<header class="site" id="siteHeader">
    <div class="wrap bar">
      <a class="brand" href="/" aria-label="Moltworld home">${wordmark()}</a>
      <nav class="primary" id="nav" aria-label="Main">
        <ul class="nav-list">${menus}${links}</ul>
        <div class="nav-mobile-cta">
          <a class="btn" href="/playground">Open Playground ${icon("arrow", 16)}</a>
          <a class="btn btn-ghost" href="${quickstartUrl}">Quickstart</a>
        </div>
      </nav>
      <div class="header-actions">
        <a class="status" id="netStatus" href="/stats" title="Gateway status"><span class="pulse" aria-hidden="true"></span><span id="netLabel">${network}</span></a>
        <a class="icon-btn" href="${githubUrl}" aria-label="Moltworld on GitHub" title="GitHub">${icon("github", 18)}</a>
        <a class="btn btn-header" href="/playground">Playground ${icon("arrow", 14)}</a>
        <button class="menu-btn" id="menuBtn" type="button" aria-expanded="false" aria-controls="nav"><span class="menu-lines" aria-hidden="true"></span><span class="menu-text">Menu</span></button>
      </div>
    </div>
  </header>`;
}

function footer(): string {
  const docs = config.docsUrl;
  const robinhood = config.paymentChain === "robinhood";
  const activeProducts = PRODUCTS.map((p) => robinhood && p.label === "Mandates" ? { ...p, label: "Live mandates" } : robinhood && !marketplaceEnabled() && p.label === "Marketplace" ? { ...p, label: "Marketplace (disabled)" } : p);
  const activeAudiences = AUDIENCES.map((a) => robinhood && !marketplaceEnabled() && a.label === "API sellers" ? { ...a, label: "API sellers (marketplace disabled)" } : a);
  const githubUrl = config.paymentChain === "robinhood" ? "https://github.com/devndesigner6/moltworld-x402-gateway" : "https://github.com/hackcat29/moltworld-x402";
  const developerLinks: Array<readonly [string, string]> = config.paymentChain === "robinhood"
    ? [["Developer hub", "/developers"], ["Documentation", docs], ["Quickstart", `${docs}/quickstart`], ["API reference", `${docs}/api-reference/introduction`], ["Playground", "/playground"], ["Live network", "/stats"], ["llms.txt", "/llms.txt"], ["GitHub", githubUrl]]
    : [["Developer hub", "/developers"], ["Documentation", docs], ["Quickstart", `${docs}/quickstart`], ["API reference", `${docs}/api-reference/introduction`], ["Playground", "/playground"], ["llms.txt", "/llms.txt"], ["GitHub", githubUrl]];
  const col = (title: string, links: Array<readonly [string, string]>) =>
    `<div><h4>${title}</h4><ul>${links.map(([label, href]) => `<li><a href="${esc(href)}">${esc(label)}</a></li>`).join("")}</ul></div>`;
  return `<footer class="site">
    <div class="wrap">
      <div class="foot-top">
        <div class="foot-brand">
          <a class="brand" href="/" aria-label="Moltworld home">${wordmark()}</a>
        </div>
        <div class="foot-grid">
          ${col("Product", [["Overview", "/products"], ...activeProducts.map((p) => [p.label, p.href] as const), ["Signed receipts", "/products/receipts"], ...(robinhood ? [["Refunds and rebates (not live on WIF)", `${docs}/concepts/refunds-and-rebates`] as const] : []), ["Models", "/models"], ["Pricing", "/pricing"]])}
          ${col("Solutions", [["Overview", "/solutions"], ...activeAudiences.map((a) => [a.label, a.href] as const)])}
          ${col("Use cases", [["All use cases", "/use-cases"], ...agentTypes().slice(1, 6).map((t) => [t.short, `/use-cases/${t.slug}`] as const)])}
          ${col("Developers", developerLinks)}
          ${col("Network", [["Live network", "/stats"], ["Health", "/health"], ["Receipt keys", "/.well-known/moltworld-receipts.json"], ["x402 descriptor", "/.well-known/x402"], ["Agent card", "/.well-known/agent-card.json"]])}
        </div>
      </div>
      <div class="foot-giant" aria-hidden="true">moltworld<span class="dot"></span></div>
      <div class="foot-legal">
        <span>Payments in ${config.paymentAssetSymbol} go to <span class="mono">${config.payToAddress || "not configured"}</span> on ${config.paymentChain === "robinhood" ? `Robinhood Chain ${config.isMainnet ? "Mainnet" : "Testnet"}` : config.isMainnet ? "Algorand Mainnet" : "Algorand Testnet"}.</span>
        <span>MIT licensed</span>
      </div>
    </div>
  </footer>`;
}

/** Describes the service to crawlers and agents that read schema.org. */
function structuredData(origin: string): string {
  return scriptJson({
    "@context": "https://schema.org",
    "@type": "WebAPI",
    name: "Moltworld",
    url: origin,
    description: config.paymentChain === "robinhood"
      ? "Pay-per-request chat gateway settled in WIF on Robinhood Chain through x402."
      : "Pay-per-request gateway settled in USDC on Algorand through x402.",
    documentation: config.docsUrl,
    provider: { "@type": "Organization", name: "Moltworld", url: origin, logo: `${origin}/logo.png` },
    potentialAction: { "@type": "ConsumeAction", target: `${origin}/v1/models/{model}/chat/completions` },
  });
}

export interface PageOptions {
  path: string;
  title: string;
  description: string;
  body: string;
  /** Extra markup placed before the shared script (e.g. embedded JSON data). */
  data?: string;
}

export function renderPage(c: Context, opts: PageOptions): Response {
  const origin = config.publicDomain;
  const fullTitle = opts.path === "/" ? opts.title : `${opts.title} | Moltworld`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(fullTitle)}</title>
  <meta name="description" content="${esc(opts.description)}">
  <meta name="theme-color" content="#0A0A0B" media="(prefers-color-scheme: dark)">
  <meta name="theme-color" content="#F4F3EE" media="(prefers-color-scheme: light)">
  <link rel="canonical" href="${origin}${opts.path}">
  <link rel="icon" type="image/svg+xml" href="/logo.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
  <link rel="apple-touch-icon" href="/logo.png">
  <link rel="alternate" type="text/plain" href="/llms.txt" title="LLM-readable service description">
  <link rel="alternate" type="application/json" href="/v1/models" title="Model catalog">
  <script type="application/ld+json">${structuredData(origin)}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Geist+Mono:wght@400..600&display=swap">
  <link rel="stylesheet" href="${asset("site.css")}">
  <script>document.documentElement.classList.add("js")</script>
  <meta property="og:title" content="${esc(fullTitle)}">
  <meta property="og:description" content="${esc(opts.description)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Moltworld">
  <meta property="og:url" content="${origin}${opts.path}">
  <meta property="og:image" content="${origin}/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${origin}/og.png">
</head>
<body data-origin="${origin}" data-explorer="${config.paymentChain === "robinhood" ? (config.isMainnet ? "https://robinhoodchain.blockscout.com" : "https://explorer.testnet.chain.robinhood.com") : config.isMainnet ? "https://lora.algokit.io/mainnet" : "https://lora.algokit.io/testnet"}" data-world-src="${asset("world.js")}" data-flow-src="${asset("flow.js")}" data-three-src="${asset("vendor/three.js")}" data-tgpu-src="${asset("vendor/typegpu.js")}" data-pay-src="${asset("vendor/pay.js")}" data-mandate-src="${asset("vendor/mandate.js")}" data-market-src="${asset("vendor/market.js")}">
  <a class="skip" href="#main">Skip to content</a>
  ${header(opts.path)}
  <main id="main">
${opts.body}
  </main>
  ${footer()}
  <div class="toast" id="toast" role="status"></div>
  ${opts.data ?? ""}
  <script src="${asset("site.js")}" defer></script>
</body>
</html>`;
  return c.html(html, 200, { "Cache-Control": "public, max-age=60" });
}
