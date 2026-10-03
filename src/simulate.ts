/**
 * Curve simulation and pre-deployment config validation.
 *
 * The simulator answers the two questions a launchpad builder actually has
 * before spending money on a deployment: "what does my price path look like?"
 * and "at what market cap does this graduate, and how much quote does it take
 * to get there?" Both are computed offline, from the same primitives the
 * on-chain program uses — see ./dbc.ts.
 */

import {
  CurveConfig,
  LiquidityDistribution,
  Rounding,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
  deltaBase,
  deltaQuote,
  nextSqrtFromQuoteIn,
  priceFromSqrt,
  sqrtFromPrice,
  totalBaseForCurve,
  totalQuoteForCurve,
} from './dbc.js';

/* -------------------------------------------------------------------------- */
/*  Simulation                                                                */
/* -------------------------------------------------------------------------- */

export interface SimPoint {
  /** Quote spent cumulatively, raw units. */
  quoteSpent: bigint;
  /** Base acquired cumulatively, raw units. */
  baseAcquired: bigint;
  /** sqrt-price after this step. */
  sqrtPrice: bigint;
  /** Human-readable price (quote per base, raw units). */
  price: number;
  /** Index of the segment this point sits in. */
  segment: number;
  /** 0..1 progress from start price to migration price. */
  progress: number;
}

export interface SimulationResult {
  points: SimPoint[];
  /** Quote needed to reach graduation, raw units. `null` if unreachable. */
  quoteToGraduate: bigint | null;
  /** Base tokens sold by graduation, raw units. */
  baseSoldAtGraduation: bigint;
  /** Whether the migration price falls inside the supplied curve. */
  graduationReachable: boolean;
  /** price(end) / price(start) — the total multiple across the curve. */
  priceMultiple: number;
}

/**
 * Walk the curve in `steps` equal quote increments from start to migration.
 *
 * Each step advances the price with `nextSqrtFromQuoteIn` inside the current
 * segment, then crosses into the next segment when the boundary is reached —
 * the same traversal `process_swap` performs on chain.
 */
export function simulate(cfg: CurveConfig, steps = 24): SimulationResult {
  const quoteToGraduate = totalQuoteForCurve(cfg);
  const baseSold = totalBaseForCurve(cfg);
  const graduationReachable = quoteToGraduate > 0n;

  const points: SimPoint[] = [];
  const startPrice = priceFromSqrt(cfg.sqrtStartPrice);
  const endSqrt = cfg.sqrtMigrationPrice;
  const endPrice = priceFromSqrt(endSqrt);

  if (steps > 0 && graduationReachable) {
    const perStep = quoteToGraduate / BigInt(steps);
    let sqrtP = cfg.sqrtStartPrice;
    let quote = 0n;
    let base = 0n;
    for (let i = 1; i <= steps; i++) {
      const spend = i === steps ? quoteToGraduate - quote : perStep;
      if (spend <= 0n) break;
      const before = sqrtP;
      // consume `spend` across as many segments as needed
      let remaining = spend;
      while (remaining > 0n && sqrtP < endSqrt) {
        const seg = activeSegment(cfg, sqrtP);
        if (!seg) break;
        const upper = seg.sqrtPrice < endSqrt ? seg.sqrtPrice : endSqrt;
        if (upper <= sqrtP) break;
        const costToTop = deltaQuote(sqrtP, upper, seg.liquidity, Rounding.Down);
        if (remaining >= costToTop) {
          base += deltaBase(sqrtP, upper, seg.liquidity, Rounding.Down);
          remaining -= costToTop;
          sqrtP = upper;
        } else {
          base += deltaBase(sqrtP, nextSqrtFromQuoteIn(sqrtP, seg.liquidity, remaining), seg.liquidity, Rounding.Down);
          sqrtP = nextSqrtFromQuoteIn(sqrtP, seg.liquidity, remaining);
          remaining = 0n;
        }
      }
      quote += spend;
      points.push({
        quoteSpent: quote,
        baseAcquired: base,
        sqrtPrice: sqrtP,
        price: priceFromSqrt(sqrtP),
        segment: segmentIndexOf(cfg, before),
        progress: startPrice === endPrice ? 1 : (priceFromSqrt(sqrtP) - startPrice) / (endPrice - startPrice),
      });
    }
  }

  return {
    points,
    quoteToGraduate: graduationReachable ? quoteToGraduate : null,
    baseSoldAtGraduation: baseSold,
    graduationReachable,
    priceMultiple: startPrice === 0 ? 0 : endPrice / startPrice,
  };
}

/** The segment whose upper bound is the first one strictly above `sqrtPrice`. */
function activeSegment(cfg: CurveConfig, sqrtPrice: bigint): LiquidityDistribution | undefined {
  for (const seg of cfg.curve) if (seg.sqrtPrice > sqrtPrice) return seg;
  return undefined;
}

function segmentIndexOf(cfg: CurveConfig, sqrtPrice: bigint): number {
  for (let i = 0; i < cfg.curve.length; i++) if (cfg.curve[i].sqrtPrice > sqrtPrice) return i;
  return cfg.curve.length - 1;
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

export type Severity = 'error' | 'warn';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
}

/**
 * Static checks on a DBC config, run before anyone pays to deploy it.
 *
 * `error` findings mean the program will reject or misbehave. `warn` findings
 * are economically suspicious but technically valid — the kind of mistake that
 * produces a launchpad nobody can buy from, or one that graduates instantly.
 */
export function validate(cfg: CurveConfig, opts: { totalSupply?: bigint } = {}): Finding[] {
  const f: Finding[] = [];
  const err = (code: string, message: string) => f.push({ severity: 'error', code, message });
  const warn = (code: string, message: string) => f.push({ severity: 'warn', code, message });

  if (cfg.curve.length === 0) err('EMPTY_CURVE', 'curve has no liquidity segments');

  if (cfg.sqrtStartPrice < MIN_SQRT_PRICE || cfg.sqrtStartPrice > MAX_SQRT_PRICE) {
    err('START_PRICE_BOUNDS', `sqrtStartPrice ${cfg.sqrtStartPrice} outside [${MIN_SQRT_PRICE}, ${MAX_SQRT_PRICE}]`);
  }
  if (cfg.sqrtMigrationPrice < MIN_SQRT_PRICE || cfg.sqrtMigrationPrice > MAX_SQRT_PRICE) {
    err('MIGRATION_PRICE_BOUNDS', `sqrtMigrationPrice outside protocol bounds`);
  }
  if (cfg.sqrtMigrationPrice <= cfg.sqrtStartPrice) {
    err('MIGRATION_BEFORE_START', 'sqrtMigrationPrice must exceed sqrtStartPrice or the pool graduates on creation');
  }

  // Segments must be strictly increasing, positive liquidity.
  let prev = cfg.sqrtStartPrice;
  cfg.curve.forEach((seg, i) => {
    if (seg.sqrtPrice <= prev) {
      err('NON_MONOTONIC', `segment ${i} sqrtPrice ${seg.sqrtPrice} does not exceed previous boundary ${prev}`);
    }
    if (seg.liquidity <= 0n) err('ZERO_LIQUIDITY', `segment ${i} has zero liquidity`);
    if (seg.sqrtPrice > MAX_SQRT_PRICE) err('SEGMENT_BOUNDS', `segment ${i} exceeds MAX_SQRT_PRICE`);
    prev = seg.sqrtPrice;
  });

  // Migration must be reachable inside the curve, else the pool never graduates.
  const last = cfg.curve[cfg.curve.length - 1];
  if (last && last.sqrtPrice < cfg.sqrtMigrationPrice) {
    err(
      'MIGRATION_UNREACHABLE',
      `sqrtMigrationPrice ${cfg.sqrtMigrationPrice} is above the final segment boundary ${last.sqrtPrice}; ` +
        `the pool can never graduate. Extend the curve or lower the migration price.`,
    );
  }

  // Economic sanity, not correctness. These require walking the curve, which
  // throws on a malformed one — so they run only if the structural checks
  // above passed, and are guarded regardless. A validator must report bad
  // input, never crash on it.
  const structuralErrors = f.some((x) => x.severity === 'error');
  if (structuralErrors) return f;

  let quote = 0n;
  let base = 0n;
  try {
    quote = totalQuoteForCurve(cfg);
    base = totalBaseForCurve(cfg);
  } catch (e: any) {
    err('UNWALKABLE', `curve traversal failed: ${e?.message ?? e}`);
    return f;
  }

  const qd = cfg.quoteDecimals ?? 9;
  const bd = cfg.baseDecimals ?? 9;
  const quoteHuman = Number(quote) / 10 ** qd;
  const baseHuman = Number(base) / 10 ** bd;

  if (quote > 0n && quoteHuman < 1) {
    warn('TINY_RAISE', `curve raises only ~${quoteHuman.toFixed(4)} quote before graduating — likely mis-scaled liquidity`);
  }
  if (baseHuman > 0 && opts.totalSupply && base > opts.totalSupply) {
    err('OVERSELL', `curve sells ${base} base units, more than the declared total supply ${opts.totalSupply}`);
  }
  const mult = priceFromSqrt(cfg.sqrtMigrationPrice) / Math.max(priceFromSqrt(cfg.sqrtStartPrice), 1e-300);
  if (mult > 1000) warn('EXTREME_MULTIPLE', `price rises ${mult.toFixed(0)}x across the curve — early buyers capture nearly all value`);
  if (mult < 1.5) warn('FLAT_CURVE', `price rises only ${mult.toFixed(2)}x; a flat curve gives no discovery signal`);

  return f;
}

/* -------------------------------------------------------------------------- */
/*  Reporting                                                                 */
/* -------------------------------------------------------------------------- */

export function formatReport(cfg: CurveConfig, sim: SimulationResult, findings: Finding[]): string {
  const qd = cfg.quoteDecimals ?? 9;
  const bd = cfg.baseDecimals ?? 9;
  const L: string[] = [];
  L.push('DBC curve report');
  L.push('─'.repeat(64));
  L.push(`  segments            ${cfg.curve.length}`);
  L.push(`  start price         ${priceFromSqrt(cfg.sqrtStartPrice).toExponential(6)}`);
  L.push(`  migration price     ${priceFromSqrt(cfg.sqrtMigrationPrice).toExponential(6)}`);
  L.push(`  price multiple      ${sim.priceMultiple.toFixed(2)}x`);
  L.push(`  quote to graduate   ${sim.quoteToGraduate === null ? 'unreachable' : (Number(sim.quoteToGraduate) / 10 ** qd).toFixed(6)}`);
  L.push(`  base sold           ${(Number(sim.baseSoldAtGraduation) / 10 ** bd).toFixed(4)}`);
  L.push(`  graduation          ${sim.graduationReachable ? 'reachable' : 'NOT reachable'}`);
  L.push('');
  L.push('  progress   quote spent        price                segment');
  for (const p of sim.points) {
    L.push(
      `  ${(p.progress * 100).toFixed(1).padStart(6)}%  ` +
        `${(Number(p.quoteSpent) / 10 ** qd).toFixed(4).padStart(14)}  ` +
        `${p.price.toExponential(5).padStart(16)}  ` +
        `${String(p.segment).padStart(4)}`,
    );
  }
  if (findings.length) {
    L.push('');
    L.push('  validation');
    for (const x of findings) L.push(`   [${x.severity.toUpperCase().padEnd(5)}] ${x.code}: ${x.message}`);
  } else {
    L.push('');
    L.push('  validation: clean');
  }
  return L.join('\n');
}

/** Convenience: build a config from a human-readable start/graduation price. */
export function curveFromPrices(
  startPrice: number,
  migrationPrice: number,
  segments: { atPriceFraction: number; liquidity: bigint }[],
  decimals = { base: 9, quote: 9 },
): CurveConfig {
  const sqrtStart = sqrtFromPrice(startPrice);
  const sqrtMig = sqrtFromPrice(migrationPrice);
  const curve = segments.map((s) => ({
    sqrtPrice: sqrtFromPrice(startPrice + (migrationPrice - startPrice) * s.atPriceFraction),
    liquidity: s.liquidity,
  }));
  return {
    sqrtStartPrice: sqrtStart,
    sqrtMigrationPrice: sqrtMig,
    curve,
    baseDecimals: decimals.base,
    quoteDecimals: decimals.quote,
  };
}
