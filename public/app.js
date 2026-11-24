/* global DEFAULT_SETTINGS, RULES, mergeSettings, scoreStock */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const REFRESH_MS = 2 * 60 * 1000;

const state = {
  rows: [],            // upcoming earnings in the selected range, scored by the rules
  positions: [],       // favorites / paper positions, saved on the server
  quotes: {},          // live quotes for favorited symbols
  settings: mergeSettings(null),
  view: ['overview', 'screen', 'history'].includes(load('view')) ? load('view') : 'overview',
  time: 'all',
  outlook: 'all',
  perfStatus: 'all',
  sort: load('sort', { key: 'score', dir: -1 }),
  rangeLabel: '',
};

function load(key, fallback = null) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage unavailable */ }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

// ---------- dates ----------
const nyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 864e5);
function mondayOf(iso) {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  if (dow === 0) return addDays(iso, 1); // on weekends "this week" means the upcoming one
  if (dow === 6) return addDays(iso, 2);
  return addDays(iso, 1 - dow);
}
const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtShort = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' }) : '—');
const fmtMD = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');

// ---------- formatting ----------
const fmtNum = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtCap = (v) => {
  if (!v) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toLocaleString()}`;
};
const fmtPct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const fmtMoney = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '-' : v > 0 ? '+' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const fmtPE = (v) => (v == null || v <= 0 ? '<span class="muted">—</span>' : fmtNum(v, 1));
const fmtEPS = (v) => (v == null ? '—' : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`);
const fmtScore = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}`);
const cls = (v) => (v == null || !Number.isFinite(v) ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TIME_LABEL = { pre: '☀ Pre-market', after: '☾ After hours', unknown: 'Not set' };
const TIME_SHORT = { pre: '☀ Pre', after: '☾ AH', unknown: '' };
const TIME_ORDER = { pre: 0, unknown: 1, after: 2 };
const OUTLOOK = { bullish: '▲ Bullish', neutral: '● Neutral', bearish: '▼ Bearish' };
const NEUTRAL_BAND = 5; // a neutral call counts as right if the stock moved less than ±5%

// ---------- scoring ----------
const withRange = (q) => ({
  ...q,
  rangePos: q.price != null && q.high52 > q.low52 ? Math.min(Math.max((q.price - q.low52) / (q.high52 - q.low52), 0), 1) : null,
});

function applyScores() {
  for (const r of state.rows) {
    Object.assign(r, scoreStock(r, state.settings));
    r.beats = r.history ? r.history.beats : null;
  }
}

function qualifies(r) {
  const p = state.settings.params;
  return (r.marketCap || 0) >= Number(p.minCap || 0)
    && (!p.minEstimates || (r.numEstimates || 0) >= p.minEstimates)
    && (p.timing === 'all' || r.time === p.timing);
}

// Hot = best bullish scores; ties go to the bigger historical beat, then size.
const byOpportunity = (a, b) => b.score - a.score
  || (b.history?.avgSurprise ?? -1e9) - (a.history?.avgSurprise ?? -1e9)
  || (b.marketCap || 0) - (a.marketCap || 0);

// ---------- position math ----------
function calc(p) {
  const q = state.quotes[p.symbol] || {};
  const closed = p.exitPrice != null;
  const current = closed ? p.exitPrice : q.price ?? null;
  const pl = current != null ? (current - p.entryPrice) * (p.shares || 0) : null;
  const plPct = current != null ? (current / p.entryPrice - 1) * 100 : null;
  const today = nyToday();
  const days = daysBetween(p.entryDate, closed ? p.exitDate || today : today);

  const earningsDate = p.earningsDate || (q.nextEarningsDate >= p.entryDate ? q.nextEarningsDate : null);
  const earningsTime = p.earningsDate ? p.earningsTime : q.nextEarningsTime;
  const nextEarnings = q.nextEarningsDate && q.nextEarningsDate >= today ? q.nextEarningsDate : earningsDate >= today ? earningsDate : null;
  const nextEarningsTime = nextEarnings === q.nextEarningsDate ? q.nextEarningsTime : earningsTime;

  // A call is graded once earnings have happened (or the trade is closed).
  let call = 'pending';
  const reported = earningsDate && (earningsDate < today || (closed && p.exitDate >= earningsDate));
  if (p.sentiment && plPct != null && (reported || closed)) {
    const right = p.sentiment === 'bullish' ? plPct > 0
      : p.sentiment === 'bearish' ? plPct < 0
        : Math.abs(plPct) <= NEUTRAL_BAND;
    call = right ? 'right' : 'wrong';
  }
  return { q, closed, current, pl, plPct, days, earningsDate, earningsTime, nextEarnings, nextEarningsTime, call };
}

const openPositions = () => state.positions.filter((p) => p.exitPrice == null);
const openFor = (symbol) => openPositions().find((p) => p.symbol === symbol);

// ---------- data ----------
async function fetchEarnings() {
  const params = new URLSearchParams({ from: $('#from').value, days: $('#days').value });
  const json = await api(`/api/earnings?${params}`);
  state.rows = json.rows;
  applyScores();
  return json;
}

async function fetchStore() {
  const s = await api('/api/store');
  state.positions = s.positions;
  state.settings = mergeSettings(s.settings);
}

async function fetchFavQuotes() {
  const syms = [...new Set(state.positions.map((p) => p.symbol))];
  if (!syms.length) return;
  Object.assign(state.quotes, await api(`/api/quotes?symbols=${encodeURIComponent(syms.join(','))}`));
}

let firstLoad = true;
async function refreshAll() {
  const btn = $('#refresh');
  btn.disabled = true;
  $('#updated').textContent = firstLoad ? 'Loading earnings, quotes and beat history…' : 'Refreshing…';
  try {
    await fetchStore(); // settings first, so scores use your rules
    const [json] = await Promise.all([fetchEarnings(), fetchFavQuotes()]);
    state.rangeLabel = `${fmtShort(json.dates[0])} – ${fmtShort(json.dates.at(-1))}`;
    $('#updated').textContent = `Updated ${new Date(json.updatedAt).toLocaleTimeString()} · ${state.rangeLabel}`;
    if (firstLoad) renderRulesPanel();
    firstLoad = false;
  } catch (err) {
    $('#updated').textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
    renderAll();
  }
}

// ---------- shared bits ----------
function rangeCell(r) {
  if (r.rangePos == null) return '<span class="muted">—</span>';
  const pos = (r.rangePos * 100).toFixed(1);
  const tone = r.rangePos >= 0.9 ? 'near-high' : r.rangePos <= 0.1 ? 'near-low' : '';
  return `<div class="r52" title="Price is ${pos}% of the way from the 52-week low to the high">
    <span class="lo">${fmtNum(r.low52)}</span>
    <span class="bar ${tone}"><i style="left:${pos}%"></i></span>
    <span class="hi">${fmtNum(r.high52)}</span>
  </div>`;
}

function priceCell(r) {
  const ext = r.marketState?.startsWith('PRE') && r.preMarketPrice
    ? `Pre ${fmtNum(r.preMarketPrice)}`
    : (r.marketState?.startsWith('POST') || r.marketState === 'CLOSED') && r.postMarketPrice
      ? `AH ${fmtNum(r.postMarketPrice)}`
      : '';
  return `${fmtNum(r.price)}${ext ? `<span class="ext">${ext}</span>` : ''}`;
}

const tag = (s, score) => (s ? `<span class="tag ${s}">${OUTLOOK[s]}${score != null ? ` ${fmtScore(score)}` : ''}</span>` : '<span class="muted">—</span>');

const outlookBtn = (r) => `<button class="score-btn ${r.outlook}" data-why="${esc(r.symbol)}" data-date="${r.date}" title="See which rules scored this">${OUTLOOK[r.outlook]} <b>${fmtScore(r.score)}</b></button>`;

const starBtn = (r) => {
  const on = !!openFor(r.symbol);
  return `<button class="star-btn ${on ? 'on' : ''}" data-star="${esc(r.symbol)}" data-date="${r.date}" title="${on ? 'Open tracked position' : 'Favorite & track from an entry price'}">★</button>`;
};

const chips = (reasons) => reasons.filter((x) => x.pts !== 0)
  .sort((a, b) => b.pts - a.pts)
  .map((x) => `<span class="chip ${x.pts > 0 ? 'pos' : 'neg'}">${x.pts > 0 ? '+' : ''}${x.pts} ${esc(x.label)}</span>`).join('');

// ---------- sidebar ----------
function renderSidebar() {
  const v = state.view;
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  const q = state.rows.filter(qualifies);
  $('#navOverview').textContent = q.filter((r) => r.outlook === 'bullish').length || '';
  $('#navScreen').textContent = state.rows.length || '';
  $('#navHistory').textContent = state.positions.length || '';

  const open = openPositions().map((p) => ({ p, c: calc(p) }));
  const cost = open.reduce((s, { p }) => s + p.entryPrice * (p.shares || 0), 0);
  const pl = open.reduce((s, { c }) => s + (c.pl || 0), 0);
  $('#sideTotal').innerHTML = open.length
    ? `<div class="big ${cls(pl)}">${fmtMoney(pl)}</div>
       <div class="muted">${fmtPct(cost ? (pl / cost) * 100 : null)} open P/L · ${open.length} position${open.length === 1 ? '' : 's'} · $${fmtNum(cost)} cost</div>`
    : '';

  if (!open.length) {
    $('#favList').innerHTML = '<p class="fav-empty">No favorites yet. Click ★ on any stock to track it from an entry price, or use <b>+ Add</b> for any ticker.</p>';
    return;
  }
  open.sort((a, b) => (a.c.nextEarnings || '9999').localeCompare(b.c.nextEarnings || '9999') || (b.c.plPct ?? 0) - (a.c.plPct ?? 0));
  const today = nyToday();
  $('#favList').innerHTML = open.map(({ p, c }) => {
    const until = c.nextEarnings ? daysBetween(today, c.nextEarnings) : null;
    const when = c.nextEarnings
      ? `<span class="${until <= 7 ? 'soon' : ''}">Earnings ${until === 0 ? 'today' : until === 1 ? 'tomorrow' : fmtMD(c.nextEarnings)} ${TIME_SHORT[c.nextEarningsTime] || ''}</span>`
      : '<span>No upcoming date</span>';
    return `<button class="fav" data-pos="${p.id}">
      <div class="fav-top"><b>${esc(p.symbol)}</b>${p.sentiment ? tag(p.sentiment, p.score) : ''}</div>
      <div class="fav-name">${esc(p.name || c.q.name || '')}</div>
      <div class="fav-mid">
        <span>${fmtNum(c.current)} <small class="${cls(c.q.changePct)}">${fmtPct(c.q.changePct)}</small></span>
        <span class="fav-pl ${cls(c.pl)}">${fmtPct(c.plPct)}</span>
      </div>
      <div class="fav-bot">${when}<span class="${cls(c.pl)}">${fmtMoney(c.pl)}</span></div>
    </button>`;
  }).join('');
}

// ---------- overview ----------
function hotCard(r) {
  return `<div class="hot-card">
    <div class="card-top">
      <div class="hc-id">
        <b>${esc(r.symbol)}</b>
        <small class="muted">${esc((r.name || '').slice(0, 34))}</small>
      </div>
      ${starBtn(r)}
    </div>
    <div class="hc-when">${fmtShort(r.date)} · <span class="pill ${r.time}">${TIME_LABEL[r.time]}</span></div>
    <div class="hc-score">${outlookBtn(r)}</div>
    <div class="card-meta">
      <div><span>Price</span>${fmtNum(r.price)} <small class="${cls(r.changePct)}">${fmtPct(r.changePct)}</small></div>
      <div><span>P/E · Fwd</span>${fmtPE(r.trailingPE)} · ${fmtPE(r.forwardPE)}</div>
      <div><span>EPS est. / last yr</span>${fmtEPS(r.epsForecast)} / ${fmtEPS(r.lastYearEPS)}</div>
    </div>
    ${rangeCell(r)}
    <div class="chips">${chips(r.reasons)}</div>
  </div>`;
}

function renderOverview() {
  const q = state.rows.filter(qualifies);
  const bull = q.filter((r) => r.outlook === 'bullish').sort(byOpportunity);
  const bear = q.filter((r) => r.outlook === 'bearish').sort((a, b) => a.score - b.score || (b.marketCap || 0) - (a.marketCap || 0));
  const favSyms = new Set(openPositions().map((p) => p.symbol));
  const favReporting = state.rows.filter((r) => favSyms.has(r.symbol)).length;

  $('#ovStats').innerHTML = [
    [q.length, `Fit your parameters (of ${state.rows.length})`, ''],
    [bull.length, '▲ Bullish', 'up'],
    [q.filter((r) => r.outlook === 'neutral').length, '● Neutral', ''],
    [bear.length, '▼ Bearish', 'down'],
    [favReporting, '★ Favorites reporting', ''],
  ].map(([v, l, c]) => `<div class="stat"><b class="${c}">${v}</b><span>${l}</span></div>`).join('');

  const top = bull.slice(0, state.settings.params.topN || 8);
  $('#hotHint').textContent = `${state.rangeLabel} · top ${top.length} of ${bull.length} bullish`;
  $('#hot').innerHTML = top.length
    ? top.map(hotCard).join('')
    : '<p class="empty">No stocks reach the bullish score with your current rules and parameters. Try lowering the bullish threshold or market cap minimum.</p>';

  $('#bearList').innerHTML = bear.slice(0, 6).map((r) => `<tr>
      <td>${starBtn(r)}</td>
      <td><div class="co"><b>${esc(r.symbol)}</b><small>${esc(r.name)}</small></div></td>
      <td>${fmtShort(r.date)} <span class="pill ${r.time}">${TIME_SHORT[r.time] || 'Not set'}</span></td>
      <td>${outlookBtn(r)}</td>
      <td class="num">${fmtNum(r.price)}</td>
      <td><div class="chips">${chips(r.reasons.filter((x) => x.pts < 0))}</div></td>
    </tr>`).join('') || '<tr><td class="empty">No bearish setups that fit your parameters.</td></tr>';
}

// ---------- rules panel ----------
const getPath = (path) => path.split('.').reduce((o, k) => o?.[k], state.settings);
function setPath(path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], state.settings)[last] = val;
}

function renderRulesPanel() {
  const s = state.settings;
  $('#rulesList').innerHTML = RULES.map((rule) => {
    const cfg = s.rules[rule.id];
    const input = (key, step = 1) => `<input type="number" class="inline-num" step="${step}" data-path="rules.${rule.id}.${key}" value="${cfg[key]}">`;
    return `<div class="rule ${cfg.on ? '' : 'off'}">
      <div class="rule-head">
        <label class="check"><input type="checkbox" data-path="rules.${rule.id}.on" ${cfg.on ? 'checked' : ''}> <b>${rule.name}</b></label>
        <span class="pts">±${input('points')} pts</span>
      </div>
      <p>${rule.desc(cfg, input)}</p>
    </div>`;
  }).join('');
  const num = (path, step = 1) => `<input type="number" class="inline-num" step="${step}" data-path="${path}" value="${getPath(path)}">`;
  $('#thresholds').innerHTML = `<div class="rule-head"><b>Outlook</b></div>
    <p><span class="tag bullish">▲ Bullish</span> total ≥ ${num('bullishAt')} &nbsp; <span class="tag bearish">▼ Bearish</span> total ≤ ${num('bearishAt')}<br>Anything in between is <span class="tag neutral">● Neutral</span>. Rules without data for a stock score 0.</p>`;

  const p = s.params;
  const capOpts = [[0, 'Any'], [300e6, '$300M+'], [2e9, '$2B+'], [10e9, '$10B+'], [50e9, '$50B+'], [200e9, '$200B+']];
  $('#params').innerHTML = `
    <label class="field">Min market cap
      <select data-path="params.minCap">${capOpts.map(([v, l]) => `<option value="${v}" ${Number(p.minCap) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </label>
    <label class="field">Min analyst estimates ${num('params.minEstimates')}</label>
    <label class="field">Report time
      <select data-path="params.timing">${[['all', 'Any'], ['pre', '☀ Pre-market'], ['after', '☾ After hours']].map(([v, l]) => `<option value="${v}" ${p.timing === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </label>
    <label class="field">Hot picks to show ${num('params.topN')}</label>`;
}

let saveTimer;
function onSettingChange(e) {
  const el = e.target.closest('[data-path]');
  if (!el) return;
  let val;
  if (el.type === 'checkbox') val = el.checked;
  else if (el.dataset.path === 'params.timing') val = el.value;
  else {
    val = Number(el.value);
    if (!Number.isFinite(val) || el.value === '') return; // wait for a full number
  }
  setPath(el.dataset.path, val);
  if (el.type === 'checkbox') el.closest('.rule')?.classList.toggle('off', !val);
  applyScores();
  renderAll();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api('/api/settings', { method: 'PUT', body: state.settings }).catch((err) => console.error(err)), 500);
}
$('.rules-panel').addEventListener('input', onSettingChange);
$('#resetRules').addEventListener('click', () => {
  if (!confirm('Reset all rules and parameters to the defaults?')) return;
  state.settings = mergeSettings(null);
  renderRulesPanel();
  applyScores();
  renderAll();
  api('/api/settings', { method: 'PUT', body: state.settings }).catch((err) => console.error(err));
});

// ---------- stock screen ----------
function filtered() {
  const q = $('#search').value.trim().toLowerCase();
  const minCap = Number($('#mincap').value);
  return state.rows.filter((r) => (state.time === 'all' || r.time === state.time)
    && (state.outlook === 'all' || r.outlook === state.outlook)
    && (!minCap || (r.marketCap || 0) >= minCap || openFor(r.symbol))
    && (!q || r.symbol.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q)));
}

function compare(a, b) {
  const { key, dir } = state.sort;
  let av = a[key];
  let bv = b[key];
  if (key === 'time') { av = TIME_ORDER[av]; bv = TIME_ORDER[bv]; }
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (typeof av === 'string') return av.localeCompare(bv) * dir;
  return (av - bv) * dir || (key === 'score' ? byOpportunity(a, b) : 0);
}

function rowHtml(r) {
  const h = r.history;
  return `<tr>
    <td>${starBtn(r)}</td>
    <td><div class="co">
      <a href="https://finance.yahoo.com/quote/${encodeURIComponent(r.symbol.replace(/[/.]/g, '-'))}" target="_blank" rel="noopener">${esc(r.symbol)}</a>
      <small title="${esc(r.name)}">${esc(r.name)}</small>
    </div></td>
    <td>${fmtShort(r.date)}</td>
    <td><span class="pill ${r.time}">${TIME_LABEL[r.time]}</span></td>
    <td>${outlookBtn(r)}</td>
    <td class="num">${priceCell(r)}</td>
    <td class="num ${cls(r.changePct)}">${fmtPct(r.changePct)}</td>
    <td class="num">${fmtCap(r.marketCap)}</td>
    <td class="num">${fmtPE(r.trailingPE)}</td>
    <td class="num">${fmtPE(r.forwardPE)}</td>
    <td>${rangeCell(r)}</td>
    <td class="num ${cls(r.pctFromHigh)}">${fmtPct(r.pctFromHigh)}</td>
    <td class="num">${fmtEPS(r.epsForecast)}${r.numEstimates ? `<span class="ext">${r.numEstimates} est.</span>` : ''}</td>
    <td class="num">${fmtEPS(r.lastYearEPS)}</td>
    <td class="num">${h ? `${h.beats}/${h.quarters}` : '—'}${h?.avgSurprise != null ? `<span class="ext">avg ${fmtPct(h.avgSurprise)}</span>` : ''}</td>
    <td class="num">${r.analystRating ? r.analystRating.toFixed(1) : '—'}${r.analystLabel ? `<span class="ext">${esc(r.analystLabel)}</span>` : ''}</td>
  </tr>`;
}

function renderScreen() {
  const rows = filtered().sort(compare);
  const n = (f) => rows.filter(f).length;
  $('#stats').innerHTML = [
    [rows.length, 'Reporting', ''],
    [n((r) => r.time === 'pre'), '☀ Pre-market', ''],
    [n((r) => r.time === 'after'), '☾ After hours', ''],
    [n((r) => r.outlook === 'bullish'), '▲ Bullish', 'up'],
    [n((r) => r.outlook === 'bearish'), '▼ Bearish', 'down'],
  ].map(([v, l, c]) => `<div class="stat"><b class="${c}">${v}</b><span>${l}</span></div>`).join('');

  $$('#tbl thead th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sort.key);
    th.classList.toggle('desc', th.dataset.sort === state.sort.key && state.sort.dir < 0);
  });

  let html = '';
  if ($('#group').checked) {
    const byDay = new Map();
    for (const r of rows) (byDay.get(r.date) || byDay.set(r.date, []).get(r.date)).push(r);
    for (const day of [...byDay.keys()].sort()) {
      const list = byDay.get(day);
      html += `<tr class="day"><td colspan="16">${fmtDay(day)}<span class="count">${list.length} reporting</span></td></tr>`;
      html += list.map(rowHtml).join('');
    }
  } else {
    html = rows.map(rowHtml).join('');
  }
  $('#body').innerHTML = html;
  $('#empty').hidden = rows.length > 0;
}

// ---------- historical ----------
function renderHistory() {
  const all = state.positions.map((p) => ({ p, c: calc(p) }));
  const open = all.filter((x) => !x.c.closed);
  const closed = all.filter((x) => x.c.closed);
  const sum = (arr) => arr.reduce((s, x) => s + (x.c.pl || 0), 0);
  const graded = all.filter((x) => x.c.call !== 'pending');
  const right = graded.filter((x) => x.c.call === 'right').length;
  const wins = closed.filter((x) => x.c.pl > 0).length;
  const total = sum(all);

  $('#perfStats').innerHTML = [
    [fmtMoney(total), 'Total P/L', cls(total)],
    [fmtMoney(sum(open)), `Open P/L (${open.length})`, cls(sum(open))],
    [fmtMoney(sum(closed)), `Realized P/L (${closed.length})`, cls(sum(closed))],
    [closed.length ? `${Math.round((wins / closed.length) * 100)}%` : '—', 'Win rate (closed)', ''],
    [graded.length ? `${right}/${graded.length}` : '—', 'Rule calls right', ''],
  ].map(([v, l, c]) => `<div class="stat"><b class="${c}">${v}</b><span>${l}</span></div>`).join('');

  const rows = all.filter((x) => state.perfStatus === 'all' || (state.perfStatus === 'open') === !x.c.closed)
    .sort((a, b) => b.p.entryDate.localeCompare(a.p.entryDate));
  const callLabel = { right: '<span class="up">✓ Right</span>', wrong: '<span class="down">✗ Wrong</span>', pending: '<span class="muted">Pending</span>' };
  $('#perfBody').innerHTML = rows.map(({ p, c }) => `<tr class="clickable" data-pos="${p.id}">
      <td><div class="co"><b>${esc(p.symbol)}</b><small>${esc(p.name || c.q.name || '')}</small></div></td>
      <td>${c.closed ? `Closed ${fmtMD(p.exitDate)}` : '<span class="soon">Open</span>'}</td>
      <td>${tag(p.sentiment, p.score)}</td>
      <td>${c.earningsDate ? `${fmtMD(c.earningsDate)} ${TIME_SHORT[c.earningsTime] || ''}` : '—'}</td>
      <td>${fmtMD(p.entryDate)}</td>
      <td class="num">${fmtNum(p.entryPrice)}</td>
      <td class="num">${fmtNum(p.shares, p.shares % 1 ? 2 : 0)}</td>
      <td class="num">${fmtNum(c.current)}</td>
      <td class="num ${cls(c.pl)}">${fmtMoney(c.pl)}</td>
      <td class="num ${cls(c.plPct)}">${fmtPct(c.plPct)}</td>
      <td class="num">${c.days}</td>
      <td>${p.sentiment ? callLabel[c.call] : '<span class="muted">—</span>'}</td>
    </tr>`).join('');
  $('#perfEmpty').hidden = rows.length > 0;
}

// ---------- view switching ----------
function renderAll() {
  renderSidebar();
  $$('.view').forEach((el) => { el.hidden = el.id !== `view-${state.view}`; });
  if (state.view === 'overview') renderOverview();
  if (state.view === 'screen') renderScreen();
  if (state.view === 'history') renderHistory();
}

function setView(v) {
  state.view = v;
  save('view', v);
  renderAll();
  window.scrollTo({ top: 0 });
}

// ---------- score breakdown ----------
const whyDialog = $('#whyDialog');
function openWhy(r) {
  const rows = RULES.map((rule) => {
    const cfg = state.settings.rules[rule.id];
    const hit = r.reasons.find((x) => x.id === rule.id);
    const result = !cfg.on ? '<span class="muted">Rule off</span>' : hit ? esc(hit.label) : '<span class="muted">No data</span>';
    const pts = hit ? `<b class="${cls(hit.pts)}">${fmtScore(hit.pts)}</b>` : '<span class="muted">0</span>';
    return `<tr><td>${rule.name}</td><td>${result}</td><td class="num">${pts}</td></tr>`;
  }).join('');
  $('#whyBody').innerHTML = `
    <div class="detail-head">
      <div><h3>${esc(r.symbol)} ${tag(r.outlook, r.score)}</h3>
        <div class="muted">${esc(r.name || '')}${r.date ? ` · reports ${fmtShort(r.date)} ${TIME_LABEL[r.time] || ''}` : ''}</div></div>
      <button class="x" data-close aria-label="Close">✕</button>
    </div>
    <table class="why"><thead><tr><th>Rule</th><th>Result</th><th class="num">Pts</th></tr></thead>
      <tbody>${rows}<tr class="total"><td colspan="2">Total · bullish ≥ ${state.settings.bullishAt}, bearish ≤ ${state.settings.bearishAt}</td><td class="num"><b>${fmtScore(r.score)}</b></td></tr></tbody></table>
    <div class="actions">
      <button class="btn ghost" data-close>Close</button>
      ${r.date ? (openFor(r.symbol) ? '<button class="btn" data-why-open>View tracked position</button>' : '<button class="btn" data-why-fav>★ Favorite & track</button>') : ''}
    </div>`;
  whyDialog.dataset.sym = r.symbol;
  whyDialog.dataset.date = r.date || '';
  whyDialog.showModal();
}
whyDialog.addEventListener('click', (e) => {
  if (e.target === whyDialog || e.target.closest('[data-close]')) { whyDialog.close(); return; }
  const r = state.rows.find((x) => x.symbol === whyDialog.dataset.sym && x.date === whyDialog.dataset.date);
  if (e.target.closest('[data-why-fav]') && r) { whyDialog.close(); favoriteRow(r); }
  if (e.target.closest('[data-why-open]')) { whyDialog.close(); openDetail(openFor(whyDialog.dataset.sym).id); }
});

// ---------- add / edit dialog ----------
const posDialog = $('#posDialog');
const posForm = $('#posForm');
let editing = null;

function showDialogOutlook(scored, note = '') {
  $('#posOutlook').innerHTML = scored
    ? `<div><span class="muted">Rules outlook</span> ${tag(scored.outlook, scored.score)}</div>
       <div class="chips">${chips(scored.reasons)}</div>${note ? `<p class="hint">${note}</p>` : ''}`
    : '';
}

async function priceOn(symbol, date) {
  const pts = await api(`/api/history?symbol=${encodeURIComponent(symbol)}&from=${date}`);
  return pts.filter((p) => p.date <= date).at(-1) || pts[0] || null;
}

function openAdd(ctx = {}) {
  editing = { ...ctx, id: null };
  posForm.reset();
  $('#posTitle').textContent = ctx.symbol ? `Favorite ${ctx.symbol}` : 'Add to favorites';
  posForm.symbol.value = ctx.symbol || '';
  posForm.symbol.readOnly = !!ctx.symbol;
  posForm.entryDate.value = nyToday();
  posForm.entryDate.max = nyToday();
  posForm.entryPrice.value = ctx.price ? ctx.price.toFixed(2) : '';
  posForm.shares.value = 1;
  $('#priceHint').textContent = ctx.price ? `Current price ${fmtNum(ctx.price)}. Change it to the price you'd buy at, or pick a past date.` : '';
  $('#posError').textContent = '';
  showDialogOutlook(ctx.scored, ctx.scored ? 'Saved with this position so Historical can grade the call after earnings.' : '');
  posDialog.showModal();
  (ctx.symbol ? posForm.entryPrice : posForm.symbol).focus();
}

function favoriteRow(r) {
  openAdd({
    symbol: r.symbol, name: r.name, price: r.price, earningsDate: r.date, earningsTime: r.time,
    scored: { score: r.score, outlook: r.outlook, reasons: r.reasons },
  });
}

function openEdit(p) {
  editing = { id: p.id };
  posForm.reset();
  $('#posTitle').textContent = `Edit ${p.symbol}`;
  posForm.symbol.value = p.symbol;
  posForm.symbol.readOnly = true;
  posForm.entryDate.value = p.entryDate;
  posForm.entryDate.max = nyToday();
  posForm.entryPrice.value = p.entryPrice;
  posForm.shares.value = p.shares;
  posForm.notes.value = p.notes || '';
  $('#priceHint').textContent = '';
  $('#posError').textContent = '';
  showDialogOutlook(p.sentiment ? { outlook: p.sentiment, score: p.score, reasons: [] } : null, 'Outlook at the time you favorited it.');
  const chipBox = $('#posOutlook .chips');
  if (chipBox) chipBox.innerHTML = (p.reasons || []).map((l) => `<span class="chip ${l.startsWith('-') ? 'neg' : 'pos'}">${esc(l)}</span>`).join('');
  posDialog.showModal();
}

// Manual add: look up and score the ticker once it's typed.
posForm.symbol.addEventListener('change', async () => {
  const sym = posForm.symbol.value.trim().toUpperCase();
  if (!sym || editing?.id) return;
  posForm.symbol.value = sym;
  $('#priceHint').textContent = 'Looking up…';
  const q = (await api(`/api/quotes?symbols=${encodeURIComponent(sym)}`))[sym];
  if (!q?.price) { $('#priceHint').textContent = `Couldn't find a quote for ${sym}.`; showDialogOutlook(null); return; }
  state.quotes[sym] = q;
  const row = state.rows.find((r) => r.symbol === sym);
  const scored = row || scoreStock(withRange(q), state.settings);
  Object.assign(editing, {
    name: q.name, price: q.price,
    earningsDate: row?.date || q.nextEarningsDate, earningsTime: row?.time || q.nextEarningsTime,
    scored: { score: scored.score, outlook: scored.outlook, reasons: scored.reasons },
  });
  posForm.entryPrice.value = q.price.toFixed(2);
  $('#priceHint').textContent = `${q.name || sym} · current ${fmtNum(q.price)}${editing.earningsDate ? ` · next earnings ${fmtMD(editing.earningsDate)}` : ''}`;
  showDialogOutlook(editing.scored, row ? '' : 'Scored without EPS-estimate data (only available for stocks on the earnings calendar).');
});

// Backdating: fill in that day's close.
posForm.entryDate.addEventListener('change', async () => {
  const sym = posForm.symbol.value.trim().toUpperCase();
  const date = posForm.entryDate.value;
  if (!sym || !date) return;
  if (date === nyToday()) {
    const now = state.quotes[sym]?.price || editing?.price;
    if (now) { posForm.entryPrice.value = now.toFixed(2); $('#priceHint').textContent = `Current price ${fmtNum(now)}.`; }
    return;
  }
  $('#priceHint').textContent = 'Looking up the close…';
  try {
    const pt = await priceOn(sym, date);
    if (pt) {
      posForm.entryPrice.value = pt.close.toFixed(2);
      $('#priceHint').textContent = `Close on ${fmtShort(pt.date)}: ${fmtNum(pt.close)}. Adjust if you'd have bought at a different price.`;
    } else {
      $('#priceHint').textContent = 'No price found for that date — enter it manually.';
    }
  } catch (err) {
    $('#priceHint').textContent = `Couldn't look up history: ${err.message}`;
  }
});

$('#posCancel').addEventListener('click', () => posDialog.close());

posForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    entryDate: posForm.entryDate.value,
    entryPrice: posForm.entryPrice.value,
    shares: posForm.shares.value,
    notes: posForm.notes.value,
  };
  try {
    if (editing.id) {
      const p = await api(`/api/positions/${editing.id}`, { method: 'PATCH', body });
      Object.assign(state.positions.find((x) => x.id === p.id), p);
    } else {
      const symbol = posForm.symbol.value.trim().toUpperCase();
      const s = editing.scored;
      const p = await api('/api/positions', {
        method: 'POST',
        body: {
          ...body, symbol, name: editing.name, earningsDate: editing.earningsDate, earningsTime: editing.earningsTime,
          sentiment: s?.outlook || null, score: s?.score ?? null,
          reasons: (s?.reasons || []).filter((x) => x.pts !== 0).map((x) => `${x.pts > 0 ? '+' : ''}${x.pts} ${x.label}`),
        },
      });
      state.positions.push(p);
      if (!state.quotes[symbol]) await fetchFavQuotes();
    }
    posDialog.close();
    renderAll();
  } catch (err) {
    $('#posError').textContent = err.message;
  }
});

// ---------- position detail ----------
const detailDialog = $('#detailDialog');

function chartSvg(points, p, c) {
  const W = 700; const H = 220; const L = 48; const R = 12; const T = 14; const B = 26;
  if (points.length < 2) return '<p class="hint">Not enough price history yet — the chart fills in as trading days pass.</p>';
  const vals = points.map((x) => x.close).concat(p.entryPrice);
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || hi * 0.02; lo -= pad; hi += pad;
  const x = (i) => L + (i / (points.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const path = points.map((pt, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pt.close).toFixed(1)}`).join('');
  const ticks = [0, 0.5, 1].map((f) => lo + (hi - lo) * f);
  const dateIdx = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const eIdx = c.earningsDate ? points.findIndex((pt) => pt.date >= c.earningsDate) : -1;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(p.symbol)} price since entry">
    ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${fmtNum(v)}</text>`).join('')}
    ${dateIdx.map((i) => `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}">${fmtMD(points[i].date)}</text>`).join('')}
    <line class="entry" x1="${L}" x2="${W - R}" y1="${y(p.entryPrice)}" y2="${y(p.entryPrice)}"/>
    <text class="axis" x="${L + 4}" y="${y(p.entryPrice) - 4}">Entry ${fmtNum(p.entryPrice)}</text>
    ${eIdx >= 0 ? `<line class="earn" x1="${x(eIdx)}" x2="${x(eIdx)}" y1="${T}" y2="${H - B}"/><text class="earn-label" x="${x(eIdx) + 4}" y="${T + 10}">Earnings</text>` : ''}
    <path class="${(c.plPct ?? 0) >= 0 ? 'line-up' : 'line-down'}" d="${path}"/>
  </svg>`;
}

async function openDetail(id) {
  const p = state.positions.find((x) => x.id === id);
  if (!p) return;
  const c = calc(p);
  const kpi = (label, val, k = '') => `<div class="kpi"><span>${label}</span><b class="${k}">${val}</b></div>`;
  const draw = (points, extra = '') => {
    const closes = points.filter((pt) => pt.date >= p.entryDate && (!c.closed || pt.date <= p.exitDate));
    const hiSince = closes.length ? Math.max(...closes.map((pt) => pt.close)) : null;
    const loSince = closes.length ? Math.min(...closes.map((pt) => pt.close)) : null;
    $('#detailBody').innerHTML = `
      <div class="detail-head">
        <div>
          <h3>${esc(p.symbol)} ${p.sentiment ? tag(p.sentiment, p.score) : ''}</h3>
          <div class="muted">${esc(p.name || c.q.name || '')} · ${c.closed ? `Closed ${fmtShort(p.exitDate)}` : 'Open paper position'}</div>
        </div>
        <button class="x" data-close aria-label="Close">✕</button>
      </div>
      <div class="kpis">
        ${kpi('Entry', `${fmtNum(p.entryPrice)} <small class="muted">${fmtMD(p.entryDate)}</small>`)}
        ${kpi(c.closed ? 'Exit' : 'Current', fmtNum(c.current))}
        ${kpi('P/L', fmtMoney(c.pl), cls(c.pl))}
        ${kpi('P/L %', fmtPct(c.plPct), cls(c.plPct))}
        ${kpi('Shares', fmtNum(p.shares, p.shares % 1 ? 2 : 0))}
        ${kpi('Days held', c.days)}
        ${kpi('High / low since', hiSince ? `${fmtNum(hiSince)} / ${fmtNum(loSince)}` : '—')}
        ${kpi('Earnings', c.earningsDate ? `${fmtMD(c.earningsDate)} ${TIME_SHORT[c.earningsTime] || ''}` : '—')}
      </div>
      ${extra || chartSvg(closes.length ? [...closes, ...(!c.closed && c.current && closes.at(-1).date < nyToday() ? [{ date: nyToday(), close: c.current }] : [])] : [], p, c)}
      ${p.reasons?.length ? `<div class="chips" style="margin-top:12px"><span class="muted" style="font-size:12px">Why it was ${p.sentiment} at entry:</span>${p.reasons.map((l) => `<span class="chip ${l.startsWith('-') ? 'neg' : 'pos'}">${esc(l)}</span>`).join('')}</div>` : ''}
      ${p.notes ? `<div class="notes">${esc(p.notes)}</div>` : ''}
      <div class="actions">
        <button class="btn danger" data-act="delete">Delete</button>
        <span class="spacer"></span>
        <button class="btn ghost" data-act="edit">Edit</button>
        ${c.closed ? '<button class="btn ghost" data-act="reopen">Reopen</button>' : '<button class="btn" data-act="close">Close position</button>'}
      </div>`;
  };
  draw([], '<p class="hint">Loading chart…</p>');
  detailDialog.dataset.pos = id;
  if (!detailDialog.open) detailDialog.showModal();
  try {
    draw(await api(`/api/history?symbol=${encodeURIComponent(p.symbol)}&from=${p.entryDate}`));
  } catch (err) {
    draw([], `<p class="hint">Couldn't load price history: ${esc(err.message)}</p>`);
  }
}

detailDialog.addEventListener('click', async (e) => {
  if (e.target === detailDialog || e.target.closest('[data-close]')) { detailDialog.close(); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  const p = state.positions.find((x) => x.id === detailDialog.dataset.pos);
  if (!act || !p) return;
  try {
    if (act === 'edit') { detailDialog.close(); openEdit(p); return; }
    if (act === 'delete') {
      if (!confirm(`Delete the ${p.symbol} position? This removes it from Historical too.`)) return;
      await api(`/api/positions/${p.id}`, { method: 'DELETE' });
      state.positions = state.positions.filter((x) => x.id !== p.id);
      detailDialog.close();
    }
    if (act === 'close') {
      const now = state.quotes[p.symbol]?.price;
      const v = prompt(`Close ${p.symbol} at what price? It stays in Historical as realized P/L.`, now ? now.toFixed(2) : '');
      if (v == null) return;
      Object.assign(p, await api(`/api/positions/${p.id}`, { method: 'PATCH', body: { exitPrice: v } }));
    }
    if (act === 'reopen') Object.assign(p, await api(`/api/positions/${p.id}`, { method: 'PATCH', body: { exitPrice: null } }));
    renderAll();
    if (detailDialog.open) openDetail(p.id);
  } catch (err) {
    alert(err.message);
  }
});

// ---------- events ----------
function setPreset(p) {
  const today = nyToday();
  $$('#presets button').forEach((b) => b.classList.toggle('on', b.dataset.preset === p));
  if (p === 'today') { $('#from').value = today; $('#days').value = '1'; }
  if (p === 'week') { $('#from').value = mondayOf(today); $('#days').value = '5'; }
  if (p === 'next') { $('#from').value = addDays(mondayOf(today), 7); $('#days').value = '5'; }
  save('preset', p);
  refreshAll();
}

$('#presets').addEventListener('click', (e) => {
  const p = e.target.closest('button')?.dataset.preset;
  if (p) setPreset(p);
});
['#from', '#days'].forEach((s) => $(s).addEventListener('change', () => {
  $$('#presets button').forEach((b) => b.classList.remove('on'));
  refreshAll();
}));
$('#refresh').addEventListener('click', refreshAll);
$('#nav').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.view;
  if (v) setView(v);
});

function segment(sel, attr, apply) {
  $(sel).addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset[attr];
    if (!v) return;
    apply(v);
    $$(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset[attr] === v));
    renderAll();
  });
}
segment('#timing', 'time', (v) => { state.time = v; });
segment('#outlookFilter', 'outlook', (v) => { state.outlook = v; });
segment('#perfFilter', 'status', (v) => { state.perfStatus = v; });

['#search', '#mincap', '#group'].forEach((s) => $(s).addEventListener('input', () => {
  save('filters', { mincap: $('#mincap').value, group: $('#group').checked });
  renderAll();
}));

$('#tbl thead').addEventListener('click', (e) => {
  const key = e.target.closest('th')?.dataset.sort;
  if (!key) return;
  if (state.sort.key === key) state.sort.dir *= -1;
  else state.sort = { key, dir: ['symbol', 'date', 'time', 'analystRating'].includes(key) ? 1 : -1 };
  save('sort', state.sort);
  renderAll();
});

// Stars, score buttons and position rows behave the same on every page.
document.addEventListener('click', (e) => {
  if (e.target.closest('dialog')) return;
  const why = e.target.closest('[data-why]');
  if (why) {
    const r = state.rows.find((x) => x.symbol === why.dataset.why && x.date === why.dataset.date);
    if (r) openWhy(r);
    return;
  }
  const star = e.target.closest('[data-star]');
  if (star) {
    const existing = openFor(star.dataset.star);
    if (existing) { openDetail(existing.id); return; }
    const r = state.rows.find((x) => x.symbol === star.dataset.star && x.date === star.dataset.date);
    if (r) favoriteRow(r);
    return;
  }
  const pos = e.target.closest('[data-pos]');
  if (pos) openDetail(pos.dataset.pos);
});
$('#addManual').addEventListener('click', () => openAdd());

// ---------- init ----------
const savedFilters = load('filters', null);
if (savedFilters) {
  $('#mincap').value = savedFilters.mincap;
  $('#group').checked = savedFilters.group;
}
setPreset(load('preset', 'week'));
setInterval(refreshAll, REFRESH_MS);
