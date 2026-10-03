import { test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { snapshotFromPool } from '../src/feed.js';
import { priceFromSqrt, sqrtFromPrice, toHumanPrice } from '../src/dbc.js';

const sqrt = sqrtFromPrice(1e-6);

const pool = (quote: string, progress = 7) => ({
  sqrtPrice: new BN(sqrt.toString()),
  baseReserve: new BN('1000000'),
  quoteReserve: new BN(quote),
  migrationProgress: progress,
  isMigrated: 0,
});
const config = { migrationQuoteThreshold: new BN('1000') };

test('snapshot maps reserves and progress', () => {
  const s = snapshotFromPool(pool('500'), config, { pool: 'p', baseDecimals: 9, quoteDecimals: 9 });
  assert.equal(s.progressComputedPct, 50);
  assert.equal(s.progressOnchainPct, 7);
  assert.equal(s.isMigrated, false);
  assert.equal(s.raisedQuote, '500');
  assert.equal(s.migrationQuoteThreshold, '1000');
});

test("snapshot price matches the simulator's price math", () => {
  const s = snapshotFromPool(pool('500'), config, { pool: 'p', baseDecimals: 9, quoteDecimals: 9 });
  const expected = toHumanPrice(priceFromSqrt(sqrt), 9, 9);
  assert.ok(Math.abs(s.priceHuman - expected) <= expected * 1e-9, `${s.priceHuman} vs ${expected}`);
});

test('snapshot caps computed progress at 100 and passes migration flag', () => {
  const s = snapshotFromPool({ ...pool('5000'), isMigrated: 1 }, config, {
    pool: 'p',
    baseDecimals: 9,
    quoteDecimals: 9,
  });
  assert.equal(s.progressComputedPct, 100);
  assert.equal(s.isMigrated, true);
});
