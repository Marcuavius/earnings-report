// Tiny JSON-file store for paper positions (favorites) and rule settings.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('./data/', import.meta.url));
const FILE = `${DIR}store.json`;

let data = { positions: [], settings: null };
try {
  data = { ...data, ...JSON.parse(readFileSync(FILE, 'utf8')) };
  delete data.sentiments; // outlooks are now computed by rules, not tagged by hand
} catch { /* first run */ }

function persist() {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, FILE); // atomic replace so a crash never leaves a half-written file
}

export const SENTIMENTS = ['bearish', 'neutral', 'bullish'];

export const getAll = () => data;

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

function clean(input) {
  const out = {};
  if ('symbol' in input) out.symbol = String(input.symbol).trim().toUpperCase();
  if ('name' in input) out.name = input.name ? String(input.name).slice(0, 200) : null;
  if ('entryPrice' in input) out.entryPrice = num(input.entryPrice);
  if ('shares' in input) out.shares = num(input.shares) ?? 1;
  if ('entryDate' in input) out.entryDate = isoDate(input.entryDate);
  if ('sentiment' in input) out.sentiment = SENTIMENTS.includes(input.sentiment) ? input.sentiment : null;
  if ('earningsDate' in input) out.earningsDate = isoDate(input.earningsDate);
  if ('earningsTime' in input) out.earningsTime = ['pre', 'after', 'unknown'].includes(input.earningsTime) ? input.earningsTime : null;
  if ('score' in input) out.score = num(input.score);
  if ('reasons' in input) out.reasons = Array.isArray(input.reasons) ? input.reasons.slice(0, 20).map((r) => String(r).slice(0, 120)) : [];
  if ('notes' in input) out.notes = input.notes ? String(input.notes).slice(0, 2000) : '';
  if ('exitPrice' in input) out.exitPrice = num(input.exitPrice);
  if ('exitDate' in input) out.exitDate = isoDate(input.exitDate);
  return out;
}

export function addPosition(input) {
  const p = clean(input);
  if (!p.symbol) throw new Error('symbol is required');
  if (p.entryPrice == null || p.entryPrice <= 0) throw new Error('entryPrice must be a positive number');
  const position = {
    id: randomUUID(),
    shares: 1,
    entryDate: todayET(),
    sentiment: null,
    notes: '',
    exitPrice: null,
    exitDate: null,
    ...p,
    createdAt: new Date().toISOString(),
  };
  position.entryDate ||= todayET();
  data.positions.push(position);
  persist();
  return position;
}

export function updatePosition(id, input) {
  const p = data.positions.find((x) => x.id === id);
  if (!p) return null;
  const changes = clean(input);
  delete changes.symbol;
  Object.assign(p, changes);
  // Reopening: clearing the exit price clears the exit date too.
  if ('exitPrice' in changes && changes.exitPrice == null) p.exitDate = null;
  if (p.exitPrice != null && !p.exitDate) p.exitDate = todayET();
  persist();
  return p;
}

export function deletePosition(id) {
  const before = data.positions.length;
  data.positions = data.positions.filter((x) => x.id !== id);
  if (data.positions.length !== before) persist();
  return data.positions.length !== before;
}

// Rule parameters are owned by the frontend; store them as-is with a size cap.
export function setSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings must be an object');
  if (JSON.stringify(settings).length > 20000) throw new Error('settings too large');
  data.settings = settings;
  persist();
  return data.settings;
}
