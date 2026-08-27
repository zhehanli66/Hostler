/**
 * Model prices, in USD per million tokens.
 *
 * The helper deliberately reports tokens only — prices change, and a remote machine should not
 * have to be redeployed to learn a new one. This table is the control plane's, and the UI can
 * override or extend any row (Usage → prices).
 *
 * Anthropic first-party API rates, checked 2026-06-24. Cache tokens bill off the input rate:
 * a read is 0.1×, a 5-minute write 1.25×, a one-hour write 2×. Claude Code writes nearly
 * everything with the 1h TTL, so the two writes are counted apart rather than averaged.
 *
 * Codex and OpenCode bill on their own providers' rates, which Hostler does not ship: their
 * models report tokens with no cost attached until you give them a price.
 */

export interface ModelPrice {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cache-read tokens (default: 0.1 × input) */
  cacheRead?: number;
  /** USD per 1M 5-minute cache-write tokens (default: 1.25 × input) */
  cacheWrite5m?: number;
  /** USD per 1M 1-hour cache-write tokens (default: 2 × input) */
  cacheWrite1h?: number;
}

export const PRICES_CHECKED = '2026-06-24';

export const BUILTIN_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  /** total cache writes, 5-minute and one-hour together */
  cacheWrite: number;
  /** the one-hour slice of `cacheWrite` (the rest is billed at the 5-minute rate) */
  cacheWrite1h?: number;
}

/**
 * The price for a model id. Exact match wins; otherwise the longest table key the id starts
 * with, so a dated snapshot (`claude-sonnet-4-6-20251114`) still prices as its base model.
 */
export function priceFor(model: string, overrides?: Record<string, ModelPrice>): ModelPrice | null {
  const table = overrides ? { ...BUILTIN_PRICES, ...overrides } : BUILTIN_PRICES;
  if (table[model]) return table[model];
  let best: string | null = null;
  for (const k of Object.keys(table)) if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? table[best] : null;
}

/** USD for these tokens, or null when nothing prices this model. */
export function costOf(model: string, t: TokenCounts, overrides?: Record<string, ModelPrice>): number | null {
  const p = priceFor(model, overrides);
  if (!p) return null;
  const read = p.cacheRead ?? p.input * 0.1;
  const w1h = p.cacheWrite1h ?? p.input * 2;
  const w5m = p.cacheWrite5m ?? p.input * 1.25;
  const long = Math.min(t.cacheWrite1h || 0, t.cacheWrite);
  const short = Math.max(0, t.cacheWrite - long);
  return (t.input * p.input + t.output * p.output + t.cacheRead * read + long * w1h + short * w5m) / 1e6;
}

/** The agent kinds whose models Hostler ships prices for. */
export function isPriced(model: string, overrides?: Record<string, ModelPrice>): boolean {
  return priceFor(model, overrides) !== null;
}
