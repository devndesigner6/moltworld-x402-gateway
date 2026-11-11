import {
  config,
  ROBINHOOD_CHAINLINK_ETH_USD_FEED_ADDRESS,
  ROBINHOOD_CHAINLINK_ETH_USD_FEED_HEARTBEAT_SECONDS,
  ROBINHOOD_MAINNET_CAIP2,
  ROBINHOOD_V4_STATE_VIEW_ADDRESS,
  WIF_MAINNET_PAIR_ADDRESS,
  WIF_MAINNET_TOKEN_ADDRESS,
} from "../config.js";

export const WIF_PRICE_SOURCE = "Robinhood Uniswap v4 StateView + Chainlink ETH/USD";
const SCALE = 10n ** 18n;
const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SNAPSHOT_CACHE_TTL_MS = 5_000;
const MAX_LATEST_BLOCK_AGE_SECONDS = 60;
const MAX_FUTURE_SKEW_SECONDS = 15;

const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    type: "function",
    name: "getLiquidity",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
] as const;

const aggregatorV3Abi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "decimals", type: "uint8" }],
  },
] as const;

export interface WifPriceSnapshot {
  /** Spot price from the exact WIF/ETH Uniswap v4 pool, before the safety haircut. */
  priceUsd: string;
  /** Price used for quote conversion after the configured safety haircut. */
  effectivePriceUsdScaled18: string;
  /** USD value of the currently active v4 liquidity at the observed pool price. */
  liquidityUsd: number;
  source: string;
  observedAt: string;
  blockNumber: string;
  blockTimestamp: number;
  ethUsdUpdatedAt: number;
}

export interface OnchainWifPriceInput {
  /** v4 sqrtPriceX96 where currency0 is native ETH and currency1 is WIF. */
  sqrtPriceX96: bigint;
  activeLiquidity: bigint;
  ethUsdAnswer: bigint;
  ethUsdDecimals: number;
  ethUsdUpdatedAt: number;
  blockTimestamp: number;
  blockNumber?: bigint;
  nowSeconds?: number;
  wifTokenDecimals: number;
  minLiquidityUsd: number;
  haircutBps: number;
  feedHeartbeatSeconds: number;
  maxBlockAgeSeconds?: number;
}

let cachedSnapshot: WifPriceSnapshot | undefined;
let inFlightSnapshot: Promise<WifPriceSnapshot> | undefined;

/** Parse a positive decimal price without binary floating-point rounding. */
export function decimalToScaled18(value: string): bigint {
  const text = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error("WIF price must be a plain positive decimal.");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > 18) throw new Error("WIF price has more than 18 decimal places.");
  const scaled = BigInt(whole) * SCALE + BigInt((fraction + "0".repeat(18)).slice(0, 18));
  if (scaled <= 0n) throw new Error("WIF price must be greater than zero.");
  return scaled;
}

export function scaled18ToDecimal(value: bigint): string {
  if (value <= 0n) throw new Error("Scaled price must be positive.");
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function usdMicroToTokenAtomic(usdMicro: number, tokenPriceUsdScaled18: bigint, tokenDecimals = 18): string {
  if (!Number.isSafeInteger(usdMicro) || usdMicro < 0) throw new Error("USD quote must be a non-negative safe integer in micro-dollars.");
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) throw new Error("Unsupported token decimals.");
  if (tokenPriceUsdScaled18 <= 0n) throw new Error("Token price must be positive.");
  const numerator = BigInt(usdMicro) * (10n ** BigInt(tokenDecimals + 12));
  const atomic = (numerator + tokenPriceUsdScaled18 - 1n) / tokenPriceUsdScaled18;
  return atomic.toString();
}

/** Value a raw token balance in micro-USD using the exact quote-time price. */
export function tokenAtomicToUsdMicro(amountAtomic: bigint, tokenPriceUsdScaled18: bigint, tokenDecimals = 18): number {
  if (amountAtomic < 0n || tokenPriceUsdScaled18 <= 0n) return 0;
  const value = (amountAtomic * tokenPriceUsdScaled18) / (10n ** BigInt(tokenDecimals + 12));
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(value > max ? max : value);
}

/**
 * Convert live Uniswap v4 pool state to a WIF/USD snapshot. The configured pool is
 * currency0=native ETH and currency1=WIF, sorted by address; Chainlink supplies
 * ETH/USD. Both inputs are read at the latest Robinhood block.
 */
export function snapshotFromOnchainState(input: OnchainWifPriceInput): WifPriceSnapshot {
  if (input.sqrtPriceX96 <= 0n) throw new Error("WIF v4 pool has no initialized spot price.");
  if (input.activeLiquidity <= 0n) throw new Error("WIF v4 pool has no active liquidity.");
  if (input.ethUsdAnswer <= 0n) throw new Error("Robinhood Chainlink ETH/USD answer is not positive.");
  if (!Number.isInteger(input.ethUsdDecimals) || input.ethUsdDecimals < 0 || input.ethUsdDecimals > 18) {
    throw new Error("Unsupported Chainlink ETH/USD decimals.");
  }
  if (!Number.isInteger(input.wifTokenDecimals) || input.wifTokenDecimals < 0 || input.wifTokenDecimals > 36) {
    throw new Error("Unsupported WIF token decimals.");
  }
  if (!Number.isSafeInteger(input.blockTimestamp) || input.blockTimestamp <= 0) {
    throw new Error("Latest Robinhood block timestamp is invalid.");
  }
  if (!Number.isSafeInteger(input.ethUsdUpdatedAt) || input.ethUsdUpdatedAt <= 0) {
    throw new Error("Chainlink ETH/USD round has no valid updatedAt timestamp.");
  }
  if (!Number.isInteger(input.feedHeartbeatSeconds) || input.feedHeartbeatSeconds <= 0) {
    throw new Error("Chainlink ETH/USD heartbeat configuration is invalid.");
  }

  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxBlockAgeSeconds = input.maxBlockAgeSeconds ?? MAX_LATEST_BLOCK_AGE_SECONDS;
  if (input.blockTimestamp > nowSeconds + MAX_FUTURE_SKEW_SECONDS) {
    throw new Error("Latest Robinhood block timestamp is too far in the future.");
  }
  if (nowSeconds - input.blockTimestamp > maxBlockAgeSeconds) {
    throw new Error("Latest Robinhood block is stale; refusing a WIF quote.");
  }
  if (input.ethUsdUpdatedAt > input.blockTimestamp + MAX_FUTURE_SKEW_SECONDS) {
    throw new Error("Chainlink ETH/USD round is newer than the latest Robinhood block.");
  }
  const feedAgeSeconds = input.blockTimestamp - input.ethUsdUpdatedAt;
  if (feedAgeSeconds < 0 || feedAgeSeconds > input.feedHeartbeatSeconds) {
    throw new Error("Chainlink ETH/USD round is stale beyond its documented heartbeat.");
  }
  if (!Number.isFinite(input.minLiquidityUsd) || input.minLiquidityUsd < 0) {
    throw new Error("WIF_PRICE_MIN_LIQUIDITY_USD must be a non-negative number.");
  }
  if (!Number.isFinite(input.haircutBps) || input.haircutBps < 0 || input.haircutBps >= 10_000) {
    throw new Error("WIF_PRICE_HAIRCUT_BPS must be from 0 to 9999.");
  }

  // Chainlink ETH/USD decimals are read onchain; scale to 18 decimals with integers.
  const ethUsdScaled18 = input.ethUsdAnswer * 10n ** BigInt(18 - input.ethUsdDecimals);
  const sqrtSquared = input.sqrtPriceX96 * input.sqrtPriceX96;
  const ethDecimals = 18;
  // sqrtPriceX96 encodes raw WIF / raw ETH. Convert that to human units and invert
  // to obtain USD per WIF. The current WIF token and native ETH both use 18 decimals.
  const priceNumerator = ethUsdScaled18 * Q192 * 10n ** BigInt(input.wifTokenDecimals);
  const priceDenominator = sqrtSquared * 10n ** BigInt(ethDecimals);
  const spotPriceUsdScaled18 = priceNumerator / priceDenominator;
  if (spotPriceUsdScaled18 <= 0n) throw new Error("Derived WIF/USD spot price is zero.");

  // For Uniswap v4 active liquidity L, current in-range token amounts are
  // amount0=L/sqrt(P), amount1=L*sqrt(P), expressed in raw token units.
  const ethAmountAtomic = (input.activeLiquidity * Q96) / input.sqrtPriceX96;
  const wifAmountAtomic = (input.activeLiquidity * input.sqrtPriceX96) / Q96;
  const liquidityUsdMicro = BigInt(tokenAtomicToUsdMicro(ethAmountAtomic, ethUsdScaled18, ethDecimals))
    + BigInt(tokenAtomicToUsdMicro(wifAmountAtomic, spotPriceUsdScaled18, input.wifTokenDecimals));
  const minimumLiquidityMicro = BigInt(Math.ceil(input.minLiquidityUsd * 1_000_000));
  if (liquidityUsdMicro < minimumLiquidityMicro) {
    throw new Error(`WIF v4 active liquidity is below the configured $${input.minLiquidityUsd} minimum.`);
  }
  if (liquidityUsdMicro > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("WIF pool liquidity exceeds the safe display range.");
  }

  const haircutBps = BigInt(Math.floor(input.haircutBps));
  const effectivePriceUsdScaled18 = (spotPriceUsdScaled18 * (10_000n - haircutBps)) / 10_000n;
  if (effectivePriceUsdScaled18 <= 0n) throw new Error("WIF effective price is invalid after the configured safety haircut.");

  return {
    priceUsd: scaled18ToDecimal(spotPriceUsdScaled18),
    effectivePriceUsdScaled18: effectivePriceUsdScaled18.toString(),
    liquidityUsd: Number(liquidityUsdMicro) / 1_000_000,
    source: WIF_PRICE_SOURCE,
    observedAt: new Date().toISOString(),
    blockNumber: input.blockNumber?.toString() ?? "unknown",
    blockTimestamp: input.blockTimestamp,
    ethUsdUpdatedAt: input.ethUsdUpdatedAt,
  };
}

export async function createRobinhoodPublicClient() {
  const { createPublicClient, fallback, http } = await import("viem");
  const urls = [...new Set([
    config.robinhoodRpcUrl,
    "https://robinhood.rpc.pinax.network",
    "https://rpc.mainnet.chain.robinhood.com",
  ].filter(Boolean))];
  return createPublicClient({
    transport: fallback(
      urls.map((url) => http(url, { timeout: 5_000, retryCount: 0 })),
      { retryCount: 1, retryDelay: 100 },
    ),
  });
}

async function fetchOnchainSnapshot(): Promise<WifPriceSnapshot> {
  if (config.paymentChain !== "robinhood" || !config.isMainnet || config.networkCaip2 !== ROBINHOOD_MAINNET_CAIP2) {
    throw new Error("The live WIF price adapter is configured only for Robinhood Chain mainnet.");
  }
  if (config.paymentAssetAddress.toLowerCase() !== WIF_MAINNET_TOKEN_ADDRESS.toLowerCase()) {
    throw new Error("WIF_TOKEN_ADDRESS does not match the verified Robinhood WIF contract.");
  }
  if (config.wifPoolId.toLowerCase() !== WIF_MAINNET_PAIR_ADDRESS.toLowerCase()) {
    throw new Error("WIF_POOL_ID does not match the verified Robinhood WIF/ETH Uniswap v4 PoolId.");
  }
  if (WIF_MAINNET_TOKEN_ADDRESS.toLowerCase() <= ZERO_ADDRESS) {
    throw new Error("The WIF/ETH currency ordering is invalid for Uniswap v4 price conversion.");
  }

  const client = await createRobinhoodPublicClient();
  const [chainId, block, slot0, activeLiquidity, round, feedDecimals] = await Promise.all([
    client.getChainId(),
    client.getBlock(),
    client.readContract({
      address: ROBINHOOD_V4_STATE_VIEW_ADDRESS as `0x${string}`,
      abi: stateViewAbi,
      functionName: "getSlot0",
      args: [config.wifPoolId as `0x${string}`],
    }),
    client.readContract({
      address: ROBINHOOD_V4_STATE_VIEW_ADDRESS as `0x${string}`,
      abi: stateViewAbi,
      functionName: "getLiquidity",
      args: [config.wifPoolId as `0x${string}`],
    }),
    client.readContract({
      address: ROBINHOOD_CHAINLINK_ETH_USD_FEED_ADDRESS as `0x${string}`,
      abi: aggregatorV3Abi,
      functionName: "latestRoundData",
    }),
    client.readContract({
      address: ROBINHOOD_CHAINLINK_ETH_USD_FEED_ADDRESS as `0x${string}`,
      abi: aggregatorV3Abi,
      functionName: "decimals",
    }),
  ]);
  if (chainId !== 4663) throw new Error(`RPC returned chain ID ${chainId}; expected Robinhood Chain 4663.`);

  const [sqrtPriceX96] = slot0;
  const [, ethUsdAnswer, , updatedAt] = round;
  return snapshotFromOnchainState({
    sqrtPriceX96,
    activeLiquidity,
    ethUsdAnswer,
    ethUsdDecimals: feedDecimals,
    ethUsdUpdatedAt: Number(updatedAt),
    blockTimestamp: Number(block.timestamp),
    blockNumber: block.number ?? undefined,
    wifTokenDecimals: config.paymentAssetDecimals,
    minLiquidityUsd: config.wifPriceMinLiquidityUsd,
    haircutBps: config.wifPriceHaircutBps,
    feedHeartbeatSeconds: ROBINHOOD_CHAINLINK_ETH_USD_FEED_HEARTBEAT_SECONDS,
  });
}

function snapshotAgeMs(snapshot: WifPriceSnapshot): number {
  const observedAt = Date.parse(snapshot.observedAt);
  return Number.isFinite(observedAt) ? Math.max(0, Date.now() - observedAt) : Number.POSITIVE_INFINITY;
}

/**
 * Price WIF from the configured Robinhood v4 PoolId and Chainlink's on-chain
 * ETH/USD feed. The 5-second cache coalesces bursts only; failed upstream reads
 * fail closed and never return a stale cached price.
 */
export async function getWifPriceSnapshot(): Promise<WifPriceSnapshot> {
  const age = cachedSnapshot ? snapshotAgeMs(cachedSnapshot) : Number.POSITIVE_INFINITY;
  if (cachedSnapshot && age <= SNAPSHOT_CACHE_TTL_MS) return cachedSnapshot;
  if (inFlightSnapshot) return inFlightSnapshot;

  const pending = fetchOnchainSnapshot().then((snapshot) => {
    cachedSnapshot = snapshot;
    return snapshot;
  });
  inFlightSnapshot = pending;
  try {
    return await pending;
  } finally {
    if (inFlightSnapshot === pending) inFlightSnapshot = undefined;
  }
}

export async function wifBalanceUsdMicro(address: string, price: WifPriceSnapshot): Promise<number | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^0x[0-9a-fA-F]{40}$/.test(config.paymentAssetAddress)) return null;
  try {
    const client = await createRobinhoodPublicClient();
    const balance = await client.readContract({
      address: config.paymentAssetAddress as `0x${string}`,
      abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    }) as bigint;
    return tokenAtomicToUsdMicro(balance, BigInt(price.effectivePriceUsdScaled18), config.paymentAssetDecimals);
  } catch {
    return null;
  }
}
