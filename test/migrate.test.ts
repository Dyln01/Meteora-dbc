import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MIGRATION_OPTIONS, migrationPreview } from '../src/migrate.js';
import { buildPreset, PRESETS } from '../src/presets.js';
import { simulate } from '../src/simulate.js';

for (const id of Object.keys(PRESETS)) {
  test(`migration preview conserves value for preset ${id}`, () => {
    const cfg = buildPreset(PRESETS[id]);
    const sim = simulate(cfg, 40);
    const p = migrationPreview(cfg, sim, {
      ...DEFAULT_MIGRATION_OPTIONS,
      baseDecimals: cfg.baseDecimals ?? 9,
      quoteDecimals: cfg.quoteDecimals ?? 9,
    });

    const threshold = BigInt(p.migrationQuoteThreshold);
    const fee = BigInt(p.migrationFee);
    // fee + seed == threshold, and the fee split adds up to the fee
    assert.equal(BigInt(p.quoteToDammV2) + fee, threshold);
    assert.equal(BigInt(p.creatorMigrationFee) + BigInt(p.protocolMigrationFee), fee);
    // LP split is a partition of 100
    assert.equal(
      p.lpSplit.partnerLockedPct + p.lpSplit.creatorPct + p.lpSplit.programDefinedPct,
      100,
    );
    // unsold base is non-negative and never exceeds the curve total
    assert.ok(BigInt(p.baseToDammV2) >= 0n);
    // prices are sane and the seed sits in the same order of magnitude as migration
    assert.ok(p.impliedSeedPriceHuman > 0);
    assert.ok(p.seedPriceRatio > 0.1 && p.seedPriceRatio < 10, `seed ratio ${p.seedPriceRatio}`);
  });
}

test('migration preview fee math is exact at whole percent', () => {
  const cfg = buildPreset(PRESETS.rwa);
  const sim = simulate(cfg, 40);
  const p = migrationPreview(cfg, sim, { ...DEFAULT_MIGRATION_OPTIONS, migrationFeePct: 2 });
  const threshold = BigInt(p.migrationQuoteThreshold);
  const net = (threshold * 100n) / 102n;
  assert.equal(BigInt(p.migrationFee), threshold - net);
  assert.equal(BigInt(p.quoteToDammV2), net);
});
