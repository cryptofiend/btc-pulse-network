# BTC Pulse Network

Real-time 3D Bitcoin transaction visualization. Watch transactions pulse between wallets as electrical signals along wires, with sound effects, dynamic wallet sizing, and persistent connection wires.

## Features

- **3D force-directed graph** — wallets positioned by transaction relationships, zoomable and pannable
- **Live blockchain data** — pulls recent transactions (>= 1 BTC) from the mempool.space API
- **Pulse animation** — transactions travel as glowing pulses; size = transaction amount, speed = confirmation time
- **Laser sound effects** — each transaction triggers a synthesized "pew" sound; volume from tx size, pitch from confirmation speed
- **Persistent wires** — connections between wallets grow thicker with repeated transactions and fade over 1 day of inactivity
- **Dynamic wallet sizing** — wallet nodes grow/shrink as balances change during playback
- **Playback controls** — play/pause, rewind, skip forward, timeline scrubbing, 0.25x-10x speed
- **Filters** — minimum transaction size, minimum sender wallet balance

## Architecture

```
public/          Static frontend (Three.js, HTML, CSS)
  index.html     Entry point
  app.js         3D visualization (~1000 lines)
  style.css      Dark electric theme
  base.css       CSS reset
  transactions.json   Static fallback data

api/             Vercel serverless functions
  transactions.js     Fetches live data from mempool.space
```

## Deployment

Deployed on Vercel. Push to `main` to auto-deploy.

The `/api/transactions` endpoint fetches live blockchain data and caches responses for 10 minutes. The frontend tries the live API first, then falls back to the static JSON file.

## Local Development

```bash
npm i -g vercel
vercel dev
```

## Credits

Built with [Perplexity Computer](https://www.perplexity.ai/computer).
Data from [mempool.space](https://mempool.space).
