/**
 * DAMM v2 migration preview — what graduation actually hands over.
 *
 * When a DBC pool reaches its migration quote threshold the program closes
 * the bonding curve and seeds a DAMM v2 pool with what is left: the unsold
 * base tokens and the raised quote, minus the migration fee. The LP tokens
 * minted for that liquidity are then split by the config's liquidity
 * distribution (here: 100% partner, permanently locked).
 *
 * This is a PREVIEW in the same spirit as the rest of the repo: the numbers
 * come from this repo's program-faithful curve math, not from a chain. It
 * answers "if this config graduates, what does the DAMM v2 pool open with?"
 * before anyone spends rent finding out.
 */

import BN from 'bn.js';
import { getMigrationBaseToken, MigrationOption } from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  CurveConfig,
  priceFromSqrt,
  toHumanPrice,
  totalBaseForCurve,
  totalBaseForCurveFull,
} from './dbc.js';
import { SimulationResult } from './simulate.js';

export interface MigrationPreviewOptions {
  /** Migration fee as whole percent of the migration quote threshold. */
  migrationFeePct: number;
  /** Share of that fee routed to the creator, whole percent. */
  creatorShareOfMigrationFeePct: number;
  /** Partner permanently-locked LP share, whole percent (config default 100). */
  partnerLockedLiquidityPct: number;
  /** Creator claimable LP share, whole percent (config default 0). */
  creatorLiquidityPct: number;
  baseDecimals: number;
  quoteDecimals: number;
}

export const DEFAULT_MIGRATION_OPTIONS: MigrationPreviewOptions = {
  migrationFeePct: 1,
  creatorShareOfMigrationFeePct: 50,
  partnerLockedLiquidityPct: 100,
  creatorLiquidityPct: 0,
  baseDecimals: 6,
  quoteDecimals: 9,
};

export interface MigrationPreview {
  /** Quote the curve must absorb to graduate, raw units. */
  migrationQuoteThreshold: string;
  /** migrationFeePct of the threshold, raw units. */
  migrationFee: string;
  creatorMigrationFee: string;
  protocolMigrationFee: string;
  /** Threshold minus fee: the quote that seeds the DAMM v2 pool. */
  quoteToDammV2: string;
  /** Base the program seeds into DAMM v2: netQuote / migrationPrice. */
  baseToDammV2: string;
  /** Unsold vault base left over after seeding — partner/creator surplus. */
  surplusBase: string;
  /** quoteToDammV2 / baseToDammV2 as a human quoted price. */
  impliedSeedPriceHuman: number;
  /** The config's migration price as a human quoted price, for comparison. */
  migrationPriceHuman: number;
  /** seed price / migration price — 1.0 means the seed sits exactly at migration. */
  seedPriceRatio: number;
  lpSplit: { partnerLockedPct: number; creatorPct: number; programDefinedPct: number };
  graduated: boolean;
}

const pct = (n: bigint, p: number): bigint => (n * BigInt(Math.round(p * 100))) / 10000n;

export function migrationPreview(
  cfg: CurveConfig,
  sim: SimulationResult,
  opts: MigrationPreviewOptions = DEFAULT_MIGRATION_OPTIONS,
): MigrationPreview {
  if (sim.quoteToGraduate === null || !sim.graduationReachable) {
    throw new Error('config cannot graduate; nothing to preview (run `validate` first)');
  }
  const threshold = sim.quoteToGraduate;
  // The threshold is fee-grossed on-chain: net = threshold / (1 + fee%).
  const net = (threshold * 100n) / (100n + BigInt(Math.round(opts.migrationFeePct)));
  const fee = threshold - net;
  const creatorFee = pct(fee, opts.creatorShareOfMigrationFeePct);
  const protocolFee = fee - creatorFee;
  const quoteToDamm = threshold - fee;
  // The program seeds DAMM v2 with base = netQuote / migrationPrice, drawn
  // from the pool's unsold base vault; whatever the vault holds beyond that
  // is surplus, withdrawable by partner/creator after migration.
  const baseToDamm = BigInt(
    getMigrationBaseToken(
      new BN(quoteToDamm.toString()),
      new BN(cfg.sqrtMigrationPrice.toString()),
      MigrationOption.MET_DAMM_V2,
    ).toString(),
  );
  const reserve = totalBaseForCurveFull(cfg) - sim.baseSoldAtGraduation;
  const surplus = reserve > baseToDamm ? reserve - baseToDamm : 0n;

  const impliedRaw = baseToDamm === 0n ? 0 : Number(quoteToDamm) / Number(baseToDamm);
  const impliedHuman = toHumanPrice(impliedRaw, opts.baseDecimals, opts.quoteDecimals);
  const migrationHuman = toHumanPrice(
    priceFromSqrt(cfg.sqrtMigrationPrice),
    cfg.baseDecimals ?? 9,
    cfg.quoteDecimals ?? 9,
  );
  const ratio = migrationHuman === 0 ? 0 : impliedHuman / migrationHuman;

  const partnerLocked = opts.partnerLockedLiquidityPct;
  const creator = opts.creatorLiquidityPct;
  return {
    migrationQuoteThreshold: threshold.toString(),
    migrationFee: fee.toString(),
    creatorMigrationFee: creatorFee.toString(),
    protocolMigrationFee: protocolFee.toString(),
    quoteToDammV2: quoteToDamm.toString(),
    baseToDammV2: baseToDamm.toString(),
    surplusBase: surplus.toString(),
    impliedSeedPriceHuman: impliedHuman,
    migrationPriceHuman: migrationHuman,
    seedPriceRatio: Number(ratio.toFixed(6)),
    lpSplit: {
      partnerLockedPct: partnerLocked,
      creatorPct: creator,
      programDefinedPct: 100 - partnerLocked - creator,
    },
    graduated: sim.graduationReachable,
  };
}

export function formatMigrationPreview(p: MigrationPreview): string {
  const L: string[] = [];
  L.push('DAMM v2 migration preview');
  L.push('─'.repeat(64));
  L.push(`  migration quote threshold   ${p.migrationQuoteThreshold}`);
  L.push(`  migration fee               ${p.migrationFee}  (creator ${p.creatorMigrationFee} / protocol ${p.protocolMigrationFee})`);
  L.push(`  quote seeding DAMM v2       ${p.quoteToDammV2}`);
  L.push(`  base seeding DAMM v2        ${p.baseToDammV2}`);
  L.push(`  post-migration surplus base ${p.surplusBase}  (withdrawable by partner/creator)`);
  L.push(`  implied seed price          ${p.impliedSeedPriceHuman.toExponential(6)}`);
  L.push(`  migration price             ${p.migrationPriceHuman.toExponential(6)}  (seed/migration ${p.seedPriceRatio.toFixed(4)}x)`);
  L.push(`  LP split                    partner locked ${p.lpSplit.partnerLockedPct}% / creator ${p.lpSplit.creatorPct}% / program-defined ${p.lpSplit.programDefinedPct}%`);
  return L.join('\n');
}
