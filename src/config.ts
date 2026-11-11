import dotenv from "dotenv";
import type { Network } from "@x402/core/types";

dotenv.config();

export const TESTNET_GENESIS_HASH = "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
export const MAINNET_GENESIS_HASH = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

// Legacy Algorand CAIP-2 IDs remain available only for the isolated legacy path.
export const ALGORAND_TESTNET_FACILITATOR_CAIP2 = `algorand:${TESTNET_GENESIS_HASH}`;
export const ALGORAND_MAINNET_FACILITATOR_CAIP2 = `algorand:${MAINNET_GENESIS_HASH}`;
export const ALGORAND_TESTNET_CANONICAL_CAIP2 = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe";
export const ALGORAND_MAINNET_CANONICAL_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k";
export const USDC_TESTNET_ASA_ID = "10458941";
export const USDC_MAINNET_ASA_ID = "31566704";

export const ROBINHOOD_MAINNET_CAIP2 = "eip155:4663";
export const ROBINHOOD_TESTNET_CAIP2 = "eip155:46630";
export const WIF_MAINNET_TOKEN_ADDRESS = "0x5173b8eA6923c2d40267890D45C46a3480954773";
export const WIF_MAINNET_PAIR_ADDRESS = "0x71ef4106340f0a3b9c19ec994eef4fc44a1d2513f38faac39d7636b156548c79";
export const ROBINHOOD_V4_STATE_VIEW_ADDRESS = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
export const ROBINHOOD_CHAINLINK_ETH_USD_FEED_ADDRESS = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";
export const ROBINHOOD_CHAINLINK_ETH_USD_FEED_HEARTBEAT_SECONDS = 86_400;

// Default Algorand testnet payTo address for the legacy/test configuration.
const DEFAULT_TESTNET_PAYTO = "TQWEL54TCBYH3QJLN2OU2QH7XZTHRDZMF2YQIU5B7W2HK6GS7I2TWHDMXU";

export interface GatewayConfig {
  env: string;
  port: number;
  paymentChain: "algorand" | "robinhood";
  publicDomain: string;
  docsUrl: string;
  facilitatorUrl: string;
  isMainnet: boolean;
  networkCaip2: Network;
  networkCanonicalCaip2: Network;
  paymentAssetAddress: string;
  paymentAssetSymbol: "USDC" | "WIF";
  paymentAssetDecimals: number;
  /** Public Reown/WalletConnect project id for browser mobile-wallet connections. */
  reownProjectId?: string;
  usdcAsaId: string;
  payToAddress: string;
  robinhoodRpcUrl: string;
  /** Verified Uniswap v4 PoolId (bytes32), not a pool contract address. */
  wifPoolId: string;
  wifPriceMinLiquidityUsd: number;
  wifPriceHaircutBps: number;
  algodUrl: string;
  algodToken: string;
  /** App id of the deployed legacy Algorand mandate spend counter. */
  mandateCounterAppId: number | null;
  /** Algod for the legacy Algorand Playground. */
  publicAlgodUrl: string;
  /** Local-ledger signers for the legacy offline stack only. */
  playgroundDev: { walletKey?: string; mandate?: string; agentKey?: string };
  openrouterApiKey?: string;
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
  databaseUrl?: string;
  redisUrl?: string;
  receiptSigningKey?: string;
  payoutMnemonic?: string;
  adminToken?: string;
  priceMargin: number;
  priceMinFloor: number;
  rebateMinPayoutUsd: number;
  creatorPayoutMinUsd: number;
  isTest: boolean;
  facilitatorMerchantId: string;
  marketplaceFeePercent: number;
  maxInflightPerPayer: number;
  mockProviders: boolean;
  skipUpstreamVerification: boolean;
  backgroundWorkers: boolean;
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
  requestTimeoutMs: number;
  upstreamTimeoutMs: number;
}

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const requestedPaymentChain = (process.env.PAYMENT_CHAIN || (isTest ? "algorand" : "robinhood")).toLowerCase();
if (requestedPaymentChain !== "algorand" && requestedPaymentChain !== "robinhood") {
  throw new Error("PAYMENT_CHAIN must be 'robinhood' or 'algorand'.");
}
const paymentChain = requestedPaymentChain as GatewayConfig["paymentChain"];
const algorandNetwork = (process.env.ALGORAND_NETWORK || process.env.NETWORK || "testnet").toLowerCase();
const robinhoodNetwork = (process.env.ROBINHOOD_NETWORK || (process.env.NODE_ENV === "production" ? "mainnet" : "testnet")).toLowerCase();
if (paymentChain === "robinhood" && robinhoodNetwork !== "mainnet" && robinhoodNetwork !== "testnet") {
  throw new Error("ROBINHOOD_NETWORK must be 'mainnet' or 'testnet'.");
}
const isMainnet = paymentChain === "robinhood"
  ? robinhoodNetwork === "mainnet"
  : algorandNetwork === "mainnet" || algorandNetwork === "prod" || algorandNetwork === "production";
const wifTokenAddress = process.env.WIF_TOKEN_ADDRESS?.trim() || (robinhoodNetwork === "mainnet" ? WIF_MAINNET_TOKEN_ADDRESS : "");
const payToAddress = paymentChain === "robinhood"
  ? process.env.EVM_ADDRESS?.trim() || ""
  : process.env.AVM_ADDRESS?.trim() || (isMainnet ? "" : DEFAULT_TESTNET_PAYTO);

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Environment variable ${name} must be a number, got '${raw}'.`);
  return value;
}

const robinhoodRpcUrl = process.env.ROBINHOOD_RPC_URL?.trim() || (robinhoodNetwork === "mainnet"
  ? "https://rpc.mainnet.chain.robinhood.com"
  : "https://rpc.testnet.chain.robinhood.com");
const wifPoolId = process.env.WIF_POOL_ID?.trim() || (robinhoodNetwork === "mainnet" ? WIF_MAINNET_PAIR_ADDRESS : "");

const vercelDomain = process.env.VERCEL_URL?.trim().replace(/^https?:\/\//i, "");
const vercelPublicUrl = vercelDomain ? `https://${vercelDomain}` : "";

export const config: GatewayConfig = {
  env: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "3000", 10),
  paymentChain,
  publicDomain: (process.env.PUBLIC_DOMAIN?.trim() || (paymentChain === "robinhood" ? process.env.RENDER_EXTERNAL_URL?.trim() || vercelPublicUrl || "http://localhost:3000" : "https://moltworld.xyz")).replace(/\/+$/, ""),
  docsUrl: (process.env.DOCS_URL || "https://algorand-54fd52b3.mintlify.app").replace(/\/+$/, ""),
  facilitatorUrl: process.env.FACILITATOR_URL || (paymentChain === "robinhood" ? "https://x402.primer.systems" : "https://facilitator.goplausible.xyz"),
  facilitatorMerchantId: process.env.FACILITATOR_MERCHANT_ID?.trim() || "414f1538ce0d6de4",
  isTest,
  isMainnet,
  networkCaip2: (paymentChain === "robinhood"
    ? robinhoodNetwork === "mainnet" ? ROBINHOOD_MAINNET_CAIP2 : ROBINHOOD_TESTNET_CAIP2
    : isMainnet ? ALGORAND_MAINNET_FACILITATOR_CAIP2 : ALGORAND_TESTNET_FACILITATOR_CAIP2) as Network,
  networkCanonicalCaip2: (paymentChain === "robinhood"
    ? robinhoodNetwork === "mainnet" ? ROBINHOOD_MAINNET_CAIP2 : ROBINHOOD_TESTNET_CAIP2
    : isMainnet ? ALGORAND_MAINNET_CANONICAL_CAIP2 : ALGORAND_TESTNET_CANONICAL_CAIP2) as Network,
  paymentAssetAddress: paymentChain === "robinhood" ? wifTokenAddress : (isMainnet ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID),
  paymentAssetSymbol: paymentChain === "robinhood" ? "WIF" : "USDC",
  paymentAssetDecimals: paymentChain === "robinhood" ? 18 : 6,
  reownProjectId: process.env.REOWN_PROJECT_ID?.trim() || undefined,
  usdcAsaId: isMainnet ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID,
  payToAddress,
  robinhoodRpcUrl,
  wifPoolId,
  wifPriceMinLiquidityUsd: num("WIF_PRICE_MIN_LIQUIDITY_USD", 25000),
  wifPriceHaircutBps: num("WIF_PRICE_HAIRCUT_BPS", 500),
  algodUrl: process.env.ALGOD_URL?.trim() || (isMainnet ? "https://mainnet-api.algonode.cloud" : "https://testnet-api.algonode.cloud"),
  algodToken: process.env.ALGOD_TOKEN?.trim() || "",
  publicAlgodUrl: process.env.PUBLIC_ALGOD_URL?.trim() || "",
  mandateCounterAppId: Number(process.env.MANDATE_COUNTER_APP_ID) > 0 ? Number(process.env.MANDATE_COUNTER_APP_ID) : null,
  playgroundDev: isMainnet || process.env.NODE_ENV === "production"
    ? {}
    : { walletKey: process.env.PLAYGROUND_DEV_WALLET_KEY?.trim() || undefined, mandate: process.env.PLAYGROUND_DEV_MANDATE?.trim() || undefined },
  openrouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
  openaiApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY?.trim() || undefined,
  databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
  redisUrl: process.env.REDIS_URL?.trim() || undefined,
  receiptSigningKey: process.env.RECEIPT_SIGNING_KEY?.trim() || undefined,
  // This Algorand mnemonic is kept only for the legacy payment path; Robinhood refunds are not yet migrated.
  payoutMnemonic: (process.env.PAYOUT_WALLET_MNEMONIC || process.env.REFUND_WALLET_MNEMONIC)?.trim() || undefined,
  adminToken: process.env.ADMIN_TOKEN?.trim() || undefined,
  priceMargin: num("PRICE_MARGIN", 0.03),
  priceMinFloor: num("PRICE_MIN_FLOOR", 0.001),
  rebateMinPayoutUsd: num("REBATE_MIN_PAYOUT_USD", 0.05),
  creatorPayoutMinUsd: num("CREATOR_PAYOUT_MIN_USD", 1),
  marketplaceFeePercent: num("MARKETPLACE_FEE_PERCENT", 15),
  maxInflightPerPayer: num("MAX_INFLIGHT_PER_PAYER", 4),
  mockProviders: process.env.MOCK_PROVIDERS === "true" || isTest,
  skipUpstreamVerification: process.env.SKIP_UPSTREAM_VERIFICATION === "true" || isTest,
  backgroundWorkers: process.env.BACKGROUND_WORKERS !== "false" && !isTest,
  rateLimitMaxRequests: num("RATE_LIMIT_MAX", 60),
  rateLimitWindowMs: num("RATE_LIMIT_WINDOW_MS", 60000),
  requestTimeoutMs: num("REQUEST_TIMEOUT_MS", 30000),
  upstreamTimeoutMs: num("UPSTREAM_TIMEOUT_MS", 25000),
};

export function marketplaceEnabled(): boolean {
  return config.paymentChain !== "robinhood" || process.env.ROBINHOOD_MARKETPLACE_ENABLED === "true";
}

/** Fail closed when the selected mainnet rail is missing its safety prerequisites. */
export function assertProductionConfig(cfg: GatewayConfig = config): void {
  if (!Number.isInteger(cfg.marketplaceFeePercent) || cfg.marketplaceFeePercent < 0 || cfg.marketplaceFeePercent > 100) throw new Error("MARKETPLACE_FEE_PERCENT must be an integer from 0 to 100.");
  if (!cfg.isMainnet) return;
  const missing: string[] = [];
  if (cfg.paymentChain === "robinhood") {
    if (!cfg.publicDomain.startsWith("https://")) missing.push("PUBLIC_DOMAIN must be the new HTTPS deployment URL before mainnet startup");
    if (!cfg.payToAddress) missing.push("EVM_ADDRESS");
    if (!cfg.paymentAssetAddress) missing.push("WIF_TOKEN_ADDRESS");
    if (!cfg.wifPoolId) missing.push("WIF_POOL_ID");
    if (cfg.wifPoolId && !/^0x[0-9a-fA-F]{64}$/.test(cfg.wifPoolId)) missing.push("WIF_POOL_ID must be a 32-byte Uniswap v4 PoolId");
    if (cfg.payToAddress && !/^0x[0-9a-fA-F]{40}$/.test(cfg.payToAddress)) missing.push("EVM_ADDRESS must be a 20-byte EVM address");
    if (cfg.paymentAssetAddress && !/^0x[0-9a-fA-F]{40}$/.test(cfg.paymentAssetAddress)) missing.push("WIF_TOKEN_ADDRESS must be a 20-byte EVM address");
    if (cfg.payToAddress && cfg.paymentAssetAddress && cfg.payToAddress.toLowerCase() === cfg.paymentAssetAddress.toLowerCase()) {
      missing.push("EVM_ADDRESS must be different from the WIF token contract");
    }
  }
  if (!cfg.databaseUrl) missing.push("DATABASE_URL");
  if (!cfg.receiptSigningKey) missing.push("RECEIPT_SIGNING_KEY");
  if (!cfg.openaiApiKey && !cfg.openrouterApiKey) missing.push("OPENAI_API_KEY or OPENROUTER_API_KEY for live chat");
  if (cfg.mockProviders) missing.push("MOCK_PROVIDERS must be false");
  if (cfg.skipUpstreamVerification) missing.push("SKIP_UPSTREAM_VERIFICATION must be false");
  if (missing.length) throw new Error(`Refusing to start on mainnet without: ${missing.join(", ")}.`);
}
