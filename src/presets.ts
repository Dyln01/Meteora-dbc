/**
 * Preset library.
 *
 * Presets are expressed in human terms — target raise, price multiple, number
 * of segments — and converted into the raw `LiquidityDistributionParameters`
 * the program expects. Liquidity is *derived* by inverting the quote-delta
 * formula rather than hard-coded, so a preset stays correct across decimals
 * and quote tokens, and a builder can retarget it by changing one number.
 *
 * Inversion: from  Δb = L * (√P_u - √P_l) / 2^128   we get
 *              L  = Δb * 2^128 / (√P_u - √P_l)
 */

import { CurveConfig, LiquidityDistribution, QUOTE_SCALE, sqrtFromPrice, priceFromSqrt } from './dbc.js';

/** Liquidity needed to absorb `quote` across [lowerSqrt, upperSqrt). */
export function liquidityForQuote(lowerSqrt: bigint, upperSqrt: bigint, quote: bigint): bigint {
  if (upperSqrt <= lowerSqrt) throw new Error('upperSqrt must exceed lowerSqrt');
  if (quote <= 0n) return 0n;
  return (quote * QUOTE_SCALE) / (upperSqrt - lowerSqrt);
}

export interface PresetSpec {
  id: string;
  name: string;
  /** What the preset is for. */
  rationale: string;
  /** Launch price, quote per base, raw units. */
  startPrice: number;
  /** Total price multiple from launch to graduation (e.g. 20 => 20x). */
  multiple: number;
  /** Target total raise, in whole quote units (e.g. 500 => 500 SOL). */
  targetRaise: number;
  /** How the raise is distributed across segments, as relative weights. */
  weights: number[];
  baseDecimals: number;
  quoteDecimals: number;
}

/** Build a deployable CurveConfig from a human-readable preset spec. */
export function buildPreset(spec: PresetSpec): CurveConfig {
  const endPrice = spec.startPrice * spec.multiple;
  const sqrtStart = sqrtFromPrice(spec.startPrice);
  const sqrtEnd = sqrtFromPrice(endPrice);

  const n = spec.weights.length;
  const totalWeight = spec.weights.reduce((a, b) => a + b, 0);
  const totalRaise = BigInt(Math.round(spec.targetRaise * 10 ** spec.quoteDecimals));

  // Geometric price boundaries so each segment covers an equal price multiple.
  const perSegmentMultiple = Math.pow(spec.multiple, 1 / n);
  const curve: LiquidityDistribution[] = [];
  let lower = sqrtStart;
  for (let i = 0; i < n; i++) {
    const boundaryPrice = spec.startPrice * Math.pow(perSegmentMultiple, i + 1);
    const upper = i === n - 1 ? sqrtEnd : sqrtFromPrice(boundaryPrice);
    const share = (totalRaise * BigInt(Math.round((spec.weights[i] / totalWeight) * 1e6))) / 1000000n;
    curve.push({ sqrtPrice: upper, liquidity: liquidityForQuote(lower, upper, share) });
    lower = upper;
  }

  return {
    sqrtStartPrice: sqrtStart,
    sqrtMigrationPrice: sqrtEnd,
    curve,
    baseDecimals: spec.baseDecimals,
    quoteDecimals: spec.quoteDecimals,
  };
}

/* -------------------------------------------------------------------------- */
/*  The presets                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Meme launch. Steep early curve, most of the raise concentrated in the last
 * segments so the price discovery happens fast and graduation is cheap to reach
 * for retail size. 3 segments.
 */
export const MEME: PresetSpec = {
  id: 'meme',
  name: 'Meme / fast graduation',
  rationale:
    'Front-loads supply cheaply, then steepens. Most quote is absorbed late, so ' +
    'the visible price run happens near graduation — the behaviour meme buyers expect.',
  startPrice: 1e-6,
  multiple: 100,
  targetRaise: 800,
  weights: [1, 2, 5],
  baseDecimals: 6,
  quoteDecimals: 9,
};

/**
 * RWA / tokenized real-world asset. Flat curve, modest multiple, many segments.
 * Price stability matters more than discovery — an RWA has an off-chain
 * reference value, so the curve should track it, not speculate on it.
 */
export const RWA: PresetSpec = {
  id: 'rwa',
  name: 'RWA / stable issuance',
  rationale:
    'Low multiple and even segment weights: the goal is to distribute supply at ' +
    'close to reference value, not to produce a price run. Use with a quote token ' +
    'matching the asset denomination (USDC for USD-denominated RWAs).',
  startPrice: 0.98,
  multiple: 1.06,
  targetRaise: 250_000,
  weights: [1, 1, 1, 1, 1, 1],
  baseDecimals: 6,
  quoteDecimals: 6,
};

/**
 * Tokenized stock / equity pair. Thin, orderly price discovery with a tight
 * band around a reference price, and enough segments to keep slippage low for
 * larger orders. Quote in USDC (6 decimals).
 */
export const EQUITY: PresetSpec = {
  id: 'equity',
  name: 'Tokenized stock / equity',
  rationale:
    'Built for the xStocks / Backpack Onchain / Ondo RFQ style pairs Meteora calls ' +
    'out. Tight multiple around a reference price, 8 segments so large orders ' +
    'cross fewer boundaries and see less slippage.',
  startPrice: 172.5,
  multiple: 1.15,
  targetRaise: 500_000,
  weights: [1, 1, 1, 1, 1, 1, 1, 1],
  baseDecimals: 8,
  quoteDecimals: 6,
};

/**
 * AI agent token. Long curve, high multiple, small early segments — agents tend
 * to accumulate gradually, so early liquidity should be cheap and deep enough
 * that programmatic buying does not move price violently.
 */
export const AGENT: PresetSpec = {
  id: 'agent',
  name: 'AI agent token',
  rationale:
    'Long curve with a deep first segment so automated accumulators do not push ' +
    'price on every small buy. High multiple leaves room for a long tail.',
  startPrice: 1e-5,
  multiple: 300,
  targetRaise: 1_200,
  weights: [3, 2, 2, 1, 1, 1],
  baseDecimals: 9,
  quoteDecimals: 9,
};

export const PRESETS: Record<string, PresetSpec> = {
  meme: MEME,
  rwa: RWA,
  equity: EQUITY,
  agent: AGENT,
};

/** One-line human summary of a preset, for `dbc-forge presets`. */
export function presetSummary(spec: PresetSpec): string {
  const cfg = buildPreset(spec);
  return `${spec.id.padEnd(8)} ${String(spec.multiple).padStart(5)}x  ` +
    `${String(spec.targetRaise.toLocaleString()).padStart(12)} raise  ` +
    `${String(cfg.curve.length).padStart(3)} seg  ${spec.name}`;
}
