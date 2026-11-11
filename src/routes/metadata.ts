import type { Context } from "hono";
import type { GatewayConfig } from "../config.js";
import { config, marketplaceEnabled } from "../config.js";
import { defaultModelRegistry, getModelEndpoint, getModelDiscoveryDescription } from "../models/registry.js";
import { quoteRequest, referenceRequest } from "../pricing/index.js";

export interface DiscoveryProfile {
  title: string;
  description: string;
  tags: string[];
  payment: {
    scheme: "exact";
    network: string;
    asset: string;
    assetSymbol: string;
    assetDecimals: number;
    tokenStandard: "ERC-20" | "Algorand ASA";
    permit2: boolean;
    supportedModalities: string[];
    unsupportedFeatures: string[];
  };
}

/** Machine-readable service facts must follow the selected payment rail. */
export function discoveryProfile(cfg: Pick<GatewayConfig, "paymentChain" | "networkCaip2" | "paymentAssetAddress" | "paymentAssetSymbol" | "paymentAssetDecimals">): DiscoveryProfile {
  if (cfg.paymentChain === "robinhood") {
    const market = process.env.ROBINHOOD_MARKETPLACE_ENABLED === "true";
    return {
      title: "Moltworld x402 Gateway | WIF Chat",
      description: market ? "Moltworld supports chat and reviewed creator APIs paid per call in WIF through x402 on Robinhood Chain using EIP-1193 wallets. Owner-funded agent mandates support live WIF payments." : "Moltworld supports chat-only requests paid per call in WIF through x402 on Robinhood Chain using EIP-1193 wallets. Owner-funded agent mandates are live; marketplace payments are disabled.",
      tags: ["moltworld", "ai-inference", "chat", "wif", "robinhood-chain", "x402", "exact-evm", "permit2"],
      payment: {
        scheme: "exact",
        network: String(cfg.networkCaip2),
        asset: cfg.paymentAssetAddress,
        assetSymbol: cfg.paymentAssetSymbol,
        assetDecimals: cfg.paymentAssetDecimals,
        tokenStandard: "ERC-20",
        permit2: true,
        supportedModalities: ["chat"],
        unsupportedFeatures: ["image", "voice", "video", ...(market ? [] : ["marketplace"]), "automatic refunds"],
      },
    };
  }

  return {
    title: "Moltworld | Legacy Algorand x402 Gateway",
    description: "Legacy Algorand deployments pay supported model requests per call in USDC through x402.",
    tags: ["moltworld", "ai-inference", "algorand", "usdc", "x402", "legacy"],
    payment: {
      scheme: "exact",
      network: String(cfg.networkCaip2),
      asset: cfg.paymentAssetAddress,
      assetSymbol: cfg.paymentAssetSymbol,
      assetDecimals: cfg.paymentAssetDecimals,
      tokenStandard: "Algorand ASA",
      permit2: false,
      supportedModalities: ["chat", "image", "voice", "video"],
      unsupportedFeatures: [],
    },
  };
}

function siteUrl(): string {
  return config.publicDomain.replace(/\/+$/, "");
}

function fromQuote(model: Parameters<typeof referenceRequest>[0]) {
  return quoteRequest(model, referenceRequest(model));
}

export function handleX402Discovery(c: Context): Response {
  const origin = siteUrl();
  const profile = discoveryProfile(config);
  const models = defaultModelRegistry
    .getEnabledModels()
    .filter((model) => config.paymentChain !== "robinhood" || model.modality === "chat");
  return c.json(
    {
      x402Version: 2,
      name: profile.title,
      description: profile.description,
      website: origin,
      logo: `${origin}/logo.png`,
      image: `${origin}/logo.png`,
      tags: profile.tags,
      payment: profile.payment,
      resources: models.map((model) => {
        const quote = fromQuote(model);
        return {
          url: `${origin}${getModelEndpoint(model)}`,
          method: "POST",
          description: getModelDiscoveryDescription(model),
          network: profile.payment.network,
          asset: profile.payment.asset,
          assetSymbol: profile.payment.assetSymbol,
          assetDecimals: profile.payment.assetDecimals,
          ...(config.paymentChain === "robinhood" ? {} : { amount: String(quote.microUsdc) }),
          pricing: config.paymentChain === "robinhood"
            ? "dynamic: WIF amount is quote-bound in the HTTP 402 challenge for the exact chat body"
            : "dynamic: amount shown is for a reference request; POST /v1/quote prices an exact body",
          payTo: config.payToAddress,
          tags: [...profile.tags, model.modality],
        };
      }),
    },
    200,
    { "Cache-Control": "public, max-age=300" }
  );
}

export function handleLlmsTxt(c: Context): Response {
  const origin = siteUrl();
  const profile = discoveryProfile(config);
  const robinhood = config.paymentChain === "robinhood";
  const network = robinhood
    ? `${config.isMainnet ? "Robinhood Chain Mainnet" : "Robinhood Chain Testnet"} (${config.networkCaip2})`
    : `${config.isMainnet ? "Algorand Mainnet" : "Algorand Testnet"} (${config.networkCaip2})`;
  const lines = [
    `# ${profile.title}`,
    "",
    `> ${profile.description}`,
    "",
    `Site: ${origin}/`,
    `Docs: ${config.docsUrl}`,
    `Quickstart: ${origin}/quickstart`,
    `Logo: ${origin}/logo.png`,
    `Merchant payTo address: ${config.payToAddress}`,
    `Payment: x402 exact scheme; ${profile.payment.assetSymbol} on ${network} (asset ${profile.payment.asset}; ${profile.payment.assetDecimals} decimals).`,
    ...(robinhood
      ? [
          "Token standard: WIF ERC-20.",
          "Permit2: the exact 402 challenge may require a first-use WIF approval to Permit2; that approval is a separate wallet transaction and needs native ETH for gas.",
          "Wallets: browser checkout supports an injected EIP-1193 wallet; WalletConnect is available when the deployment configures a Reown project ID. Each chat call requires the user wallet to authorize the exact quote-bound payment.",
          marketplaceEnabled() ? "Supported now: chat and approved marketplace APIs; creator payouts use merchant-wallet transfers with on-chain reconciliation." : "Supported now: chat model requests only. Marketplace is disabled.",
          "Not enabled now: image, voice, video and automatic WIF refunds.",
          "Live: owner-funded EIP-1271 agent mandates. Deploy, fund and arm from /products/mandates; read policy at GET /v1/mandates/{contract-address}. Mainnet settlement proof: https://robinhoodchain.blockscout.com/tx/0x879e7e15f7b2cd4cd540f2e725ca3d3ce78ea552389588c6c95f539c35df43f3. Local budgets and remote MCP discovery are not an on-chain mandate.",
        ]
      : [
          `Facilitator: ${config.facilitatorUrl} (legacy Algorand deployment).`,
          "Legacy rail: Algorand USDC x402 support; see the legacy product and mandate documentation.",
        ]),
    ...(robinhood ? [] : ["Discovery: GoPlausible Bazaar; challenge tag: x402-global-challenge."]),
    "",
    "## Agent and developer guidance",
    "",
    "- Read the live model catalog for current availability, prices, descriptions, and endpoint paths.",
    "- Prices are per request and depend on the body. POST /v1/quote returns the exact USD quote and, on Robinhood, the quote-time WIF amount without paying.",
    "- Send the exact same JSON body to a chat POST endpoint. A valid unpaid request returns HTTP 402 with a Payment-Required header for that body.",
    ...(robinhood
      ? [
          "- Use an x402 EVM client implementing ExactEvmScheme and Permit2, or the browser's injected EIP-1193 wallet flow, to authorize the challenge and retry with Payment-Signature.",
          "- Direct calls use the user wallet. A local MCP session key can authorize tasks within an owner-funded mandate.",
          "- A successful chat response carries a Moltworld-Receipt header binding the request and response hashes to the settled WIF amount and Robinhood transaction.",
          "- Chat is configured to settle after the answer; unused max_tokens are not an automatic WIF rebate.",
        ]
      : [
          "- Pay with an x402 client that supports Algorand USDC and retry with Payment-Signature. Each paid response carries a Moltworld-Receipt header.",
          "- Legacy Algorand chat rebates, media refunds, mandates, and marketplace behavior are documented separately and do not describe the Robinhood rail.",
        ]),
    "- Retrying with the same Payment-Signature after a dropped connection returns the original response; it is never charged twice.",
    "- Choose a model that matches the requested modality and respect the input limits in the catalog and payment response.",
    "",
    "## Discovery and service links",
    "",
    `- [Moltworld home](${origin}/): Service overview and logo.`,
    `- [Quickstart](${origin}/quickstart): User-wallet and developer setup for the live rail.`,
    `- [x402 service descriptor](${origin}/.well-known/x402): Machine-readable paid route and payment catalog.`,
    `- [A2A agent card](${origin}/.well-known/agent-card.json): Working JSON-RPC model discovery agent at ${origin}/a2a.`,
    `- [MCP server](${origin}/mcp): Model catalog, live payment requirements, and caller-signed paid requests.`,
    `- [Live model catalog](${origin}/v1/models): Enabled models, prices, descriptions, and endpoint paths.`,
    `- [Service health](${origin}/health): Network, asset, payTo address, and facilitator context.`,
    `- [Quote](${origin}/v1/quote): POST { model, ...body } for the exact price.`,
    `- [Receipt keys](${origin}/.well-known/moltworld-receipts.json): Ed25519 keys that sign Moltworld receipts.`,
    `- [Public stats](${origin}/v1/stats): Ledger metrics with on-chain transaction ids.`,
    ...(robinhood ? marketplaceEnabled() ? [`- [Marketplace](${origin}/v1/market): Approved creator APIs with quote-bound WIF payments.`, `- [Owner mandate setup](${origin}/products/mandates): Live local-agent setup.`] : [] : [`- [Legacy marketplace](${origin}/v1/market): Creator APIs on the legacy Algorand rail.`]),
    "",
    "## Paid model endpoints",
    "",
  ];

  const modalities: Array<"chat" | "image" | "voice" | "video"> = robinhood ? ["chat"] : ["chat", "image", "voice", "video"];
  for (const modality of modalities) {
    const models = defaultModelRegistry.getEnabledModels().filter((model) => model.modality === modality);
    lines.push(`### ${modality[0].toUpperCase()}${modality.slice(1)}`, "");
    for (const model of models) {
      const quote = fromQuote(model);
      lines.push(
        robinhood
          ? `- [${model.displayName}](${origin}${getModelEndpoint(model)}): POST chat; USD quote converted to an exact WIF amount in the 402 challenge. ${getModelDiscoveryDescription(model)}`
          : `- [${model.displayName}](${origin}${getModelEndpoint(model)}): POST; from ${quote.formattedPrice} USDC. ${getModelDiscoveryDescription(model)}`
      );
    }
    lines.push("");
  }

  return c.text(lines.join("\n"), 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  });
}
