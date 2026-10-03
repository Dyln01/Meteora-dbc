import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Rounding, deltaBase, deltaQuote, nextSqrtFromQuoteIn, nextSqrtFromBaseIn,
  priceFromSqrt, sqrtFromPrice, totalBaseForCurve, totalQuoteForCurve, QUOTE_SCALE,
} from '../src/dbc.js';
import { simulate, validate, curveFromPrices } from '../src/simulate.js';
import { PRESETS, buildPreset } from '../src/presets.js';

test('deltaQuote inverts the Q128 scaling', () => {
  const lo = 1n << 64n, hi = 2n << 64n, L = QUOTE_SCALE;
  // Δb = L*(hi-lo)/2^128 = 2^128 * 2^64 / 2^128 = 2^64
  assert.equal(deltaQuote(lo, hi, L, Rounding.Down), 1n << 64n);
});

test('deltaBase matches L*(u-l)/(u*l)', () => {
  const lo = 1n << 64n, hi = 2n << 64n, L = 1n << 80n;
  const expected = (L * (hi - lo)) / (hi * lo);
  assert.equal(deltaBase(lo, hi, L, Rounding.Down), expected);
});

test('deltaBase rounds up, never down, at boundaries', () => {
  const lo = 3n << 64n, hi = 7n << 64n, L = 5n;
  assert.ok(deltaBase(lo, hi, L, Rounding.Up) >= deltaBase(lo, hi, L, Rounding.Down));
});

test('quote-in then base-out is monotone in price', () => {
  const L = QUOTE_SCALE * 4n;
  let p = 1n << 64n;
  let prev = p;
  for (let i = 0; i < 5; i++) { p = nextSqrtFromQuoteIn(p, L, QUOTE_SCALE / 8n); assert.ok(p > prev, 'price must rise as quote enters'); prev = p; }
  let q = prev;
  for (let i = 0; i < 3; i++) { q = nextSqrtFromBaseIn(q, L, 1000n); assert.ok(q <= prev, 'base in must not raise price'); prev = q; }
});

test('sqrtFromPrice / priceFromSqrt round-trip', () => {
  for (const p of [1e-6, 0.5, 1, 172.5, 1000]) {
    const back = priceFromSqrt(sqrtFromPrice(p));
    assert.ok(Math.abs(back - p) / p < 1e-6, `round trip failed for ${p}: got ${back}`);
  }
});

test('single-segment totals equal the closed-form deltas', () => {
  const cfg = curveFromPrices(1, 4, [{ atPriceFraction: 1, liquidity: QUOTE_SCALE * 1000n }]);
  assert.equal(totalBaseForCurve(cfg), deltaBase(cfg.sqrtStartPrice, cfg.curve[0].sqrtPrice, cfg.curve[0].liquidity, Rounding.Up));
  assert.equal(totalQuoteForCurve(cfg), deltaQuote(cfg.sqrtStartPrice, cfg.curve[0].sqrtPrice, cfg.curve[0].liquidity, Rounding.Up));
});

test('validator catches an unreachable migration price', () => {
  const cfg = curveFromPrices(1, 4, [{ atPriceFraction: 0.5, liquidity: QUOTE_SCALE * 100n }]);
  const codes = validate(cfg).map((f) => f.code);
  assert.ok(codes.includes('MIGRATION_UNREACHABLE'), `expected MIGRATION_UNREACHABLE, got ${codes}`);
});

test('validator catches a non-monotonic curve', () => {
  const cfg = curveFromPrices(1, 4, [
    { atPriceFraction: 0.8, liquidity: QUOTE_SCALE * 100n },
    { atPriceFraction: 0.3, liquidity: QUOTE_SCALE * 100n },
  ]);
  assert.ok(validate(cfg).some((f) => f.code === 'NON_MONOTONIC'));
});

test('validator catches migration at or below start', () => {
  const cfg = curveFromPrices(4, 4, [{ atPriceFraction: 1, liquidity: QUOTE_SCALE }]);
  assert.ok(validate(cfg).some((f) => f.code === 'MIGRATION_BEFORE_START'));
});

test('simulation prices increase monotonically to the migration price', () => {
  const cfg = buildPreset(PRESETS.meme);
  const sim = simulate(cfg, 20);
  assert.ok(sim.graduationReachable, 'preset must graduate');
  assert.ok(sim.points.length > 0);
  let prev = -1;
  for (const p of sim.points) { assert.ok(p.price >= prev, 'price must not fall'); prev = p.price; }
  const last = sim.points[sim.points.length - 1];
  assert.ok(Math.abs(last.progress - 1) < 0.05, `final progress should be ~1, got ${last.progress}`);
});

test('every shipped preset validates with no errors', () => {
  for (const [id, spec] of Object.entries(PRESETS)) {
    const cfg = buildPreset(spec);
    const errors = validate(cfg).filter((f) => f.severity === 'error');
    assert.deepEqual(errors.map((e) => `${id}:${e.code}`), [], `preset ${id} has errors`);
    assert.ok(simulate(cfg, 8).graduationReachable, `preset ${id} cannot graduate`);
  }
});

test('higher target raise absorbs more quote for the same price path', () => {
  const small = buildPreset({ ...PRESETS.meme, targetRaise: 100 });
  const large = buildPreset({ ...PRESETS.meme, targetRaise: 1000 });
  assert.ok(totalQuoteForCurve(large) > totalQuoteForCurve(small));
  // deltaBase is linear in L, so scaling the raise scales the float too.
  // Raise and float are NOT independent knobs under a single liquidity scale —
  // see README "Model note". Assert the proportionality rather than invariance.
  const ratio = Number(totalBaseForCurve(large)) / Number(totalBaseForCurve(small));
  assert.ok(ratio > 9 && ratio < 11, `expected ~10x float scaling, got ${ratio}`);
});

test('validate never throws on malformed input', () => {
  const bad: any[] = [
    { sqrtStartPrice: 0n, sqrtMigrationPrice: 1n, curve: [] },
    { sqrtStartPrice: 5n, sqrtMigrationPrice: 5n, curve: [{ sqrtPrice: 1n, liquidity: 1n }] },
    { sqrtStartPrice: 1n, sqrtMigrationPrice: 9n, curve: [{ sqrtPrice: 5n, liquidity: 0n }, { sqrtPrice: 3n, liquidity: 2n }] },
  ];
  for (const cfg of bad) {
    const out = validate(cfg); // must not throw
    assert.ok(out.some((f) => f.severity === 'error'), 'malformed config must yield at least one error');
  }
});
