/**
 * Vercel Serverless Function: /api/transactions
 *
 * Queries the Postgres database for transactions in a date range.
 *
 * Query params:
 *   ?start=<unix_timestamp>  Start of range (required)
 *   ?end=<unix_timestamp>    End of range (required)
 *   ?min_btc=1               Minimum transaction amount (default 1)
 *   ?limit=2000              Max results (default 2000)
 *
 * Falls back to mempool.space live fetch if DATABASE_URL is not configured.
 */
import { getSQL } from "../lib/db.js";

export default async function handler(req, res) {
  // If no database is configured, fall back to the old live-fetch behavior
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({
      error: "Database not configured. Use static data fallback.",
    });
  }

  try {
    const sql = getSQL();

    const start = parseInt(req.query.start);
    const end = parseInt(req.query.end);
    const minBtc = parseFloat(req.query.min_btc) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 2000, 5000);

    if (!start || !end || start >= end) {
      return res.status(400).json({
        error: "Invalid date range. Provide ?start=<unix>&end=<unix>",
      });
    }

    const rows = await sql`
      SELECT txid, timestamp, amount_btc, sender, receiver, sender_balance, confirmation_time_min
      FROM transactions
      WHERE timestamp >= ${start}
        AND timestamp <= ${end}
        AND amount_btc >= ${minBtc}
      ORDER BY timestamp ASC
      LIMIT ${limit}
    `;

    // Cache for 5 minutes
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=600"
    );
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(rows);
  } catch (err) {
    console.error("Query error:", err);
    return res.status(500).json({ error: "Database query failed" });
  }
}
