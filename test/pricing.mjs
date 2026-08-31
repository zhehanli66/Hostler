import assert from 'node:assert/strict';
import pricing from '../dist/shared/pricing.js';

const { costOf, priceFor } = pricing;
const tokens = (p = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...p });
const closeTo = (actual, expected) => assert.ok(
  actual !== null && Math.abs(actual - expected) < 1e-12,
  `expected ${expected}, got ${actual}`,
);

assert.equal(priceFor('gpt-5.6-sol')?.input, 2, 'current Codex model has a built-in price');
assert.deepEqual(
  priceFor('codex-auto-review'),
  priceFor('gpt-5.6-luna'),
  'the unpublished auto-review model uses the disclosed Luna proxy',
);
assert.equal(priceFor('gpt-5.6-terra-2026-08-01')?.input, 1, 'dated aliases use the longest matching model id');
assert.equal(priceFor('gpt-5.4-mini-2026-03-05')?.input, 0.75, 'mini does not inherit the gpt-5.4 rate');
assert.equal(priceFor('not-a-priced-model'), null, 'unknown providers remain unpriced');

// $2 input + $0.20 cached input + $2.50 cache write + $10 output.
closeTo(costOf('gpt-5.6-sol', tokens({
  input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWrite1h: 1e6,
})), 14.7);

// Historical Codex rollouts keep their actual cached-input discount.
closeTo(costOf('gpt-5.3-codex', tokens({ input: 1e6, output: 1e6, cacheRead: 1e6 })), 15.925);
closeTo(costOf('codex-mini-latest', tokens({ cacheRead: 1e6 })), 0.375);
closeTo(costOf('codex-auto-review', tokens({ input: 1e6, output: 1e6, cacheRead: 1e6 })), 0.71);

// Adding OpenAI rates must not change Anthropic's one-hour cache-write multiplier.
closeTo(costOf('claude-sonnet-5', tokens({ cacheWrite: 1e6, cacheWrite1h: 1e6 })), 4);

// A user override still wins over a built-in row.
closeTo(costOf('gpt-5.6-sol', tokens({ input: 1e6 }), {
  'gpt-5.6-sol': { input: 9, output: 99, cacheRead: 0.9 },
}), 9);

console.log('pricing: ok');
