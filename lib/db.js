/**
 * Shared database utilities for BTC Pulse Network.
 * Uses Neon serverless driver for Postgres.
 */
import { neon } from "@neondatabase/serverless";

let _sql = null;

export function getSQL() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql;
}

/**
 * Initialize the database schema (idempotent).
 */
export async function initSchema() {
  const sql = getSQL();

  await sql`
    CREATE TABLE IF NOT EXISTS transactions (
      txid              TEXT PRIMARY KEY,
      timestamp         BIGINT NOT NULL,
      amount_btc        DOUBLE PRECISION NOT NULL,
      sender            TEXT NOT NULL,
      receiver          TEXT NOT NULL,
      sender_balance    DOUBLE PRECISION DEFAULT 0,
      confirmation_time_min DOUBLE PRECISION DEFAULT 60,
      created_at        TIMESTAMPTZ DEFAULT now()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_transactions_timestamp
    ON transactions (timestamp)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ingest_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;

  return true;
}

/**
 * Get a metadata value.
 */
export async function getMeta(key) {
  const sql = getSQL();
  const rows = await sql`SELECT value FROM ingest_metadata WHERE key = ${key}`;
  return rows.length > 0 ? rows[0].value : null;
}

/**
 * Set a metadata value (upsert).
 */
export async function setMeta(key, value) {
  const sql = getSQL();
  await sql`
    INSERT INTO ingest_metadata (key, value)
    VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = ${value}
  `;
}
