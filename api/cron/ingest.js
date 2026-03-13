/**
 * Vercel Cron Function: /api/cron/ingest
 *
 * Runs every 15 minutes. Fetches new Bitcoin blocks since the last processed
 * height, extracts large transactions (>= 1 BTC), and inserts them into Postgres.
 *
 * On first run (or after reset), backfills the past ~7 days of blocks.
 *
 * Protected by CRON_SECRET to prevent unauthorized invocation.
 */
import { getSQL, initSchema, getMeta, setMeta } from "../../lib/db.js";

const API_BASE = "https://mempool.space/api";
const BTC_SATS = 100_000_000;
const MIN_AMOUNT_SATS = 1 * BTC_SATS;
const PAGES_PER_BLOCK = 3;
const REQUEST_DELAY_MS = 100;
const BLOCKS_PER_WEEK = 1008;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiGet(path, retries = 3) {
  const url = `${API_BASE}${path}`;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) await sleep(1500 * attempt);
      const resp = await fetch(url, {
        headers: { "User-Agent": "BTC-PulseNetwork/1.0" },
        signal: AbortSignal.timeout(20000),
      });
      if (resp.status === 429) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (resp.status === 404) return null;
      if (!resp.ok) continue;
      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch {
      await sleep(1000);
    }
  }
  return null;
}

function extractLargeTxs(txs, blockTime) {
  const results = [];
  for (const tx of txs) {
    if (tx.vin?.[0]?.is_coinbase) continue;

    const largeOutputs = [];
    for (const vout of tx.vout || []) {
      const value = vout.value || 0;
      if (value >= MIN_AMOUNT_SATS && vout.scriptpubkey_address) {
        largeOutputs.push({ address: vout.scriptpubkey_address, value });
      }
    }
    if (!largeOutputs.length) continue;

    let senderAddr = "";
    let senderTotalInput = 0;
    for (const vin of tx.vin || []) {
      const prevout = vin.prevout || {};
      if (prevout.scriptpubkey_address) {
        if (!senderAddr) senderAddr = prevout.scriptpubkey_address;
        senderTotalInput += prevout.value || 0;
      }
    }
    if (!senderAddr) continue;

    const mainOutput = largeOutputs.reduce((a, b) =>
      b.value > a.value ? b : a
    );

    const fee = tx.fee || 0;
    const size = tx.size || 250;
    const feeRate = fee / Math.max(size, 1);
    let confTime;
    if (feeRate > 50) confTime = 10 + 5 * (50 / Math.max(feeRate, 1));
    else if (feeRate > 20) confTime = 15 + 15 * (50 / Math.max(feeRate, 1));
    else if (feeRate > 5) confTime = 30 + 30 * (20 / Math.max(feeRate, 1));
    else confTime = 60 + 60 * (5 / Math.max(feeRate, 0.1));
    confTime = Math.min(confTime, 180);

    results.push({
      txid: tx.txid,
      timestamp: blockTime,
      amount_btc: +(mainOutput.value / BTC_SATS).toFixed(8),
      sender: senderAddr,
      receiver: mainOutput.address,
      sender_balance: +(senderTotalInput / BTC_SATS).toFixed(4),
      confirmation_time_min: +confTime.toFixed(1),
    });
  }
  return results;
}

async function processBlock(height) {
  const blockHash = await apiGet(`/block-height/${height}`);
  if (!blockHash) return [];

  const blockInfo = await apiGet(`/block/${blockHash}`);
  if (!blockInfo) return [];

  const blockTime = blockInfo.timestamp || 0;
  const txcount = blockInfo.tx_count || 0;
  const results = [];

  const pages = Math.min(PAGES_PER_BLOCK, Math.ceil(txcount / 25));
  for (let page = 0; page < pages; page++) {
    await sleep(REQUEST_DELAY_MS);
    const txs = await apiGet(`/block/${blockHash}/txs/${page * 25}`);
    if (!txs) break;
    results.push(...extractLargeTxs(txs, blockTime));
  }
  return results;
}

async function insertTransactions(txns) {
  if (!txns.length) return 0;
  const sql = getSQL();
  let inserted = 0;

  // Batch insert in chunks of 50
  for (let i = 0; i < txns.length; i += 50) {
    const chunk = txns.slice(i, i + 50);
    for (const tx of chunk) {
      try {
        await sql`
          INSERT INTO transactions (txid, timestamp, amount_btc, sender, receiver, sender_balance, confirmation_time_min)
          VALUES (${tx.txid}, ${tx.timestamp}, ${tx.amount_btc}, ${tx.sender}, ${tx.receiver}, ${tx.sender_balance}, ${tx.confirmation_time_min})
          ON CONFLICT (txid) DO NOTHING
        `;
        inserted++;
      } catch (e) {
        // Skip duplicates
        if (!e.message?.includes("duplicate")) {
          console.error("Insert error:", e.message);
        }
      }
    }
  }
  return inserted;
}

export default async function handler(req, res) {
  // Allow cron calls (with secret) and manual calls (without secret)
  // Vercel cron sets authorization header automatically
  const authHeader = req.headers["authorization"];
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const isManualCall = !cronSecret || !authHeader;
  if (!isCronCall && !isManualCall) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    await initSchema();

    // Get current blockchain tip
    const tipHeight = parseInt(await apiGet("/blocks/tip/height"));
    if (!tipHeight) {
      return res.status(502).json({ error: "Cannot reach mempool.space" });
    }

    // Determine where to start
    let lastProcessed = await getMeta("last_block_height");
    let startHeight;
    let isBackfill = false;

    if (!lastProcessed) {
      // First run — backfill past week, sampling every 13th block (~80 blocks)
      startHeight = tipHeight - BLOCKS_PER_WEEK;
      isBackfill = true;
      console.log(`Backfill: scanning from ${startHeight} to ${tipHeight}`);
    } else {
      startHeight = parseInt(lastProcessed) + 1;
      if (startHeight > tipHeight) {
        return res.status(200).json({ message: "Already up to date", tipHeight });
      }
      console.log(`Incremental: blocks ${startHeight} to ${tipHeight}`);
    }

    let allTxns = [];
    const blocksToProcess = tipHeight - startHeight + 1;

    if (isBackfill) {
      // For backfill, sample every ~13th block to stay within function timeout
      const step = Math.max(1, Math.floor(BLOCKS_PER_WEEK / 80));
      for (let h = startHeight; h <= tipHeight; h += step) {
        const txns = await processBlock(h);
        allTxns.push(...txns);
        // Stay within ~100s function time
        if (allTxns.length > 2000) break;
      }
    } else {
      // For incremental, process new blocks since last run
      // Cap at 144 blocks per run (~1 day of blocks) to stay within timeout
      const maxBlocks = Math.min(blocksToProcess, 144);
      for (let h = startHeight; h < startHeight + maxBlocks; h++) {
        const txns = await processBlock(h);
        allTxns.push(...txns);
      }
    }

    // Insert into database
    const inserted = await insertTransactions(allTxns);

    // Update last processed height
    await setMeta("last_block_height", String(tipHeight));

    return res.status(200).json({
      success: true,
      isBackfill,
      blocksScanned: isBackfill ? "~80 sampled" : blocksToProcess,
      transactionsFound: allTxns.length,
      transactionsInserted: inserted,
      tipHeight,
    });
  } catch (err) {
    console.error("Ingest error:", err);
    return res.status(500).json({ error: err.message });
  }
}
