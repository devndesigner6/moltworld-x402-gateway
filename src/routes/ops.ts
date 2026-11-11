import type { Context, MiddlewareHandler } from "hono";
import crypto from "crypto";
import { config } from "../config.js";
import { confirmWifPayout, createPayoutsFromCredits, getPayout, listListings, listPayouts, listUnsentPayouts, listRefunds, retryRefund, setListingStatus } from "../ledger/index.js";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { createRobinhoodPublicClient } from "../pricing/wif.js";
import { validateWifPayoutReceipt } from "../payments/marketplace-evm.js";
import { microToUsdString } from "../pricing/index.js";
import { apiError } from "../payments/gateway.js";

/** Operator endpoints. Disabled (404) unless ADMIN_TOKEN is configured. */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  if (!config.adminToken) return apiError(c, 404, "not_found", "Not found.");
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(config.adminToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return apiError(c, 401, "unauthorized", "Invalid admin token.");
  return next();
};

export async function handleOpsRefunds(c: Context) {
  const refunds = await listRefunds(c.req.query("status") || undefined);
  return c.json({ data: refunds.map((r) => ({ ...r, amount: microToUsdString(r.amount_micro) })) });
}

export async function handleOpsRefundRetry(c: Context) {
  const ok = await retryRefund(c.req.param("id") ?? "");
  return ok ? c.json({ ok: true }) : apiError(c, 409, "not_retryable", "Only failed refunds can be retried.");
}

export async function handleOpsPayouts(c: Context) {
  const payouts = await listPayouts();
  return c.json({ data: payouts.map((p) => ({ ...p, amount: microToUsdString(p.amount_micro) })) });
}

export async function handleOpsWifPayoutPrepare(c: Context) {
  if (config.paymentChain !== "robinhood") return apiError(c, 400, "wrong_payment_rail", "This endpoint prepares WIF payouts.");
  const payouts = await createPayoutsFromCredits("creator", 1, {
    assetAddress: config.paymentAssetAddress, assetSymbol: "WIF", assetDecimals: 18, network: config.networkCaip2,
  });
  const pending = await listUnsentPayouts({ assetAddress: config.paymentAssetAddress, assetSymbol: "WIF", assetDecimals: 18, network: config.networkCaip2 });
  return c.json({ created: payouts.length, payouts: pending.map(p => ({ ...p, transaction: {
    chainId: Number(config.networkCaip2.split(":")[1]), from: config.payToAddress, to: config.paymentAssetAddress,
    value: "0x0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [p.account as Address, BigInt(p.amount_atomic!)] }),
  } })), next_step: "Send each transfer from the merchant wallet. Confirm each mined hash at POST /v1/ops/payouts/{id}/confirm. Keep pending batches reserved until reconciled." });
}

export async function handleOpsWifPayoutConfirm(c: Context) {
  if (config.paymentChain !== "robinhood") return apiError(c, 400, "wrong_payment_rail", "This endpoint reconciles WIF payouts.");
  const body: any = await c.req.json().catch(() => null);
  if (!/^0x[0-9a-fA-F]{64}$/.test(body?.txid ?? "")) return apiError(c, 400, "validation_error", "txid must be a 32-byte EVM transaction hash.");
  const payout = await getPayout(c.req.param("id") ?? "");
  if (!payout || payout.asset_symbol !== "WIF" || payout.network !== config.networkCaip2 || payout.asset_address.toLowerCase() !== config.paymentAssetAddress.toLowerCase()) return apiError(c, 404, "payout_not_found", "No WIF payout on this payment rail.");
  try {
    const client = await createRobinhoodPublicClient();
    const [chainId, receipt, latestBlock] = await Promise.all([client.getChainId(), client.getTransactionReceipt({ hash: body.txid as Hex }), client.getBlockNumber()]);
    if (`eip155:${chainId}` !== config.networkCaip2) throw new Error("RPC chain does not match this payout.");
    if (receipt.transactionHash.toLowerCase() !== body.txid.toLowerCase()) throw new Error("RPC transaction hash mismatch.");
    validateWifPayoutReceipt(receipt, latestBlock, { asset: payout.asset_address, sender: config.payToAddress, recipient: payout.account, amountAtomic: payout.amount_atomic! });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.timestamp < BigInt(Math.floor(new Date(payout.created_at).getTime() / 1000))) throw new Error("This transfer predates the payout batch.");
    const confirmed = await confirmWifPayout(payout.id, body.txid);
    return c.json({ payout: confirmed });
  } catch (error: any) {
    return apiError(c, 409, "payout_unconfirmed", error?.code === "23505" ? "This transfer was already used for another payout." : String(error?.shortMessage ?? error?.message ?? error));
  }
}

export async function handleOpsListings(c: Context) {
  const status = (c.req.query("status") || undefined) as any;
  const listings = await listListings(status);
  return c.json({ data: listings.map(({ signing_secret: _secret, ...rest }) => rest) });
}

export async function handleOpsListingReview(c: Context) {
  const body: any = await c.req.json().catch(() => ({}));
  if (!["approved", "rejected", "suspended"].includes(body.status)) {
    return apiError(c, 400, "validation_error", "status must be approved, rejected or suspended.");
  }
  const ok = await setListingStatus(c.req.param("id") ?? "", body.status, typeof body.note === "string" ? body.note : undefined);
  return ok ? c.json({ ok: true }) : apiError(c, 404, "listing_not_found", "No such listing.");
}
