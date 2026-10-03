import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minOutFromPrice } from '../src/trade.js';

test('minOutFromPrice bounds a quote-in buy at the live mid-price', () => {
  // 0.1 SOL in at price 1e-9 quote-per-base, 6/9 decimals, 2% slippage
  const min = minOutFromPrice(100_000_000n, 1e-9, 6, 9, 2);
  // 0.1 SOL / 1e-9 = 1e8 base tokens = 1e14 raw; minus 2%
  assert.equal(min, 98_000_000_000_000n);
});

test('minOutFromPrice scales with slippage and rejects non-positive price', () => {
  const tight = minOutFromPrice(100_000_000n, 1e-9, 6, 9, 0);
  const loose = minOutFromPrice(100_000_000n, 1e-9, 6, 9, 10);
  assert.equal(tight, 100_000_000_000_000n);
  assert.equal(loose, 90_000_000_000_000n);
  assert.throws(() => minOutFromPrice(1n, 0, 6, 9, 1), /positive/);
});
