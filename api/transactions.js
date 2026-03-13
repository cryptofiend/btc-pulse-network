/**
 * Vercel Serverless Function: /api/transactions
 *
 * Fetches recent large BTC transactions (>= 1 BTC) from the mempool.space API.
 * Samples blocks from the past ~week, extracts large outputs, estimates
 * confirmation times from fee rates, and returns them sorted by timestamp.
 *
 * Query params:
 *   ?blocks=80      Number of blocks to sample (default 80, max 200)
 *   ?min_btc=1      Minimum transaction amount in BTC (default 1)
 *
 * Response is cached for 10 minutes (stale-while-revalidate 1 hour) to avoid
 * hammering the upstream API and to stay within Vercel function timeouts.
 */

const API_BASE = "https://mempool.space/api";
const BTC_SATS = 100_000_000;
const PAGES_PER_BLOCK = 3;
const MAX_TRANSACTIONS = 2000;
const REQUEST_DELAY_MS = 80;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiGet(path, retries = 3) {
  const url = `${API_BASE}${path}`;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) await sleep(1000 * attempt);
      const resp = await fetch(url, {
        headers: { "User-Agent": "BTC-PulseNetwork/1.0" },
        signal: AbortSignal.timeout(20000),
      });
      if (resp.status === 429) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (resp.status === 404) return null;
      if (!resp.ok) {
        await sleep(1000);
        continue;
      }
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

function extractLargeTxs(txs, blockTime, minAmountSats) {
  const results = [];
  for (const tx of txs) {
    if (tx.vin?.[0]?.is_coinbase) continue;

    const largeOutputs = [];
    for (const vout of tx.vout || []) {
      const value = vout.value || 0;
      if (value >= minAmountSats && vout.scriptpubkey_address) {
        largeOutputs.push({
          address: vout.scriptpubkey_address,
          value,
        });
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

    // Estimate confirmation time from fee rate
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

async function processBlock(height, minAmountSats) {
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
    results.push(...extractLargeTxs(txs, blockTime, minAmountSats));
  }

  return results;
}

export default async function handler(req, res) {
  try {
    const blocksToSample = Math.min(
      parseInt(req.query.blocks) || 30,
      200
    );
    const minBtc = parseFloat(req.query.min_btc) || 1;
    const minAmountSats = Math.round(minBtc * BTC_SATS);

    // Get current tip
    const tipHeight = parseInt(await apiGet("/blocks/tip/height"));
    if (!tipHeight) {
      return res.status(502).json({ error: "Cannot reach mempool.space API" });
    }

    // Sample blocks from the past week (~1008 blocks)
    const blocksPerWeek = 1008;
    const startHeight = tipHeight - blocksPerWeek;
    const step = Math.max(1, Math.floor(blocksPerWeek / blocksToSample));

    const sampleHeights = [];
    for (let h = startHeight; h <= tipHeight; h += step) {
      sampleHeights.push(h);
    }

    // Process blocks sequentially to respect rate limits
    let allTransactions = [];
    for (const height of sampleHeights) {
      if (allTransactions.length >= MAX_TRANSACTIONS) break;
      const txs = await processBlock(height, minAmountSats);
      allTransactions.push(...txs);
    }

    // Sort by timestamp
    allTransactions.sort((a, b) => a.timestamp - b.timestamp);
    if (allTransactions.length > MAX_TRANSACTIONS) {
      allTransactions = allTransactions.slice(0, MAX_TRANSACTIONS);
    }

    // Fetch balances for up to 40 unique senders (limit to stay within timeout)
    const uniqueSenders = [
      ...new Set(allTransactions.map((tx) => tx.sender)),
    ].slice(0, 40);
    const balanceCache = {};

    for (const addr of uniqueSenders) {
      await sleep(REQUEST_DELAY_MS);
      const info = await apiGet(`/address/${addr}`);
      if (info?.chain_stats) {
        const cs = info.chain_stats;
        const bal = (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0);
        balanceCache[addr] = +(bal / BTC_SATS).toFixed(4);
      }
    }

    for (const tx of allTransactions) {
      if (balanceCache[tx.sender] !== undefined) {
        tx.sender_balance = balanceCache[tx.sender];
      }
    }

    // Cache for 10 min, stale-while-revalidate for 1 hour
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=600, stale-while-revalidate=3600"
    );
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(allTransactions);
  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
