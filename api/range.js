/**
 * Vercel Serverless Function: /api/range
 *
 * Returns the earliest and latest transaction timestamps in the database,
 * plus total count. Used by the frontend to populate the date range picker.
 */
import { getSQL } from "../lib/db.js";

export default async function handler(req, res) {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    const sql = getSQL();

    const rows = await sql`
      SELECT
        MIN(timestamp) AS earliest,
        MAX(timestamp) AS latest,
        COUNT(*)::int AS total_count
      FROM transactions
    `;

    const { earliest, latest, total_count } = rows[0];

    // Cache for 2 minutes
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=120, stale-while-revalidate=300"
    );
    return res.status(200).json({
      earliest: earliest ? Number(earliest) : null,
      latest: latest ? Number(latest) : null,
      totalTransactions: total_count,
    });
  } catch (err) {
    console.error("Range query error:", err);
    return res.status(500).json({ error: "Database query failed" });
  }
}
