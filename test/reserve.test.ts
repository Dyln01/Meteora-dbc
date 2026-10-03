import { test } from 'node:test';
import BN from 'bn.js';
import assert from 'node:assert/strict';
import { getMigrationBaseToken, MigrationOption } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { migrationBaseRequired } from '../src/dbc.js';
import { buildPreset, PRESETS } from '../src/presets.js';
import { simulate, validate } from '../src/simulate.js';

test('a curve ending exactly at migration is flagged as an unfunded migration', () => {
  const cfg = buildPreset(PRESETS.meme);
  // strip the reserve tail: trading curve only, ending at the migration price
  const tailless = { ...cfg, curve: cfg.curve.slice(0, -1) };
  assert.equal(tailless.curve[tailless.curve.length - 1].sqrtPrice, cfg.sqrtMigrationPrice);
  const codes = validate(tailless).map((f) => f.code);
  assert.ok(codes.includes('MIGRATION_RESERVE_SHORTFALL'), `got: ${codes.join(', ')}`);
  // and the shipped preset, tail included, is clean
  assert.ok(!validate(cfg).some((f) => f.severity === 'error'));
});

test('migrationBaseRequired matches the SDK getMigrationBaseToken', () => {
  for (const id of Object.keys(PRESETS)) {
    const cfg = buildPreset(PRESETS[id]);
    const sim = simulate(cfg, 40);
    const net = sim.quoteToGraduate! - sim.quoteToGraduate! / 100n;
    const ours = migrationBaseRequired(cfg.sqrtMigrationPrice, net);
    const theirs = getMigrationBaseToken(new BN(net.toString()), new BN(cfg.sqrtMigrationPrice.toString()), MigrationOption.MET_DAMM_V2);
    const theirsB = BigInt(theirs.toString());
    const diff = ours > theirsB ? ours - theirsB : theirsB - ours;
    // closed form (quote / price) approximates the program's concentrated
    // liquidity derivation from MIN_SQRT_PRICE; direction of the tiny gap
    // depends on the price scale, so assert closeness, not direction
    assert.ok(diff * 10000n <= theirsB, `${id}: ours ${ours} vs sdk ${theirsB}`);
  }
});
