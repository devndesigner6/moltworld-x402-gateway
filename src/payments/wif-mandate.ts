import { getAddress, keccak256, formatUnits, type Hex } from "viem";
import { config, WIF_MAINNET_TOKEN_ADDRESS } from "../config.js";
import { createRobinhoodPublicClient } from "../pricing/wif.js";
import { WIF_MANDATE_RUNTIME } from "./wif-mandate-runtime.js";

export function isWifMandateRuntime(code: Hex | undefined): boolean {
  if (!code || code.length !== WIF_MANDATE_RUNTIME.byteLength * 2 + 2) return false;
  let normalized = code.slice(2).toLowerCase();
  for (const { start, length } of WIF_MANDATE_RUNTIME.immutableReferences) {
    normalized = normalized.slice(0, start * 2) + "0".repeat(length * 2) + normalized.slice((start + length) * 2);
  }
  return keccak256(`0x${normalized}`) === WIF_MANDATE_RUNTIME.runtimeTemplateHash;
}

export async function readWifMandate(addressText: string) {
  const address = getAddress(addressText);
  const client = await createRobinhoodPublicClient();
  const [chainId, code, block] = await Promise.all([client.getChainId(), client.getCode({ address }), client.getBlock()]);
  if (chainId !== 4663 || config.networkCaip2 !== "eip155:4663") throw new Error("WIF mandates require Robinhood Chain mainnet.");
  if (!isWifMandateRuntime(code)) throw new Error("Address does not contain the pinned Moltworld mandate contract.");
  const fields = await Promise.all(WIF_MANDATE_RUNTIME.abi.map(async item => [item.name, await client.readContract({ address, abi: WIF_MANDATE_RUNTIME.abi, functionName: item.name })] as const));
  const state = Object.fromEntries(fields);
  const matches = (name: string, expected: string) => String(state[name]).toLowerCase() === expected.toLowerCase();
  if (!matches("token", WIF_MAINNET_TOKEN_ADDRESS) || !matches("permit2", "0x000000000022D473030F116dDEE9F6B43aC78BA3") || !matches("exactProxy", "0x402085c248EeA27D92E8b30b2C58ed07f9E20001") || !matches("payTo", config.payToAddress)) throw new Error("Mandate token, Permit2, proxy or recipient does not match this gateway.");
  const expiry = BigInt(String(state.expiry));
  const remaining = BigInt(String(state.remainingAllowance));
  const balance = BigInt(String(state.tokenBalance));
  return {
    id: address, owner: state.owner, agent: state.sessionAgent,
    status: !state.active ? "inactive" : block.timestamp >= expiry ? "expired" : remaining === 0n || balance === 0n ? "exhausted" : "active",
    network: "eip155:4663", asset: WIF_MAINNET_TOKEN_ADDRESS, asset_symbol: "WIF", pay_to: state.payTo,
    max_per_call_atomic: String(state.maxPerCall), max_per_call: formatUnits(BigInt(String(state.maxPerCall)), 18),
    remaining_allowance_atomic: remaining.toString(), remaining_allowance: formatUnits(remaining, 18),
    balance_atomic: balance.toString(), balance: formatUnits(balance, 18),
    expiry: expiry.toString(), session_epoch: String(state.sessionEpoch), code_verified: true, experimental: true,
    observed_block: block.number.toString(),
  };
}
