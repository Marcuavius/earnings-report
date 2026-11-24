import { fileURLToPath } from 'node:url';
import express from 'express';
import YahooFinance from 'yahoo-finance2';
import * as store from './store.js';

const PORT = process.env.PORT || 3000;
const CALENDAR_TTL = 60 * 60 * 1000; // earnings calendar changes rarely: 1 hour
const QUOTE_TTL = 2 * 60 * 1000;     // prices: 2 minutes
const QUOTE_BATCH = 100;

const yf = typeof YahooFinance === 'function'
  ? new YahooFinance({ suppressNotices: ['yahooSurvey'] })
  : YahooFinance;

const calendarCache = new Map(); // date -> { at, rows }
const quoteCache = new Map();    // symbol -> { at, quote }

const NASDAQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

const money = (s) => {
  if (!s || s === 'N/A') return null;
  const neg = /\(.*\)/.test(s) || s.trim().startsWith('-');
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && String(s).match(/\d/) ? (neg ? -n : n) : null;
};

const TIME_MAP = {
  'time-pre-market': 'pre',
  'time-after-hours': 'after',
};

async function fetchCalendarDay(date) {
  const hit = calendarCache.get(date);
  if (hit && Date.now() - hit.at < CALENDAR_TTL) return hit.rows;

  const res = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, { headers: NASDAQ_HEADERS });
  if (!res.ok) throw new Error(`Nasdaq calendar ${date}: HTTP ${res.status}`);
  const json = await res.json();
  const rows = (json?.data?.rows || []).map((r) => ({
    date,
    symbol: r.symbol?.trim(),
    name: r.name,
    time: TIME_MAP[r.time] || 'unknown',
    marketCap: money(r.marketCap),
    fiscalQuarter: r.fiscalQuarterEnding || null,
    epsForecast: money(r.epsForecast),
    numEstimates: Number(r.noOfEsts) || null,
    lastYearEPS: money(r.lastYearEPS),
    lastYearReportDate: r.lastYearRptDt && r.lastYearRptDt !== 'N/A' ? r.lastYearRptDt : null,
  })).filter((r) => r.symbol);

  calendarCache.set(date, { at: Date.now(), rows });
  return rows;
}

// Yahoo's next earnings timestamp -> ET date + pre/after (a 4pm ET stamp means after the close).
function nextEarnings(q) {
  const ts = q.earningsTimestampStart || q.earningsTimestamp;
  if (!ts) return { nextEarningsDate: null, nextEarningsTime: null };
  const d = new Date(ts);
  const nextEarningsDate = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const hour = Number(d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const nextEarningsTime = q.isEarningsDateEstimate ? 'unknown' : hour < 12 ? 'pre' : hour >= 15 ? 'after' : 'unknown';
  return { nextEarningsDate, nextEarningsTime, nextEarningsEstimated: !!q.isEarningsDateEstimate };
}

// Nasdaq uses "BRK/B"-style class shares; Yahoo uses "BRK-B".
const toYahoo = (sym) => sym.replace(/[/.]/g, '-');

async function fetchQuotes(symbols) {
  const now = Date.now();
  const out = {};
  const missing = [];
  for (const s of symbols) {
    const hit = quoteCache.get(s);
    if (hit && now - hit.at < QUOTE_TTL) out[s] = hit.quote;
    else missing.push(s);
  }

  const batches = [];
  for (let i = 0; i < missing.length; i += QUOTE_BATCH) batches.push(missing.slice(i, i + QUOTE_BATCH));

  await Promise.all(batches.map(async (batch) => {
    const yahooToOrig = Object.fromEntries(batch.map((s) => [toYahoo(s), s]));
    try {
      const results = await yf.quote(Object.keys(yahooToOrig), {}, { validateResult: false });
      for (const q of [].concat(results || [])) {
        const orig = yahooToOrig[q.symbol];
        if (!orig) continue;
        const quote = {
          price: q.regularMarketPrice ?? null,
          changePct: q.regularMarketChangePercent ?? null,
          trailingPE: q.trailingPE ?? null,
          forwardPE: q.forwardPE ?? null,
          low52: q.fiftyTwoWeekLow ?? null,
          high52: q.fiftyTwoWeekHigh ?? null,
          preMarketPrice: q.preMarketPrice ?? null,
          postMarketPrice: q.postMarketPrice ?? null,
          marketState: q.marketState ?? null,
          exchange: q.fullExchangeName ?? null,
          marketCapLive: q.marketCap ?? null,
          name: q.longName || q.shortName || null,
          avg50: q.fiftyDayAverage ?? null,
          avg200: q.twoHundredDayAverage ?? null,
          analystRating: parseFloat(q.averageAnalystRating) || null, // 1 = Strong Buy … 5 = Sell
          analystLabel: q.averageAnalystRating ? q.averageAnalystRating.replace(/^[\d.]+\s*-\s*/, '') : null,
          change52w: q.fiftyTwoWeekChangePercent ?? null,
          ...nextEarnings(q),
        };
        quoteCache.set(orig, { at: now, quote });
        out[orig] = quote;
      }
    } catch (err) {
      console.error(`Quote batch failed (${batch.length} symbols): ${err.message}`);
    }
  }));

  return out;
}

// Last 4 quarters of actual vs. estimated EPS (beat history). Changes once a quarter: cache 12h.
const BEATS_TTL = 12 * 60 * 60 * 1000;
const beatsCache = new Map();

async function fetchBeatsOne(symbol) {
  const hit = beatsCache.get(symbol);
  if (hit && Date.now() - hit.at < BEATS_TTL) return hit.value;
  let value = null;
  try {
    const r = await yf.quoteSummary(toYahoo(symbol), { modules: ['earningsHistory'] }, { validateResult: false });
    const hist = (r?.earningsHistory?.history || []).filter((h) => h.epsActual != null && h.epsEstimate != null);
    if (hist.length) {
      const surprises = hist.map((h) => (h.surprisePercent != null ? h.surprisePercent * 100 : null)).filter((v) => v != null);
      value = {
        quarters: hist.length,
        beats: hist.filter((h) => h.epsActual > h.epsEstimate).length,
        avgSurprise: surprises.length ? surprises.reduce((a, b) => a + b, 0) / surprises.length : null,
      };
    }
  } catch { /* no history for this symbol */ }
  beatsCache.set(symbol, { at: Date.now(), value });
  return value;
}

async function fetchBeats(symbols, concurrency = 10) {
  const out = {};
  const queue = [...symbols];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const s = queue.shift();
      out[s] = await fetchBeatsOne(s);
    }
  }));
  return out;
}

function tradingDays(from, days) {
  const result = [];
  const d = new Date(`${from}T12:00:00Z`);
  while (result.length < days) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) result.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return result;
}

const app = express();
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

app.get('/api/earnings', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : today;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 5, 1), 15);
    const dates = tradingDays(from, days);

    const perDay = await Promise.all(dates.map((d) => fetchCalendarDay(d).catch((e) => {
      console.error(e.message);
      return [];
    })));
    const rows = perDay.flat();
    const symbols = [...new Set(rows.map((r) => r.symbol))];
    const [quotes, beats] = await Promise.all([fetchQuotes(symbols), fetchBeats(symbols)]);

    const merged = rows.map((r) => {
      const q = quotes[r.symbol] || {};
      const { marketCapLive, name, nextEarningsDate, nextEarningsTime, nextEarningsEstimated, ...rest } = q;
      const pctFromHigh = q.price && q.high52 ? (q.price / q.high52 - 1) * 100 : null;
      const pctFromLow = q.price && q.low52 ? (q.price / q.low52 - 1) * 100 : null;
      const rangePos = q.price != null && q.high52 > q.low52
        ? Math.min(Math.max((q.price - q.low52) / (q.high52 - q.low52), 0), 1)
        : null;
      return {
        ...r,
        ...rest,
        marketCap: marketCapLive || r.marketCap,
        pctFromHigh,
        pctFromLow,
        rangePos,
        history: beats[r.symbol] || null,
      };
    });

    res.json({ from, dates, updatedAt: new Date().toISOString(), count: merged.length, rows: merged });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const historyCache = new Map(); // `${symbol}:${from}` -> { at, points }

app.get('/api/quotes', async (req, res) => {
  const symbols = String(req.query.symbols || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 300);
  const unique = [...new Set(symbols)];
  const [quotes, beats] = await Promise.all([fetchQuotes(unique), fetchBeats(unique)]);
  for (const s of Object.keys(quotes)) quotes[s] = { ...quotes[s], history: beats[s] || null };
  res.json(quotes);
});

// Daily closes since a date: powers the position charts and "price on this date" prefill.
app.get('/api/history', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  if (!symbol || !from) return res.status(400).json({ error: 'symbol and from (YYYY-MM-DD) are required' });
  const key = `${symbol}:${from}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < QUOTE_TTL * 5) return res.json(hit.points);
  try {
    // Start a week early so a weekend/holiday entry date still has a prior close.
    const start = new Date(`${from}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 7);
    const chart = await yf.chart(toYahoo(symbol), { period1: start.toISOString().slice(0, 10), interval: '1d' }, { validateResult: false });
    const points = (chart.quotes || [])
      .filter((p) => p.close != null)
      .map((p) => ({ date: new Date(p.date).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), close: p.close }));
    historyCache.set(key, { at: Date.now(), points });
    res.json(points);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.use(express.json());

app.get('/api/store', (req, res) => res.json(store.getAll()));

app.post('/api/positions', (req, res) => {
  try {
    res.status(201).json(store.addPosition(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/positions/:id', (req, res) => {
  const p = store.updatePosition(req.params.id, req.body || {});
  return p ? res.json(p) : res.status(404).json({ error: 'not found' });
});

app.delete('/api/positions/:id', (req, res) => (
  store.deletePosition(req.params.id) ? res.status(204).end() : res.status(404).json({ error: 'not found' })
));

app.put('/api/settings', (req, res) => {
  try {
    res.json(store.setSettings(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Earnings tracker running at http://localhost:${PORT}`));
