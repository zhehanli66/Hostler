import type { UsageReport, UsageSession } from '@shared/types';
import { costOf, type ModelPrice } from '@shared/pricing';

/**
 * Rolling the machines' hourly buckets up into what a person actually asks for.
 *
 * The helpers report UTC hours precisely so this can happen here, in the viewer's own
 * timezone — a day boundary is a local thing, and two machines in different zones must still
 * land in the same day.
 */

export type Bucket = 'day' | 'week' | 'month';
export type Period = 'today' | 'week' | 'month' | 'all';

export interface UsageSource {
  machineId: string;
  machineName: string;
  report: UsageReport;
}

export interface Row {
  key: string;
  label: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  messages: number;
  /** USD across the models that have a price */
  cost: number;
  /** tokens belonging to models nothing prices — cost above excludes them */
  unpriced: number;
}

export interface SessionRow extends UsageSession {
  machineId: string;
  machineName: string;
  cost: number | null;
}

export interface Rollup {
  slices: Row[];
  byModel: Row[];
  byMachine: Row[];
  byKind: Row[];
  sessions: SessionRow[];
  total: Row;
  /** models seen with no price attached, worth offering to fill in */
  unpricedModels: string[];
}

const pad = (n: number) => (n < 10 ? '0' + n : String(n));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-08-27T17" (UTC) -> a Date in the viewer's timezone */
export const hourDate = (hourKey: string) => new Date(hourKey + ':00:00Z');
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/** ISO-8601 week, so weeks start on Monday and never straddle a year boundary oddly. */
export function weekKey(d: Date): string {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));       // Thursday of this week
  const first = new Date(t.getFullYear(), 0, 4);
  const week = 1 + Math.round(((t.getTime() - first.getTime()) / 86400000 - 3 + ((first.getDay() + 6) % 7)) / 7);
  return `${t.getFullYear()}-W${pad(week)}`;
}

export function bucketKey(d: Date, b: Bucket): string {
  return b === 'day' ? dayKey(d) : b === 'week' ? weekKey(d) : monthKey(d);
}

export function bucketLabel(key: string, b: Bucket): string {
  if (b === 'month') {
    const [y, m] = key.split('-');
    return `${MONTHS[+m - 1]} ${y}`;
  }
  if (b === 'week') return key.replace('-W', ' wk ');
  const [, m, d] = key.split('-');
  return `${MONTHS[+m - 1]} ${+d}`;
}

/** Local midnight the given period starts at, or null for "all". */
export function periodStart(p: Period): Date | null {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (p === 'today') return midnight;
  if (p === 'week') { const d = new Date(midnight); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
  if (p === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  return null;
}

const emptyRow = (key: string, label: string): Row =>
  ({ key, label, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, messages: 0, cost: 0, unpriced: 0 });

function add(row: Row, v: number[], cost: number | null) {
  row.input += v[0]; row.output += v[1]; row.cacheRead += v[2]; row.cacheWrite += v[3];
  row.cacheWrite1h += v[4]; row.messages += v[5];
  if (cost == null) row.unpriced += v[0] + v[1] + v[2] + v[3];
  else row.cost += cost;
}

function bump(into: Map<string, Row>, key: string, label: string, v: number[], cost: number | null) {
  let row = into.get(key);
  if (!row) { row = emptyRow(key, label); into.set(key, row); }
  add(row, v, cost);
}

export const rowTokens = (r: Row) => r.input + r.output + r.cacheRead + r.cacheWrite;

export function rollup(sources: UsageSource[], opts: {
  bucket: Bucket;
  period: Period;
  kinds?: string[] | null;
  prices?: Record<string, ModelPrice>;
}): Rollup {
  const { bucket, period, kinds, prices } = opts;
  const from = periodStart(period);
  const keep = (kind: string) => !kinds || !kinds.length || kinds.includes(kind);

  const slices = new Map<string, Row>();
  const byModel = new Map<string, Row>();
  const byMachine = new Map<string, Row>();
  const byKind = new Map<string, Row>();
  const total = emptyRow('total', 'total');
  const unpriced = new Set<string>();

  for (const src of sources) {
    for (const [hour, models] of Object.entries(src.report.hours || {})) {
      const at = hourDate(hour);
      if (from && at < from) continue;
      for (const [mk, v] of Object.entries(models)) {
        const cut = mk.indexOf(':');
        const kind = mk.slice(0, cut);
        const model = mk.slice(cut + 1);
        if (!keep(kind)) continue;
        const cost = costOf(model, { input: v[0], output: v[1], cacheRead: v[2], cacheWrite: v[3], cacheWrite1h: v[4] }, prices);
        if (cost == null) unpriced.add(model);

        const sk = bucketKey(at, bucket);
        bump(slices, sk, bucketLabel(sk, bucket), v, cost);
        bump(byModel, model, model, v, cost);
        bump(byKind, kind, kind, v, cost);
        bump(byMachine, src.machineId, src.machineName, v, cost);
        add(total, v, cost);
      }
    }
  }

  const sessions: SessionRow[] = [];
  for (const src of sources) {
    for (const s of src.report.sessions || []) {
      if (!keep(s.kind)) continue;
      if (from && s.last && hourDate(s.last) < from) continue;
      sessions.push({
        ...s, machineId: src.machineId, machineName: src.machineName,
        cost: s.model ? costOf(s.model, { input: s.input, output: s.output, cacheRead: s.cache_read, cacheWrite: s.cache_write, cacheWrite1h: s.cache_write_1h }, prices) : null,
      });
    }
  }
  sessions.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || (b.input + b.output) - (a.input + a.output));

  const byTokens = (a: Row, b: Row) => rowTokens(b) - rowTokens(a);
  return {
    slices: [...slices.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    byModel: [...byModel.values()].sort(byTokens),
    byMachine: [...byMachine.values()].sort(byTokens),
    byKind: [...byKind.values()].sort(byTokens),
    sessions,
    total,
    unpricedModels: [...unpriced].sort(),
  };
}

export function fmtTokens(n: number, digits = 1): string {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(digits) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(digits) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(digits) + 'k';
  return String(Math.round(n));
}

export function fmtUsd(n: number): string {
  if (!n) return '$0.00';
  if (n < 0.01) return '<$0.01';
  if (n >= 1000) return '$' + Math.round(n).toLocaleString();
  return '$' + n.toFixed(2);
}

const PRICE_KEY = 'hostler_model_prices';

export function loadPrices(): Record<string, ModelPrice> {
  try { return JSON.parse(localStorage.getItem(PRICE_KEY) || '{}') || {}; } catch { return {}; }
}
export function savePrices(p: Record<string, ModelPrice>) {
  try { localStorage.setItem(PRICE_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
