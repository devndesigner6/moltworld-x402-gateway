import pg from "pg";
import { config } from "../config.js";

/**
 * One SQL dialect (PostgreSQL) for every environment:
 *  - production: node-postgres against DATABASE_URL;
 *  - development and tests: PGlite, an in-process PostgreSQL build.
 * There is no hand-written in-memory fallback whose behaviour could drift.
 */
export interface Queryable {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Database extends Queryable {
  readonly kind: "postgres" | "pglite";
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS mw_requests (
     id TEXT PRIMARY KEY,
     payment_hash TEXT UNIQUE,
     kind TEXT NOT NULL DEFAULT 'model',
     resource TEXT NOT NULL,
     model_slug TEXT,
     modality TEXT,
     listing_id TEXT,
     mandate_id TEXT,
     payer TEXT NOT NULL,
     pay_to TEXT NOT NULL,
     network TEXT NOT NULL,
     asset TEXT NOT NULL,
     amount_micro BIGINT NOT NULL,
     amount_atomic TEXT,
     quote JSONB,
     payment_flow TEXT NOT NULL,
     status TEXT NOT NULL,
     txid TEXT,
     settled_at TIMESTAMPTZ,
     upstream_provider TEXT,
     upstream_model TEXT,
     upstream_cost_usd DOUBLE PRECISION,
     actual_price_micro BIGINT,
     rebate_micro BIGINT NOT NULL DEFAULT 0,
     request_sha256 TEXT,
     response_sha256 TEXT,
     response_status INTEGER,
     response_content_type TEXT,
     response_body BYTEA,
     receipt JSONB,
     error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE mw_requests ADD COLUMN IF NOT EXISTS amount_atomic TEXT`,
  `CREATE INDEX IF NOT EXISTS mw_requests_payer_idx ON mw_requests (payer, created_at)`,
  `CREATE INDEX IF NOT EXISTS mw_requests_status_idx ON mw_requests (status)`,
  `CREATE INDEX IF NOT EXISTS mw_requests_mandate_idx ON mw_requests (mandate_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS mw_refunds (
     id TEXT PRIMARY KEY,
     request_id TEXT NOT NULL UNIQUE REFERENCES mw_requests(id),
     payer TEXT NOT NULL,
     amount_micro BIGINT NOT NULL,
     reason TEXT NOT NULL,
     status TEXT NOT NULL,
     txid TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS mw_jobs (
     id TEXT PRIMARY KEY,
     request_id TEXT NOT NULL UNIQUE REFERENCES mw_requests(id),
     payer TEXT NOT NULL,
     model_slug TEXT NOT NULL,
     upstream_job_id TEXT,
     status TEXT NOT NULL,
     video_url TEXT,
     requires_proxy BOOLEAN NOT NULL DEFAULT false,
     error TEXT,
     polls INTEGER NOT NULL DEFAULT 0,
     next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     completed_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS mw_jobs_poll_idx ON mw_jobs (status, next_poll_at)`,
  `CREATE TABLE IF NOT EXISTS mw_payouts (
     id TEXT PRIMARY KEY,
     account TEXT NOT NULL,
     kind TEXT NOT NULL,
     amount_micro BIGINT NOT NULL,
     amount_atomic TEXT,
     asset_address TEXT NOT NULL DEFAULT '',
     asset_symbol TEXT NOT NULL DEFAULT 'USDC',
     asset_decimals INTEGER NOT NULL DEFAULT 6,
     network TEXT NOT NULL DEFAULT 'legacy',
     status TEXT NOT NULL,
     txid TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS mw_credits (
     id BIGSERIAL PRIMARY KEY,
     account TEXT NOT NULL,
     kind TEXT NOT NULL,
     amount_micro BIGINT NOT NULL,
     amount_atomic TEXT,
     asset_address TEXT NOT NULL DEFAULT '',
     asset_symbol TEXT NOT NULL DEFAULT 'USDC',
     asset_decimals INTEGER NOT NULL DEFAULT 6,
     network TEXT NOT NULL DEFAULT 'legacy',
     request_id TEXT NOT NULL REFERENCES mw_requests(id),
     payout_id TEXT REFERENCES mw_payouts(id),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (request_id, kind)
   )`,
  `CREATE INDEX IF NOT EXISTS mw_credits_unpaid_idx ON mw_credits (kind, account) WHERE payout_id IS NULL`,
  `ALTER TABLE mw_payouts ADD COLUMN IF NOT EXISTS amount_atomic TEXT`,
  `ALTER TABLE mw_payouts ADD COLUMN IF NOT EXISTS asset_address TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE mw_payouts ADD COLUMN IF NOT EXISTS asset_symbol TEXT NOT NULL DEFAULT 'USDC'`,
  `ALTER TABLE mw_payouts ADD COLUMN IF NOT EXISTS asset_decimals INTEGER NOT NULL DEFAULT 6`,
  `ALTER TABLE mw_payouts ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'legacy'`,
  `ALTER TABLE mw_credits ADD COLUMN IF NOT EXISTS amount_atomic TEXT`,
  `ALTER TABLE mw_credits ADD COLUMN IF NOT EXISTS asset_address TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE mw_credits ADD COLUMN IF NOT EXISTS asset_symbol TEXT NOT NULL DEFAULT 'USDC'`,
  `ALTER TABLE mw_credits ADD COLUMN IF NOT EXISTS asset_decimals INTEGER NOT NULL DEFAULT 6`,
  `ALTER TABLE mw_credits ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'legacy'`,
  `UPDATE mw_payouts SET amount_atomic = amount_micro::text WHERE amount_atomic IS NULL`,
  `UPDATE mw_credits SET amount_atomic = amount_micro::text WHERE amount_atomic IS NULL`,
  `CREATE TABLE IF NOT EXISTS mw_mandates (
     id TEXT PRIMARY KEY,
     owner TEXT NOT NULL,
     label TEXT NOT NULL,
     program_b64 TEXT NOT NULL,
     max_per_call_micro BIGINT NOT NULL,
     expiry_round BIGINT NOT NULL,
     daily_cap_micro BIGINT NOT NULL,
     allowed_models TEXT[],
     status TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     revoked_at TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS mw_mandates_owner_idx ON mw_mandates (owner)`,
  `CREATE TABLE IF NOT EXISTS mw_listings (
     id TEXT PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     description TEXT NOT NULL,
     creator TEXT NOT NULL,
     upstream_url TEXT NOT NULL,
     price_micro BIGINT NOT NULL,
     input_example JSONB,
     signing_secret TEXT NOT NULL,
     listing_nonce TEXT,
     status TEXT NOT NULL,
     review_note TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE mw_listings ADD COLUMN IF NOT EXISTS listing_nonce TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mw_listings_creator_nonce_idx ON mw_listings (creator, listing_nonce) WHERE listing_nonce IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mw_wif_payout_transaction_idx ON mw_payouts (network, lower(txid)) WHERE asset_symbol = 'WIF' AND txid IS NOT NULL`,
];

async function migrate(db: Queryable): Promise<void> {
  for (const statement of MIGRATIONS) {
    await db.query(statement);
  }
}

class PostgresDatabase implements Database {
  readonly kind = "postgres" as const;
  constructor(private readonly pool: pg.Pool) {}

  query<T = any>(text: string, params?: unknown[]) {
    return this.pool.query(text, params as any[]) as unknown as Promise<{ rows: T[] }>;
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn({ query: (t, p) => client.query(t, p as any[]) as any });
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  close() {
    return this.pool.end();
  }
}

class PgliteDatabase implements Database {
  readonly kind = "pglite" as const;
  constructor(private readonly db: any) {}

  query<T = any>(text: string, params?: unknown[]) {
    return this.db.query(text, params) as Promise<{ rows: T[] }>;
  }

  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction((tx: any) => fn({ query: (t, p) => tx.query(t, p) }));
  }

  close() {
    return this.db.close();
  }
}

let current: Promise<Database> | null = null;

export async function openDatabase(url = config.databaseUrl): Promise<Database> {
  let db: Database;
  if (url && !url.startsWith("pglite:")) {
    // BIGINT columns hold micro-USDC amounts far below 2^53; parse them as numbers.
    pg.types.setTypeParser(20, (v) => Number(v));
    const pool = new pg.Pool({ connectionString: url, max: 20, connectionTimeoutMillis: 5000 });
    db = new PostgresDatabase(pool);
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dataDir = url?.startsWith("pglite:") ? url.slice("pglite:".length) || undefined : undefined;
    db = new PgliteDatabase(new PGlite(dataDir));
  }
  await migrate(db);
  return db;
}

/** Shared database handle. Fails loudly: a gateway without its ledger must not take payments. */
export function getDatabase(): Promise<Database> {
  current ??= openDatabase().catch((err) => {
    current = null;
    throw err;
  });
  return current;
}

/** Tests use this to start from an empty in-process database. */
export async function resetDatabaseForTests(): Promise<Database> {
  if (current) {
    const db = await current.catch(() => null);
    await db?.close().catch(() => {});
  }
  current = openDatabase("pglite:");
  return current;
}
