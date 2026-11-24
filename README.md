# Earnings Tracker

A local web dashboard of every company with an upcoming earnings report, with:

- **Report timing**: pre-market ☀ / after hours ☾ / not set
- **Current price**, day change %, and pre-market / after-hours price when available
- **P/E** (trailing) and **forward P/E**
- **52-week low / high** with a range bar and % below the 52-week high
- Market cap, consensus EPS estimate (and # of analysts), last year's EPS

## Pages (left sidebar)

### ◎ Overview
- **Hot opportunities:** stocks reporting in the selected range that fit your parameters and score bullish, ranked by score. Ties go to the bigger historical earnings surprise, then market cap.
- **Bearish watch:** the lowest scores that fit your parameters.
- **Rules panel:** every rule, its points and thresholds, all editable, plus **My parameters**: minimum market cap, minimum analyst estimates, report time, and how many hot picks to show. Changes rescore every stock instantly and save to `data/store.json`.

### ☰ Stock Screen
Every company reporting in the range, with its rule outlook and score. Filter by timing, outlook, market cap and search text. Sort by any column. Click an outlook badge to see which rules scored it.

### ⟲ Historical
Every stock you favorite (★) is tracked as a paper trade from your entry price. Shows P/L, days held, totals, win rate, and whether the rules' outlook at entry was right once earnings passed. P/L is long-only.

Below the nav, the **Favorites** list shows open positions with live P/L and the next earnings date. Click one for a price chart since entry, and to edit, close or delete it.

## Outlook rules (defaults)

| Rule | + points | − points |
| --- | --- | --- |
| Earnings growth expected (±2) | Consensus EPS ≥ 10% above the same quarter last year | ≥ 10% below |
| Track record of beats (±2) | Beat EPS estimate in ≥ 3 of the last 4 quarters | 1 or fewer |
| Price trend (±1) | Price > 50-day avg > 200-day avg | Price < 50-day < 200-day |
| 52-week position (±1) | At ≥ 80% of 52-week range | ≤ 20% |
| Analyst consensus (±1) | Rating ≤ 2.0 (Buy) | ≥ 3.0 (Hold or worse) |
| Growing into valuation (±1) | Forward P/E ≥ 10% below trailing | ≥ 10% above |
| Valuation check (−1) | | Forward P/E > 50 or negative |

**Bullish** at a total of +5 or more, **bearish** at −3 or less, otherwise **neutral**. A rule with no data for a stock scores 0. These are rule-based signals from public data, not investment advice.

## Run

```bash
npm install
npm start
```

Then open http://localhost:3000 (set `PORT=xxxx` to use another port).

## Data sources

| Data | Source | Cache |
| --- | --- | --- |
| Earnings calendar, timing, EPS estimates | Nasdaq earnings calendar (`api.nasdaq.com`) | 1 hour |
| Price, P/E, 52-week range, 50/200-day averages, analyst rating | Yahoo Finance via `yahoo-finance2` (batched, 100 symbols/request) | 2 minutes |
| Last 4 quarters of EPS beats/misses | Yahoo Finance `earningsHistory` | 12 hours |

Neither needs an API key. These are unofficial endpoints, so they can change or rate-limit without notice. Quotes may be delayed.

## Files

- `server.js`: Express server: `/api/earnings`, `/api/quotes`, `/api/history`, `/api/positions`, `/api/settings`
- `store.js`: saves positions and rule settings to `data/store.json`
- `public/rules.js`: the rule engine and default rules
- `public/`: dashboard (`index.html`, `styles.css`, `app.js`)
