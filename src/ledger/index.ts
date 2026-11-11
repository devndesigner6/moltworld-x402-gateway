import crypto from "crypto";
import { getDatabase, Queryable } from "./db.js";

export type RequestStatus =
  | "verified" // payment verified, not yet settled (authorization flow)
  | "settled" // funds on-chain, work not finished (upfront flow / running job)
  | "completed" // settled and served
  | "failed" // never settled; caller was not charged
  | "settle_failed" // work done but settlement failed; output withheld
  | "refund_pending"
  | "refunded";

export interface RequestRecord {
  id: string;
  payment_hash: string | null;
  kind: "model" | "market";
  resource: string;
  model_slug: string | null;
  modality: string | null;
  listing_id: string | null;
  mandate_id: string | null;
  payer: string;
  pay_to: string;
  network: string;
  asset: string;
  amount_micro: number;
  amount_atomic: string | null;
  quote: any;
  payment_flow: string;
  status: RequestStatus;
  txid: string | null;
  settled_at: Date | null;
  upstream_provider: string | null;
  upstream_model: string | null;
  upstream_cost_usd: number | null;
  actual_price_micro: number | null;
  rebate_micro: number;
  request_sha256: string | null;
  response_sha256: string | null;
  response_status: number | null;
  response_content_type: string | null;
  response_body: Uint8Array | null;
  receipt: any;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}

function normalize<T extends Record<string, any>>(row: T | undefined): T | undefined {
  if (!row) return row;
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (typeof value === "bigint") (row as any)[key] = Number(value);
    else if (key.endsWith("_micro") && typeof value === "string") (row as any)[key] = Number(value);
  }
  return row;
}

async function db(tx?: Queryable): Promise<Queryable> {
  return tx ?? (await getDatabase());
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface NewRequest {
  id: string;
  paymentHash: string;
  kind: "model" | "market";
  resource: string;
  modelSlug?: string;
  modality?: string;
  listingId?: string;
  mandateId?: string;
  payer: string;
  payTo: string;
  network: string;
  asset: string;
  amountMicro: number;
  amountAtomic?: string;
  quote?: unknown;
  paymentFlow: string;
  requestSha256: string;
}

/** Returns false when this payment was already recorded (duplicate submission). */
export async function createRequest(r: NewRequest): Promise<boolean> {
  const q = await db();
  const res = await q.query(
    `INSERT INTO mw_requests (id, payment_hash, kind, resource, model_slug, modality, listing_id, mandate_id,
       payer, pay_to, network, asset, amount_micro, amount_atomic, quote, payment_flow, status, request_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'verified',$17)
     ON CONFLICT (payment_hash) DO NOTHING
     RETURNING id`,
    [
      r.id,
      r.paymentHash,
      r.kind,
      r.resource,
      r.modelSlug ?? null,
      r.modality ?? null,
      r.listingId ?? null,
      r.mandateId ?? null,
      r.payer,
      r.payTo,
      r.network,
      r.asset,
      r.amountMicro,
      r.amountAtomic ?? String(r.amountMicro),
      r.quote === undefined ? null : JSON.stringify(r.quote),
      r.paymentFlow,
      r.requestSha256,
    ]
  );
  return res.rows.length === 1;
}

export async function markSettled(id: string, txid: string): Promise<void> {
  const q = await db();
  await q.query(
    `UPDATE mw_requests SET txid = $2, settled_at = now(),
       status = CASE WHEN status = 'verified' THEN 'settled' ELSE status END, updated_at = now()
     WHERE id = $1`,
    [id, txid]
  );
}

export interface CompletionUpdate {
  upstreamProvider?: string;
  upstreamModel?: string;
  upstreamCostUsd?: number;
  actualPriceMicro?: number;
  rebateMicro?: number;
  responseSha256: string;
  responseStatus: number;
  responseContentType: string;
  responseBody: Uint8Array | null;
  receipt: unknown;
}

export interface CompletionCredit {
  account: string;
  kind: CreditKind;
  amountMicro: number;
  amountAtomic: string;
  asset: CreditAsset;
}

export async function completeRequest(id: string, u: CompletionUpdate, credits: CompletionCredit[] = []): Promise<void> {
  const database = await getDatabase();
  await database.transaction(async (tx) => {
  await tx.query(
    `UPDATE mw_requests SET status = 'completed', upstream_provider = $2, upstream_model = $3, upstream_cost_usd = $4,
       actual_price_micro = $5, rebate_micro = $6, response_sha256 = $7, response_status = $8,
       response_content_type = $9, response_body = $10, receipt = $11, updated_at = now()
     WHERE id = $1`,
    [
      id,
      u.upstreamProvider ?? null,
      u.upstreamModel ?? null,
      u.upstreamCostUsd ?? null,
      u.actualPriceMicro ?? null,
      u.rebateMicro ?? 0,
      u.responseSha256,
      u.responseStatus,
      u.responseContentType,
      u.responseBody,
      JSON.stringify(u.receipt),
    ]
  );
  for (const credit of credits) {
    await addCredit(credit.account, credit.kind, credit.amountMicro, id, credit.amountAtomic, credit.asset, tx);
  }
  });
}

/** Records upstream details for a request whose payment is held (async jobs) without completing it. */
export async function recordUpstream(id: string, upstreamProvider: string, upstreamModel: string): Promise<void> {
  const q = await db();
  await q.query(
    `UPDATE mw_requests SET upstream_provider = $2, upstream_model = $3, updated_at = now() WHERE id = $1`,
    [id, upstreamProvider, upstreamModel]
  );
}

export async function setRequestStatus(id: string, status: RequestStatus, error?: string, tx?: Queryable): Promise<void> {
  const q = await db(tx);
  await q.query(
    `UPDATE mw_requests SET status = $2, error = COALESCE($3, error), updated_at = now() WHERE id = $1`,
    [id, status, error ?? null]
  );
}

export async function getRequest(id: string): Promise<RequestRecord | undefined> {
  const q = await db();
  const res = await q.query<RequestRecord>(`SELECT * FROM mw_requests WHERE id = $1`, [id]);
  return normalize(res.rows[0]);
}

export async function getRequestByPaymentHash(hash: string): Promise<RequestRecord | undefined> {
  const q = await db();
  const res = await q.query<RequestRecord>(`SELECT * FROM mw_requests WHERE payment_hash = $1`, [hash]);
  return normalize(res.rows[0]);
}

const CHARGED_STATUSES = `('settled','completed','settle_failed','refund_pending')`;

/**
 * Micro-USDC a mandate moved in the last 24 hours (settled or awaiting settlement).
 * Gross, not net of later rebates: the cap bounds what can leave the owner's wallet.
 */
export async function mandateSpendLast24h(mandateId: string): Promise<number> {
  const q = await db();
  const res = await q.query<{ total: string | number | null }>(
    `SELECT COALESCE(SUM(amount_micro), 0) AS total FROM mw_requests
     WHERE mandate_id = $1 AND created_at > now() - interval '24 hours'
       AND status IN ('verified','settled','completed','settle_failed')`,
    [mandateId]
  );
  return Number(res.rows[0]?.total ?? 0);
}

export interface LedgerStats {
  paidRequests: number;
  completedRequests: number;
  onchainPaidRequests: number;
  onchainCompletedRequests: number;
  onchainGrossMicro: number;
  averageRequestToSettlementMs: number | null;
  failedUncharged: number;
  refundedRequests: number;
  manualRefundReviews: number;
  grossMicro: number;
  rebatedMicro: number;
  refundedMicro: number;
  upstreamCostUsd: number;
  uniquePayers: number;
  repeatPayers: number;
  last24hRequests: number;
  byModality: Record<string, number>;
  recent: Array<{ id: string; model: string | null; modality: string | null; amount_micro: number; amount_atomic: string | null; asset: string; network: string; txid: string | null; created_at: Date; settled_at: Date | null }>;
}

export async function getStats(excludePayers: string[]): Promise<LedgerStats> {
  const q = await db();
  const ex = excludePayers.length ? excludePayers : ["__none__"];
  const totals = await q.query<any>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ${CHARGED_STATUSES} OR status = 'refunded') AS paid,
       COUNT(*) FILTER (WHERE status = 'completed') AS completed,
       COUNT(*) FILTER (WHERE txid IS NOT NULL AND status IN ('settled','completed','refund_pending','refunded')) AS onchain_paid,
       COUNT(*) FILTER (WHERE txid IS NOT NULL AND status = 'completed') AS onchain_completed,
       COALESCE(SUM(amount_micro) FILTER (WHERE txid IS NOT NULL AND status IN ('settled','completed','refund_pending','refunded')), 0) AS onchain_gross,
       AVG(EXTRACT(EPOCH FROM (settled_at - created_at)) * 1000) FILTER (WHERE txid IS NOT NULL AND status = 'completed' AND settled_at IS NOT NULL) AS avg_request_settle_ms,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed,
       COUNT(*) FILTER (WHERE status = 'refunded') AS refunded,
       COUNT(*) FILTER (WHERE status = 'refund_pending') AS manual_refund_reviews,
       COALESCE(SUM(amount_micro) FILTER (WHERE status IN ${CHARGED_STATUSES} OR status = 'refunded'), 0) AS gross,
       COALESCE(SUM(rebate_micro) FILTER (WHERE status = 'completed'), 0) AS rebated,
       COALESCE(SUM(amount_micro) FILTER (WHERE status = 'refunded'), 0) AS refunded_micro,
       COALESCE(SUM(upstream_cost_usd) FILTER (WHERE status = 'completed'), 0) AS upstream_cost,
       COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours' AND status IN ${CHARGED_STATUSES}) AS last24h
     FROM mw_requests WHERE NOT (payer = ANY($1::text[]))`,
    [ex]
  );
  const payers = await q.query<any>(
    `SELECT COUNT(*) AS unique_payers, COUNT(*) FILTER (WHERE n > 1) AS repeat_payers FROM (
       SELECT payer, COUNT(*) AS n FROM mw_requests
       WHERE status = 'completed' AND NOT (payer = ANY($1::text[])) GROUP BY payer) t`,
    [ex]
  );
  const modality = await q.query<any>(
    `SELECT COALESCE(modality, kind) AS m, COUNT(*) AS n FROM mw_requests
     WHERE status = 'completed' AND NOT (payer = ANY($1::text[])) GROUP BY 1`,
    [ex]
  );
  const recent = await q.query<any>(
    `SELECT id, model_slug AS model, modality, amount_micro, amount_atomic, asset, network, txid, created_at, settled_at FROM mw_requests
     WHERE status = 'completed' AND txid IS NOT NULL AND NOT (payer = ANY($1::text[]))
     ORDER BY created_at DESC LIMIT 10`,
    [ex]
  );
  const t = totals.rows[0];
  return {
    paidRequests: Number(t.paid),
    completedRequests: Number(t.completed),
    onchainPaidRequests: Number(t.onchain_paid),
    onchainCompletedRequests: Number(t.onchain_completed),
    onchainGrossMicro: Number(t.onchain_gross),
    averageRequestToSettlementMs: t.avg_request_settle_ms == null ? null : Number(t.avg_request_settle_ms),
    failedUncharged: Number(t.failed),
    refundedRequests: Number(t.refunded),
    manualRefundReviews: Number(t.manual_refund_reviews),
    grossMicro: Number(t.gross),
    rebatedMicro: Number(t.rebated),
    refundedMicro: Number(t.refunded_micro),
    upstreamCostUsd: Number(t.upstream_cost),
    uniquePayers: Number(payers.rows[0].unique_payers),
    repeatPayers: Number(payers.rows[0].repeat_payers),
    last24hRequests: Number(t.last24h),
    byModality: Object.fromEntries(modality.rows.map((r: any) => [r.m, Number(r.n)])),
    recent: recent.rows.map((r: any) => normalize(r)),
  };
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export interface RefundRecord {
  id: string;
  request_id: string;
  payer: string;
  amount_micro: number;
  reason: string;
  status: "pending" | "processing" | "sent" | "failed";
  txid: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
}

/** Idempotent per request: a request can be refunded at most once. */
export async function createRefund(requestId: string, payer: string, amountMicro: number, reason: string): Promise<RefundRecord | undefined> {
  const database = await getDatabase();
  return database.transaction(async (tx) => {
    const res = await tx.query<RefundRecord>(
      `INSERT INTO mw_refunds (id, request_id, payer, amount_micro, reason, status)
       VALUES ($1,$2,$3,$4,$5,'pending') ON CONFLICT (request_id) DO NOTHING RETURNING *`,
      [newId("rf"), requestId, payer, amountMicro, reason]
    );
    if (res.rows[0]) await setRequestStatus(requestId, "refund_pending", reason, tx);
    return normalize(res.rows[0]);
  });
}

/** Atomically claims refunds that are due, so two workers never pay the same one. */
export async function claimDueRefunds(limit = 10): Promise<RefundRecord[]> {
  const q = await db();
  const res = await q.query<RefundRecord>(
    `UPDATE mw_refunds SET status = 'processing', attempts = attempts + 1, updated_at = now()
     WHERE id IN (SELECT id FROM mw_refunds WHERE status = 'pending' AND next_attempt_at <= now()
                  ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [limit]
  );
  return res.rows.map((r) => normalize(r)!);
}

export async function markRefundSent(refund: RefundRecord, txid: string): Promise<void> {
  const database = await getDatabase();
  await database.transaction(async (tx) => {
    await tx.query(`UPDATE mw_refunds SET status = 'sent', txid = $2, updated_at = now() WHERE id = $1`, [refund.id, txid]);
    await setRequestStatus(refund.request_id, "refunded", undefined, tx);
  });
}

export async function markRefundRetry(refund: RefundRecord, error: string, maxAttempts = 8): Promise<void> {
  const q = await db();
  const giveUp = refund.attempts >= maxAttempts;
  // Exponential backoff: 1, 2, 4 ... minutes.
  const delayMinutes = Math.min(2 ** (refund.attempts - 1), 360);
  await q.query(
    `UPDATE mw_refunds SET status = $2, last_error = $3,
       next_attempt_at = now() + ($4 || ' minutes')::interval, updated_at = now() WHERE id = $1`,
    [refund.id, giveUp ? "failed" : "pending", error.slice(0, 1000), String(delayMinutes)]
  );
}

export async function listRefunds(status?: string, limit = 100): Promise<RefundRecord[]> {
  const q = await db();
  const res = status
    ? await q.query<RefundRecord>(`SELECT * FROM mw_refunds WHERE status = $1 ORDER BY created_at DESC LIMIT $2`, [status, limit])
    : await q.query<RefundRecord>(`SELECT * FROM mw_refunds ORDER BY created_at DESC LIMIT $1`, [limit]);
  return res.rows.map((r) => normalize(r)!);
}

export async function getRefundByRequest(requestId: string): Promise<RefundRecord | undefined> {
  const q = await db();
  const res = await q.query<RefundRecord>(`SELECT * FROM mw_refunds WHERE request_id = $1`, [requestId]);
  return normalize(res.rows[0]);
}

export async function retryRefund(id: string): Promise<boolean> {
  const q = await db();
  const res = await q.query(
    `UPDATE mw_refunds SET status = 'pending', next_attempt_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'failed' RETURNING id`,
    [id]
  );
  return res.rows.length === 1;
}

// ---------------------------------------------------------------------------
// Video jobs
// ---------------------------------------------------------------------------

export interface JobRecord {
  id: string;
  request_id: string;
  payer: string;
  model_slug: string;
  upstream_job_id: string | null;
  status: "queued" | "processing" | "completed" | "failed";
  video_url: string | null;
  requires_proxy: boolean;
  error: string | null;
  polls: number;
  completed_at: Date | null;
  created_at: Date;
}

export async function createJob(j: { id: string; requestId: string; payer: string; modelSlug: string; upstreamJobId: string }) {
  const q = await db();
  await q.query(
    `INSERT INTO mw_jobs (id, request_id, payer, model_slug, upstream_job_id, status, next_poll_at)
     VALUES ($1,$2,$3,$4,$5,'queued', now() + interval '5 seconds')`,
    [j.id, j.requestId, j.payer, j.modelSlug, j.upstreamJobId]
  );
}

export async function getJob(id: string): Promise<JobRecord | undefined> {
  const q = await db();
  const res = await q.query<JobRecord>(`SELECT * FROM mw_jobs WHERE id = $1`, [id]);
  return normalize(res.rows[0]);
}

export async function getJobByRequest(requestId: string): Promise<JobRecord | undefined> {
  const q = await db();
  const res = await q.query<JobRecord>(`SELECT * FROM mw_jobs WHERE request_id = $1`, [requestId]);
  return normalize(res.rows[0]);
}

export async function claimDueJobs(limit = 20): Promise<JobRecord[]> {
  const q = await db();
  // Lease the job for a minute so concurrent pollers skip it.
  const res = await q.query<JobRecord>(
    `UPDATE mw_jobs SET next_poll_at = now() + interval '60 seconds', polls = polls + 1, updated_at = now()
     WHERE id IN (SELECT id FROM mw_jobs WHERE status IN ('queued','processing') AND next_poll_at <= now()
                  ORDER BY next_poll_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [limit]
  );
  return res.rows.map((r) => normalize(r)!);
}

export async function updateJob(
  id: string,
  u: { status: JobRecord["status"]; videoUrl?: string | null; requiresProxy?: boolean; error?: string; nextPollSeconds?: number }
): Promise<void> {
  const q = await db();
  await q.query(
    `UPDATE mw_jobs SET status = $2, video_url = COALESCE($3, video_url), requires_proxy = COALESCE($4, requires_proxy),
       error = COALESCE($5, error), next_poll_at = now() + ($6 || ' seconds')::interval,
       completed_at = CASE WHEN $2 IN ('completed','failed') THEN now() ELSE completed_at END, updated_at = now()
     WHERE id = $1`,
    [id, u.status, u.videoUrl ?? null, u.requiresProxy ?? null, u.error ?? null, String(u.nextPollSeconds ?? 10)]
  );
}

// ---------------------------------------------------------------------------
// Credits (usage rebates, creator earnings) and payouts
// ---------------------------------------------------------------------------

export type CreditKind = "rebate" | "creator";

export interface CreditAsset {
  assetAddress: string;
  assetSymbol: string;
  assetDecimals: number;
  network: string;
}

export async function addCredit(
  account: string,
  kind: CreditKind,
  amountMicro: number,
  requestId: string,
  amountAtomic = String(amountMicro),
  asset: CreditAsset = { assetAddress: "", assetSymbol: "USDC", assetDecimals: 6, network: "legacy" },
  tx?: Queryable,
): Promise<void> {
  if (amountMicro <= 0) return;
  if (!/^\d+$/.test(amountAtomic)) throw new Error("Credit atomic amount must be a non-negative integer string.");
  const q = await db(tx);
  await q.query(
    `INSERT INTO mw_credits (account, kind, amount_micro, amount_atomic, asset_address, asset_symbol, asset_decimals, network, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (request_id, kind) DO NOTHING`,
    [account, kind, amountMicro, amountAtomic, asset.assetAddress, asset.assetSymbol, asset.assetDecimals, asset.network, requestId]
  );
}

export async function unpaidBalance(account: string, kind: CreditKind): Promise<number> {
  const q = await db();
  const res = await q.query<{ total: any }>(
    `SELECT COALESCE(SUM(amount_micro), 0) AS total FROM mw_credits WHERE account = $1 AND kind = $2 AND payout_id IS NULL`,
    [account, kind]
  );
  return Number(res.rows[0].total);
}

export interface PayoutRecord {
  id: string;
  account: string;
  kind: CreditKind;
  amount_micro: number;
  amount_atomic: string | null;
  asset_address: string;
  asset_symbol: string;
  asset_decimals: number;
  network: string;
  status: "pending" | "processing" | "sent" | "failed";
  txid: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
}

/** Rolls unpaid credits at or above the threshold into pending payouts, one per account. */
export async function createPayoutsFromCredits(kind: CreditKind, minMicro: number, asset?: CreditAsset, includeLegacyAlgorand = false): Promise<PayoutRecord[]> {
  const database = await getDatabase();
  return database.transaction(async (tx) => {
    const due = await tx.query<{ account: string; total: any; total_atomic: string; credit_ids: number[]; asset_address: string; asset_symbol: string; asset_decimals: number; network: string }>(
      `SELECT account, asset_address, asset_symbol, asset_decimals, network,
              SUM(amount_micro) AS total, SUM(amount_atomic::numeric) AS total_atomic, ARRAY_AGG(id) AS credit_ids
       FROM (SELECT * FROM mw_credits WHERE kind = $1 AND payout_id IS NULL
         AND ($3::text IS NULL OR
           (asset_address = $3 AND asset_symbol = $4 AND asset_decimals = $5 AND network = $6) OR
           ($7::boolean AND asset_address = '' AND asset_symbol = 'USDC' AND asset_decimals = 6 AND network = 'legacy'))
         FOR UPDATE SKIP LOCKED) locked_credits
       GROUP BY account, asset_address, asset_symbol, asset_decimals, network
       HAVING SUM(amount_micro) >= $2`,
      [kind, minMicro, asset?.assetAddress ?? null, asset?.assetSymbol ?? null, asset?.assetDecimals ?? null, asset?.network ?? null, includeLegacyAlgorand]
    );
    const created: PayoutRecord[] = [];
    for (const row of due.rows) {
      const id = newId("po");
      const amount = Number(row.total);
      const res = await tx.query<PayoutRecord>(
        `INSERT INTO mw_payouts (id, account, kind, amount_micro, amount_atomic, asset_address, asset_symbol, asset_decimals, network, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING *`,
        [id, row.account, kind, amount, String(row.total_atomic), row.asset_address, row.asset_symbol, row.asset_decimals, row.network]
      );
      await tx.query(
        `UPDATE mw_credits SET payout_id = $1 WHERE id = ANY($2::bigint[]) AND payout_id IS NULL`,
        [id, row.credit_ids]
      );
      created.push(normalize(res.rows[0])!);
    }
    return created;
  });
}

export async function claimPendingPayouts(limit = 16, asset?: CreditAsset, includeLegacyAlgorand = false): Promise<PayoutRecord[]> {
  const q = await db();
  const res = await q.query<PayoutRecord>(
    `UPDATE mw_payouts SET status = 'processing', attempts = attempts + 1, updated_at = now()
     WHERE id IN (SELECT id FROM mw_payouts WHERE status = 'pending'
       AND ($2::text IS NULL OR
         (asset_address = $2 AND asset_symbol = $3 AND asset_decimals = $4 AND network = $5) OR
         ($6::boolean AND asset_address = '' AND asset_symbol = 'USDC' AND asset_decimals = 6 AND network = 'legacy'))
       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [limit, asset?.assetAddress ?? null, asset?.assetSymbol ?? null, asset?.assetDecimals ?? null, asset?.network ?? null, includeLegacyAlgorand]
  );
  return res.rows.map((r) => normalize(r)!);
}

export async function markPayouts(ids: string[], status: "sent" | "pending" | "failed", txid?: string, error?: string) {
  if (!ids.length) return;
  const q = await db();
  await q.query(
    `UPDATE mw_payouts SET status = $2, txid = COALESCE($3, txid), last_error = COALESCE($4, last_error), updated_at = now()
     WHERE id = ANY($1::text[])`,
    [ids, status, txid ?? null, error ?? null]
  );
}

export async function listPayouts(account?: string, limit = 100): Promise<PayoutRecord[]> {
  const q = await db();
  const res = account
    ? await q.query<PayoutRecord>(`SELECT * FROM mw_payouts WHERE account = $1 ORDER BY created_at DESC LIMIT $2`, [account, limit])
    : await q.query<PayoutRecord>(`SELECT * FROM mw_payouts ORDER BY created_at DESC LIMIT $1`, [limit]);
  return res.rows.map((r) => normalize(r)!);
}

export async function getPayout(id: string): Promise<PayoutRecord | undefined> {
  const q = await db();
  return normalize((await q.query<PayoutRecord>(`SELECT * FROM mw_payouts WHERE id = $1`, [id])).rows[0]);
}

export async function listUnsentPayouts(asset: CreditAsset): Promise<PayoutRecord[]> {
  const q = await db();
  const result = await q.query<PayoutRecord>(`SELECT * FROM mw_payouts
    WHERE status <> 'sent' AND asset_symbol = $1 AND lower(asset_address) = lower($2) AND network = $3
    ORDER BY created_at`, [asset.assetSymbol, asset.assetAddress, asset.network]);
  return result.rows.map(row => normalize(row)!);
}

/** The caller verifies the transfer first. The unique transaction index prevents reuse. */
export async function confirmWifPayout(id: string, txid: string): Promise<PayoutRecord> {
  const database = await getDatabase();
  return database.transaction(async tx => {
    const payout = (await tx.query<PayoutRecord>(`SELECT * FROM mw_payouts WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!payout || payout.asset_symbol !== "WIF") throw new Error("No such WIF payout.");
    if (payout.status === "sent") {
      if (payout.txid?.toLowerCase() !== txid.toLowerCase()) throw new Error("Payout already reconciled with a different transaction.");
      return normalize(payout)!;
    }
    const result = await tx.query<PayoutRecord>(`UPDATE mw_payouts SET status = 'sent', txid = $2, last_error = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [id, txid.toLowerCase()]);
    return normalize(result.rows[0])!;
  });
}

// ---------------------------------------------------------------------------
// Mandates
// ---------------------------------------------------------------------------

export interface MandateRecord {
  id: string;
  owner: string;
  label: string;
  program_b64: string;
  max_per_call_micro: number;
  expiry_round: number;
  daily_cap_micro: number;
  allowed_models: string[] | null;
  status: "active" | "revoked";
  created_at: Date;
  revoked_at: Date | null;
}

export async function upsertMandate(m: Omit<MandateRecord, "created_at" | "revoked_at" | "status">): Promise<MandateRecord> {
  const q = await db();
  const res = await q.query<MandateRecord>(
    `INSERT INTO mw_mandates (id, owner, label, program_b64, max_per_call_micro, expiry_round, daily_cap_micro, allowed_models, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
     ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, daily_cap_micro = EXCLUDED.daily_cap_micro,
       allowed_models = EXCLUDED.allowed_models
     WHERE mw_mandates.status = 'active'
     RETURNING *`,
    [m.id, m.owner, m.label, m.program_b64, m.max_per_call_micro, m.expiry_round, m.daily_cap_micro, m.allowed_models]
  );
  if (!res.rows[0]) throw new Error("This mandate was revoked and cannot be re-registered.");
  return normalize(res.rows[0])!;
}

export async function getMandate(id: string): Promise<MandateRecord | undefined> {
  const q = await db();
  const res = await q.query<MandateRecord>(`SELECT * FROM mw_mandates WHERE id = $1`, [id]);
  return normalize(res.rows[0]);
}

export async function listMandates(owner: string): Promise<MandateRecord[]> {
  const q = await db();
  const res = await q.query<MandateRecord>(`SELECT * FROM mw_mandates WHERE owner = $1 ORDER BY created_at DESC`, [owner]);
  return res.rows.map((r) => normalize(r)!);
}

export async function revokeMandate(id: string): Promise<void> {
  const q = await db();
  await q.query(`UPDATE mw_mandates SET status = 'revoked', revoked_at = now() WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// Marketplace listings
// ---------------------------------------------------------------------------

export interface ListingRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  creator: string;
  upstream_url: string;
  price_micro: number;
  input_example: any;
  signing_secret: string;
  /** EIP-712 nonce for Robinhood listings; legacy Algorand listings may be null. */
  listing_nonce: string | null;
  status: "pending" | "approved" | "rejected" | "suspended";
  review_note: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function createListing(l: Omit<ListingRecord, "created_at" | "updated_at" | "status" | "review_note">) {
  const q = await db();
  const res = await q.query<ListingRecord>(
    `INSERT INTO mw_listings (id, slug, name, description, creator, upstream_url, price_micro, input_example, signing_secret, listing_nonce, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') ON CONFLICT DO NOTHING RETURNING *`,
    [l.id, l.slug, l.name, l.description, l.creator, l.upstream_url, l.price_micro, JSON.stringify(l.input_example ?? null), l.signing_secret, l.listing_nonce ?? null]
  );
  return normalize(res.rows[0]);
}

export async function getListingBySlug(slug: string): Promise<ListingRecord | undefined> {
  const q = await db();
  const res = await q.query<ListingRecord>(`SELECT * FROM mw_listings WHERE slug = $1`, [slug]);
  return normalize(res.rows[0]);
}

export async function getListing(id: string): Promise<ListingRecord | undefined> {
  const q = await db();
  const res = await q.query<ListingRecord>(`SELECT * FROM mw_listings WHERE id = $1`, [id]);
  return normalize(res.rows[0]);
}

export async function listListings(status?: ListingRecord["status"]): Promise<ListingRecord[]> {
  const q = await db();
  const res = status
    ? await q.query<ListingRecord>(`SELECT * FROM mw_listings WHERE status = $1 ORDER BY created_at DESC`, [status])
    : await q.query<ListingRecord>(`SELECT * FROM mw_listings ORDER BY created_at DESC`);
  return res.rows.map((r) => normalize(r)!);
}

export async function setListingStatus(id: string, status: ListingRecord["status"], note?: string): Promise<boolean> {
  const q = await db();
  const res = await q.query(
    `UPDATE mw_listings SET status = $2, review_note = $3, updated_at = now() WHERE id = $1 RETURNING id`,
    [id, status, note ?? null]
  );
  return res.rows.length === 1;
}

export async function creatorEarnings(creator: string, assetAddress?: string, network?: string, includeLegacyAlgorand = false): Promise<{ unpaidMicro: number; paidMicro: number; unpaidAtomic: string; paidAtomic: string; calls: number }> {
  const q = await db();
  const res = await q.query<any>(
    `SELECT COALESCE(SUM(c.amount_micro) FILTER (WHERE p.status IS DISTINCT FROM 'sent'), 0) AS unpaid,
            COALESCE(SUM(c.amount_micro) FILTER (WHERE p.status = 'sent'), 0) AS paid,
            COALESCE(SUM(c.amount_atomic::numeric) FILTER (WHERE p.status IS DISTINCT FROM 'sent'), 0)::text AS unpaid_atomic,
            COALESCE(SUM(c.amount_atomic::numeric) FILTER (WHERE p.status = 'sent'), 0)::text AS paid_atomic,
            COUNT(*) AS calls
     FROM mw_credits c LEFT JOIN mw_payouts p ON p.id = c.payout_id
     WHERE c.kind = 'creator' AND c.account = $1
       AND ($2::text IS NULL OR ($2 IS NOT NULL AND c.asset_address = $2 AND c.network = $3)
         OR ($4::boolean AND c.asset_address = '' AND c.asset_symbol = 'USDC' AND c.asset_decimals = 6 AND c.network = 'legacy'))`,
    [creator, assetAddress ?? null, network ?? null, includeLegacyAlgorand]
  );
  return { unpaidMicro: Number(res.rows[0].unpaid), paidMicro: Number(res.rows[0].paid), unpaidAtomic: String(res.rows[0].unpaid_atomic), paidAtomic: String(res.rows[0].paid_atomic), calls: Number(res.rows[0].calls) };
}
