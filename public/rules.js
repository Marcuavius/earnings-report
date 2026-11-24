// Rule engine: every stock gets points from each rule, and the total decides
// its outlook. Thresholds and points are editable on the Overview page.

const DEFAULT_SETTINGS = {
  rules: {
    epsGrowth: { on: true, points: 2, threshold: 10 },
    beatHistory: { on: true, points: 2, minBeats: 3, maxBeats: 1 },
    trend: { on: true, points: 1 },
    momentum: { on: true, points: 1, high: 80, low: 20 },
    analysts: { on: true, points: 1, buyAt: 2, sellAt: 3 },
    peCompression: { on: true, points: 1, pct: 10 },
    valuation: { on: true, points: 1, maxForwardPE: 50 },
  },
  bullishAt: 5, // large caps beat estimates often, so bullish needs several rules agreeing
  bearishAt: -3,
  params: { minCap: 2e9, minEstimates: 3, timing: 'all', topN: 8 },
};

const pctTxt = (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}%`;

// Each rule: eval(row, cfg) -> { pts, label } when it applies, or null when data is missing.
// `desc(cfg, input)` renders the rule text; `input(key)` drops in an editable number.
const RULES = [
  {
    id: 'epsGrowth',
    name: 'Earnings growth expected',
    desc: (c, input) => `Consensus EPS this quarter vs. the same quarter last year: up ≥ ${input('threshold')}% scores +, down ≥ that much scores −.`,
    eval(r, c) {
      if (r.epsForecast == null || r.lastYearEPS == null || r.lastYearEPS === 0) return null;
      const g = ((r.epsForecast - r.lastYearEPS) / Math.abs(r.lastYearEPS)) * 100;
      const label = `EPS est. ${pctTxt(g)} YoY`;
      return { pts: g >= c.threshold ? c.points : g <= -c.threshold ? -c.points : 0, label };
    },
  },
  {
    id: 'beatHistory',
    name: 'Track record of beats',
    desc: (c, input) => `Beat the EPS estimate in ≥ ${input('minBeats')} of the last 4 quarters scores +; ${input('maxBeats')} or fewer scores −.`,
    eval(r, c) {
      const h = r.history;
      if (!h || !h.quarters) return null;
      const label = `Beat ${h.beats}/${h.quarters}${h.avgSurprise != null ? `, avg ${pctTxt(h.avgSurprise)}` : ''}`;
      return { pts: h.beats >= c.minBeats ? c.points : h.beats <= c.maxBeats ? -c.points : 0, label };
    },
  },
  {
    id: 'trend',
    name: 'Price trend',
    desc: () => 'Price above its 50-day average, and the 50-day above the 200-day, scores +. The reverse scores −.',
    eval(r, c) {
      if (r.price == null || !r.avg50 || !r.avg200) return null;
      if (r.price > r.avg50 && r.avg50 > r.avg200) return { pts: c.points, label: 'Uptrend (>50d>200d)' };
      if (r.price < r.avg50 && r.avg50 < r.avg200) return { pts: -c.points, label: 'Downtrend (<50d<200d)' };
      return { pts: 0, label: r.price > r.avg50 ? 'Above 50-day' : 'Below 50-day' };
    },
  },
  {
    id: 'momentum',
    name: '52-week position',
    desc: (c, input) => `Trading at ≥ ${input('high')}% of its 52-week range scores +; ≤ ${input('low')}% scores −.`,
    eval(r, c) {
      if (r.rangePos == null) return null;
      const p = r.rangePos * 100;
      return { pts: p >= c.high ? c.points : p <= c.low ? -c.points : 0, label: `${p.toFixed(0)}% of 52-wk range` };
    },
  },
  {
    id: 'analysts',
    name: 'Analyst consensus',
    desc: (c, input) => `Average rating ≤ ${input('buyAt', 0.1)} (Buy) scores +; ≥ ${input('sellAt', 0.1)} (Hold or worse) scores −. Scale: 1 Strong Buy to 5 Sell.`,
    eval(r, c) {
      if (!r.analystRating) return null;
      const label = `Analysts ${r.analystRating.toFixed(1)}${r.analystLabel ? ` ${r.analystLabel}` : ''}`;
      return { pts: r.analystRating <= c.buyAt ? c.points : r.analystRating >= c.sellAt ? -c.points : 0, label };
    },
  },
  {
    id: 'peCompression',
    name: 'Growing into valuation',
    desc: (c, input) => `Forward P/E at least ${input('pct')}% below trailing P/E (earnings expected to rise) scores +; that much above scores −.`,
    eval(r, c) {
      if (!(r.trailingPE > 0) || !(r.forwardPE > 0)) return null;
      const d = (r.forwardPE / r.trailingPE - 1) * 100;
      return { pts: d <= -c.pct ? c.points : d >= c.pct ? -c.points : 0, label: `Fwd P/E ${pctTxt(d)} vs TTM` };
    },
  },
  {
    id: 'valuation',
    name: 'Valuation check',
    desc: (c, input) => `Forward P/E above ${input('maxForwardPE')}, or negative expected earnings, scores −.`,
    eval(r, c) {
      if (r.forwardPE == null) return null;
      if (r.forwardPE <= 0) return { pts: -c.points, label: 'Negative fwd earnings' };
      return { pts: r.forwardPE > c.maxForwardPE ? -c.points : 0, label: `Fwd P/E ${r.forwardPE.toFixed(1)}` };
    },
  },
];

function mergeSettings(saved) {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!saved || typeof saved !== 'object') return s;
  for (const id of Object.keys(s.rules)) Object.assign(s.rules[id], saved.rules?.[id] || {});
  for (const k of ['bullishAt', 'bearishAt']) if (Number.isFinite(saved[k])) s[k] = saved[k];
  Object.assign(s.params, saved.params || {});
  return s;
}

function scoreStock(row, settings) {
  const reasons = [];
  let score = 0;
  for (const rule of RULES) {
    const cfg = settings.rules[rule.id];
    if (!cfg?.on) continue;
    const res = rule.eval(row, cfg);
    if (!res) continue;
    score += res.pts;
    reasons.push({ id: rule.id, name: rule.name, ...res });
  }
  const outlook = score >= settings.bullishAt ? 'bullish' : score <= settings.bearishAt ? 'bearish' : 'neutral';
  return { score, outlook, reasons, coverage: reasons.length };
}
