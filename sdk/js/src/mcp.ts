#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import { createPublicClient, getAddress, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toClientEvmSigner, PERMIT2_ADDRESS } from "@x402/evm";
import { agentKeyFromSecret, generateAgentKey, MoltworldClient, MoltworldError } from "./index.js";
import { createWifMandateClientSigner, readWifMandatePolicy, ROBINHOOD_WIF_MAINNET_TOKEN } from "./evm-mandate-client.js";

const legacyAgentKeyFile = () => process.env.MOLTWORLD_AGENT_KEY_FILE || join(homedir(), ".moltworld", "agent.key");
const evmAgentKeyFile = () => process.env.MOLTWORLD_WIF_SESSION_KEY_FILE || join(homedir(), ".moltworld", "wif-agent.key");
const ROBINHOOD_RPC_URL = process.env.MOLTWORLD_EVM_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
/**
 * EVM EOA auto-payment is deliberately not a mandate. It is a local/process
 * budget around an unrestricted key, so opting in must be explicit and noisy.
 */
export const EVM_EOA_AUTOPAY_ACK = "I_UNDERSTAND_LOCAL_EVM_EOA_AUTOPAY_IS_NOT_A_MANDATE";
const erc20AllowanceAbi = [{
  type: "function",
  name: "allowance",
  stateMutability: "view",
  inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;
const robinhoodChain = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC_URL] } },
} as const;

/** Legacy Algorand keygen; retained for the mandate rail. */
function keygen() {
  const file = legacyAgentKeyFile();
  if (existsSync(file)) {
    console.log(agentKeyFromSecret(readFileSync(file, "utf8").trim()).address);
    console.error(`Agent key already exists at ${file}.`);
    return;
  }
  const key = generateAgentKey();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, key.secretKeyB64 + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(key.address);
  console.error(`Agent key saved to ${file}. Give the owner the address above to bind a mandate to it.`);
}

/** Generate a dedicated WIF agent/session key. Deliberately prints only its address. */
function evmKeygen() {
  const file = evmAgentKeyFile();
  if (existsSync(file)) {
    const secret = readFileSync(file, "utf8").trim() as `0x${string}`;
    console.log(privateKeyToAccount(secret).address);
    return;
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const secret = (`0x${Buffer.from(bytes).toString("hex")}`) as `0x${string}`;
  const account = privateKeyToAccount(secret);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, secret + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(account.address);
}

function evmPrivateKey(): `0x${string}` | undefined {
  const value = process.env.MOLTWORLD_EVM_PRIVATE_KEY?.trim() || (existsSync(evmAgentKeyFile()) ? readFileSync(evmAgentKeyFile(), "utf8").trim() : "");
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("MOLTWORLD_EVM_PRIVATE_KEY must be a 32-byte 0x-prefixed private key.");
  return value as `0x${string}`;
}

function isProductionEnvironment(): boolean {
  return [process.env.NODE_ENV, process.env.MOLTWORLD_ENV]
    .some((value) => value?.trim().toLowerCase() === "production");
}

function isLocalDevelopmentEnvironment(): boolean {
  const values = [process.env.NODE_ENV, process.env.MOLTWORLD_ENV]
    .filter((value): value is string => Boolean(value?.trim()));
  return values.length > 0 && values.every((value) => ["local", "development", "dev", "test"].includes(value.trim().toLowerCase()));
}

/** Refuse unrestricted EOA auto-payment unless this is explicitly local-only. */
export function assertEvmEoaAutopayAllowed(): void {
  if (isProductionEnvironment()) {
    throw new Error("Refusing EVM EOA auto-payment in production. This key has no owner-authorized on-chain cap or mandate; use caller-signed/browser or mandate architecture instead.");
  }
  if (!isLocalDevelopmentEnvironment()) {
    throw new Error("Refusing EVM EOA auto-payment outside local/development environments. This key has no owner-authorized on-chain cap or mandate.");
  }
  const role = process.env.MOLTWORLD_EVM_KEY_ROLE?.trim().toLowerCase();
  if (role !== "dedicated") {
    throw new Error("Refusing EVM EOA auto-payment for a master/primary wallet key. Use only a dedicated, disposable local EOA; this path is not a mandate.");
  }
  if (process.env.MOLTWORLD_ALLOW_EVM_EOA_AUTOPAY !== EVM_EOA_AUTOPAY_ACK) {
    throw new Error(`EVM EOA auto-payment is disabled by default. For local/development only, set MOLTWORLD_ALLOW_EVM_EOA_AUTOPAY=${EVM_EOA_AUTOPAY_ACK}. Use a dedicated disposable EOA, never a user's master key. The budget is local/process-only, not an owner-authorized on-chain cap or mandate.`);
  }
  console.error("WARNING: local EVM EOA auto-payment is enabled. This is an unrestricted dedicated EOA key with local/process budgets only—not an owner-authorized on-chain cap or mandate. Never use a user's master key.");
}

export function clientFromEnv(): { client: MoltworldClient; robinhood: boolean; mandateBacked?: boolean; mandateAddress?: string } {
  const mandateAddress = process.env.MOLTWORLD_WIF_MANDATE_ADDRESS?.trim();
  if (mandateAddress) {
    if (process.env.MOLTWORLD_EVM_PRIVATE_KEY?.trim()) {
      throw new Error("Remove MOLTWORLD_EVM_PRIVATE_KEY when using a WIF mandate; the mandate session key must be separate.");
    }
    const sessionSecret = process.env.MOLTWORLD_WIF_SESSION_PRIVATE_KEY?.trim()
      || (existsSync(evmAgentKeyFile()) ? readFileSync(evmAgentKeyFile(), "utf8").trim() : "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(sessionSecret)) {
      throw new Error("Set MOLTWORLD_WIF_SESSION_PRIVATE_KEY or create the local wif-agent.key session key before using a WIF mandate.");
    }
    const vaultAddress = getAddress(mandateAddress);
    const expectedOwnerRaw = process.env.MOLTWORLD_WIF_MANDATE_OWNER?.trim();
    if (!expectedOwnerRaw) {
      throw new Error("Set MOLTWORLD_WIF_MANDATE_OWNER to the owner wallet address shown by the mandate setup page.");
    }
    const expectedOwner = getAddress(expectedOwnerRaw);
    const expectedPayToRaw = process.env.MOLTWORLD_PAYMENT_TO?.trim();
    if (!expectedPayToRaw) {
      throw new Error("Set MOLTWORLD_PAYMENT_TO to the verified pay_to from the gateway /health response before using a WIF mandate.");
    }
    const expectedPayTo = getAddress(expectedPayToRaw);
    const sessionKey = sessionSecret as `0x${string}`;
    const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
    const evmSigner = createWifMandateClientSigner({
      publicClient: publicClient as any,
      mandateAddress: vaultAddress,
      sessionPrivateKey: sessionKey,
      expectedOwner,
      expectedPayTo,
    });
    const baseUrl = process.env.MOLTWORLD_URL || "https://motoworld-wif.vercel.app";
    const client = new MoltworldClient({
      baseUrl,
      evmSigner,
      maxPerRequestUsd: Number(process.env.MOLTWORLD_MAX_PER_REQUEST_USD ?? 0.5),
      budgetUsd: Number(process.env.MOLTWORLD_BUDGET_USD ?? 5),
      expectedPayTo,
      ensureEvmAllowance: async ({ asset, amount, network }) => {
        if (network !== "eip155:4663" || getAddress(asset) !== ROBINHOOD_WIF_MAINNET_TOKEN) {
          throw new Error("Refusing a mandate payment on a network or token other than Robinhood mainnet WIF.");
        }
        const policy = await readWifMandatePolicy(publicClient as any, vaultAddress, sessionKey, expectedOwner, expectedPayTo);
        if (BigInt(amount) > policy.maxPerCall) throw new Error("Requested WIF amount exceeds the on-chain per-call mandate cap.");
        if (BigInt(amount) > policy.remainingAllowance) {
          throw new Error(`WIF mandate allowance is too low (${policy.remainingAllowance} < ${amount}); owner must re-authorize it in the wallet UI.`);
        }
      },
    });
    return { client, robinhood: true, mandateBacked: true, mandateAddress: vaultAddress };
  }

  if (process.env.MOLTWORLD_WIF_SESSION_PRIVATE_KEY?.trim()) {
    throw new Error("MOLTWORLD_WIF_SESSION_PRIVATE_KEY requires MOLTWORLD_WIF_MANDATE_ADDRESS; refusing to use it as an unrestricted EOA payer.");
  }
  const evmSecret = evmPrivateKey();
  if (evmSecret) {
    assertEvmEoaAutopayAllowed();
    const account = privateKeyToAccount(evmSecret);
    const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
    const evmSigner = toClientEvmSigner(account);
    const client = new MoltworldClient({
      baseUrl: process.env.MOLTWORLD_URL || "https://motoworld-wif.vercel.app",
      evmSigner,
      maxPerRequestUsd: Number(process.env.MOLTWORLD_MAX_PER_REQUEST_USD ?? 0.5),
      budgetUsd: Number(process.env.MOLTWORLD_BUDGET_USD ?? 5),
      expectedPayTo: process.env.MOLTWORLD_PAYMENT_TO,
      ensureEvmAllowance: async ({ asset, amount }) => {
        const allowance = await publicClient.readContract({
          address: asset as Address,
          abi: erc20AllowanceAbi,
          functionName: "allowance",
          args: [account.address, PERMIT2_ADDRESS],
        });
        if (allowance < BigInt(amount)) {
          throw new Error(`Insufficient WIF Permit2 allowance (${allowance} < ${amount}). Approve Permit2 explicitly, then retry; no approval transaction is sent by this MCP server.`);
        }
      },
    });
    return { client, robinhood: true };
  }

  const mandate = process.env.MOLTWORLD_MANDATE
    ? JSON.parse(Buffer.from(process.env.MOLTWORLD_MANDATE, "base64").toString("utf8"))
    : undefined;
  const keyFile = legacyAgentKeyFile();
  return {
    robinhood: false,
    client: new MoltworldClient({
      baseUrl: process.env.MOLTWORLD_URL || "https://moltoworld.xyz",
      mandate,
      agentKey: mandate && existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined,
      mnemonic: mandate ? undefined : process.env.MOLTWORLD_MNEMONIC,
      maxPerRequestUsd: Number(process.env.MOLTWORLD_MAX_PER_REQUEST_USD ?? 0.5),
      budgetUsd: Number(process.env.MOLTWORLD_BUDGET_USD ?? 5),
    }),
  };
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (err: unknown) => ({
  isError: true,
  ...json(err instanceof MoltworldError ? { status: err.status, code: err.code, message: err.message } : { message: String((err as any)?.message ?? err) }),
}) as ReturnType<typeof json> & { isError: true };

function paidSummary(result: Awaited<ReturnType<MoltworldClient["call"]>>, client: MoltworldClient) {
  const paid = result.receipt?.assetSymbol === "WIF"
    ? { paid_usd_quote: result.paidMicro / 1_000_000, paid_token_symbol: "WIF", paid_token_amount_atomic: result.receipt.amountAtomic, paid_token_decimals: result.receipt.assetDecimals }
    : { paid_usdc: result.paidMicro / 1_000_000 };
  return { output: result.data, ...paid, receipt_verified: result.verification?.ok ?? false, request_id: result.requestId, txid: result.receipt?.txid, session_spent_usd: client.spentUsd };
}

export async function main() {
  const { client, robinhood, mandateBacked = false, mandateAddress } = clientFromEnv();
  const server = new McpServer({ name: robinhood ? "moltworld-agent" : "moltworld-wallet", version: "1.0.0" });
  const chatMessage = z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() });

  server.registerTool("moltworld_models", {
    description: robinhood ? "List supported chat models and their WIF-paid from prices on Robinhood Chain." : "List available models with their 'from' price in USDC.",
    inputSchema: robinhood ? z.object({}) : z.object({ modality: z.enum(["chat", "image", "voice", "video"]).optional() }),
  }, async (input) => json(await client.models(robinhood ? "chat" : (input as any).modality)));

  server.registerTool("moltworld_quote", { description: robinhood ? "Exact WIF-priced chat request quote before signing." : "Exact price of a request before paying.", inputSchema: z.object({ model: z.string(), body: z.record(z.string(), z.unknown()) }) }, async ({ model, body }) => {
    try { return json(await client.quote(model, body)); } catch (err) { return failure(err); }
  });

  server.registerTool("moltworld_chat", {
    description: robinhood
      ? mandateBacked
        ? "Paid chat through an owner-armed WIF EIP-1271 mandate. The on-chain wallet enforces its per-call cap, expiry, recipient and finite Permit2 allowance; local USD limits are an additional guard."
        : "Development-only WIF chat payment through a dedicated EOA. Requires explicit local opt-in; process budgets are not an on-chain mandate."
      : "Paid chat completion. Pays automatically in USDC within this server's spend limits; unused max_tokens budget is rebated.",
    inputSchema: z.object({ model: z.string(), messages: z.array(chatMessage).min(1), max_tokens: z.number().int().positive().optional() }),
  }, async ({ model, messages, max_tokens }) => {
    try { return json(paidSummary(await client.chat(model, { messages, max_tokens }), client)); } catch (err) { return failure(err); }
  });

  if (robinhood) {
    server.registerTool("moltworld_marketplace", {
      description: "List approved WIF marketplace APIs. An enabled marketplace can be empty until a real listing is approved.",
      inputSchema: z.object({}),
    }, async () => {
      try {
        const res = await fetch(`${client.baseUrl}/v1/market`);
        const body = await res.json();
        return json({ status: res.status, body });
      } catch (err) { return failure(err); }
    });
    server.registerTool("moltworld_market", {
      description: mandateBacked
        ? "Call an approved WIF marketplace API through the configured owner-funded mandate."
        : "Development-only marketplace payment using a dedicated local EOA and process USD caps; this is not an on-chain mandate.",
      inputSchema: z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,47}$/), body: z.record(z.string(), z.unknown()) }),
    }, async ({ slug, body }) => {
      try { return json(paidSummary(await client.market(slug, body), client)); } catch (err) { return failure(err); }
    });
  }

  if (!robinhood) {
    server.registerTool("moltworld_image", { description: "Paid image generation (refunded if it fails).", inputSchema: z.object({ model: z.string(), prompt: z.string(), size: z.string().optional(), n: z.number().int().optional() }) }, async ({ model, prompt, size, n }) => {
      try { return json(paidSummary(await client.image(model, { prompt, size, n }), client)); } catch (err) { return failure(err); }
    });
    server.registerTool("moltworld_speech", { description: "Paid text-to-speech; returns base64 audio.", inputSchema: z.object({ model: z.string(), input: z.string(), voice: z.string().optional() }) }, async ({ model, input, voice }) => {
      try { return json(paidSummary(await client.speech(model, { input, voice }), client)); } catch (err) { return failure(err); }
    });
  }

  server.registerTool("moltworld_spend", { description: robinhood ? (mandateBacked ? "Current session usage and configured WIF mandate address; live policy is checked before each payment." : "Local USD budget and WIF EOA address; budget is local, not an on-chain cap.") : "Wallet address and USDC spent in this session.", inputSchema: z.object({}) }, async () => json(robinhood
    ? { address: client.address, session_spent_usd: client.spentUsd, budget_usd: Number(process.env.MOLTWORLD_BUDGET_USD ?? 5), payment_chain: "robinhood", chain_id: 4663, asset: "WIF", mandate_mode_configured: mandateBacked, mandate_address: mandateBacked ? mandateAddress : undefined, policy_checked_before_payment: mandateBacked }
    : { address: client.address, session_spent_usdc: client.spentUsd, budget_usdc: Number(process.env.MOLTWORLD_BUDGET_USD ?? 5) }));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv[2] === "keygen") keygen();
  else if (process.argv[2] === "evm-keygen" || process.argv[2] === "wif-session-keygen") evmKeygen();
  else main().catch((err) => { console.error(err); process.exit(1); });
}
