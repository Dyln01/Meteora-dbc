import { test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { buildConfigParameters, DEFAULT_DEVNET_OPTIONS, type DeployOptions } from '../src/deploy.js';
import { buildPreset, PRESETS } from '../src/presets.js';
import { simulate } from '../src/simulate.js';
import { totalBaseForCurveFull } from '../src/dbc.js';

const opts: DeployOptions = {
  ...DEFAULT_DEVNET_OPTIONS,
  name: 'test',
  symbol: 'TEST',
  uri: 'https://example.invalid/m.json',
};

for (const id of Object.keys(PRESETS)) {
  test(`deploy parameters mirror emit output for preset ${id}`, () => {
    const cfg = buildPreset(PRESETS[id]);
    const sim = simulate(cfg, 40);
    const p = buildConfigParameters(cfg, sim, {
      ...opts,
      baseDecimals: cfg.baseDecimals ?? 6,
      quoteDecimals: cfg.quoteDecimals ?? 9,
    }) as any;

    // The three numbers this repo is the authority on must pass through exactly.
    assert.equal(p.sqrtStartPrice.toString(), cfg.sqrtStartPrice.toString());
    assert.deepEqual(
      p.curve.map((c: any) => c.sqrtPrice.toString()),
      cfg.curve.map((c) => c.sqrtPrice.toString()),
    );
    assert.deepEqual(
      p.curve.map((c: any) => c.liquidity.toString()),
      cfg.curve.map((c) => c.liquidity.toString()),
    );
    assert.equal(p.migrationQuoteThreshold.toString(), sim.quoteToGraduate!.toString());

    // DAMM v2 migration, quote-token fee collection.
    assert.equal(p.migrationOption, 1);
    assert.equal(p.collectFeeMode, 0);

    // Curve strictly increasing from the start price.
    const bounds: BN[] = [p.sqrtStartPrice, ...p.curve.map((c: any) => c.sqrtPrice)];
    for (let i = 1; i < bounds.length; i++) assert.ok(bounds[i].gt(bounds[i - 1]), `segment ${i} not increasing`);

    // Token supply must cover everything the curve can sell.
    const supply = p.tokenSupply?.totalTokenSupply;
    if (supply) assert.ok(new BN(supply.toString()).gte(new BN(totalBaseForCurveFull(cfg).toString())));
  });
}

test('deploy parameters refuse a config that cannot graduate', () => {
  const cfg = buildPreset(PRESETS.meme);
  const cfg2 = buildPreset(PRESETS.meme);
  const good = simulate(cfg2, 12);
  const sim = { ...good, quoteToGraduate: null, graduationReachable: false };
  assert.throws(() => buildConfigParameters(cfg2, sim as any, opts), /cannot graduate/);
});
