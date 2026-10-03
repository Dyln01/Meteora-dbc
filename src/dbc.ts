/**
 * dbc-forge — exact TypeScript port of the Meteora Dynamic Bonding Curve math.
 *
 * Every formula here is transcribed from the on-chain program
 * `MeteoraAg/dynamic-bonding-curve` v0.2.1:
 *   - programs/dynamic-bonding-curve/src/curve.rs
 *   - programs/dynamic-bonding-curve/src/constants.rs
 *   - programs/dynamic-bonding-curve/src/params/liquidity_distribution.rs
 *
 * All arithmetic uses `bigint` to match the program's u128 / U256 domain.
 * Rounding direction is preserved exactly, because it is load-bearing: the
 * program rounds prices to guarantee it never crosses a segment boundary by
 * accident, and a simulator that rounds the other way will disagree with
 * mainnet by a few wei on every trade — enough to make graduation predictions
 * unreliable.
 */

/** Fixed-point resolution used for sqrt prices. curve.rs: `pub const RESOLUTION: u8 = 64` */
export const RESOLUTION = 64n;
/** Quote deltas are scaled by 2^(2*RESOLUTION) = 2^128. */
export const QUOTE_SCALE = 1n << (RESOLUTION * 2n);
/** constants.rs: `pub const ONE_Q64: u128 = 1u128 << 64` */
export const ONE_Q64 = 1n << 64n;
/** constants.rs */
export const MIN_SQRT_PRICE = 4295048016n;
export const MAX_SQRT_PRICE = 79226673521066979257578248091n;

export enum Rounding {
  Down,
  Up,
}

/** ceil(a * b / c) or floor(a * b / c) over bigints, matching `mul_div_u256`. */
export function mulDiv(a: bigint, b: bigint, c: bigint, round: Rounding): bigint {
  if (c === 0n) throw new Error('MathOverflow: division by zero');
  const num = a * b;
  if (round === Rounding.Down) return num / c;
  return (num + c - 1n) / c; // div_ceil
}

/* -------------------------------------------------------------------------- */
/*  Delta amounts (curve.rs)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Δa = L * (√P_upper - √P_lower) / (√P_upper * √P_lower)
 * Base-token amount unlocked when price moves from lower to upper sqrt price.
 * `get_delta_amount_base_unsigned_256` — the program asserts denominator > 0.
 */
export function deltaBase(
  lowerSqrtPrice: bigint,
  upperSqrtPrice: bigint,
  liquidity: bigint,
  round: Rounding,
): bigint {
  if (upperSqrtPrice <= lowerSqrtPrice) {
    throw new Error(
      `invalid price range: upper (${upperSqrtPrice}) must exceed lower (${lowerSqrtPrice})`,
    );
  }
  const denominator = lowerSqrtPrice * upperSqrtPrice;
  if (denominator === 0n) throw new Error('MathOverflow: zero denominator');
  return mulDiv(liquidity, upperSqrtPrice - lowerSqrtPrice, denominator, round);
}

/**
 * Δb = L * (√P_upper - √P_lower) / 2^128
 * Quote-token amount required to move price across the same range.
 * `get_delta_amount_quote_unsigned_unchecked`
 */
export function deltaQuote(
  lowerSqrtPrice: bigint,
  upperSqrtPrice: bigint,
  liquidity: bigint,
  round: Rounding,
): bigint {
  if (upperSqrtPrice <= lowerSqrtPrice) {
    throw new Error('invalid price range: upper must exceed lower');
  }
  const prod = liquidity * (upperSqrtPrice - lowerSqrtPrice);
  return round === Rounding.Up
    ? (prod + QUOTE_SCALE - 1n) / QUOTE_SCALE // div_ceil
    : prod >> (RESOLUTION * 2n); // overflowing_shr
}

/* -------------------------------------------------------------------------- */
/*  Next-sqrt-price transitions (curve.rs)                                    */
/* -------------------------------------------------------------------------- */

/** √P' = √P * L / (L + Δx * √P), rounded UP. Base token in (buy base). */
export function nextSqrtFromBaseIn(sqrtPrice: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtPrice;
  assert(sqrtPrice > 0n && liquidity > 0n, 'nextSqrtFromBaseIn: zero price or liquidity');
  const product = amount * sqrtPrice;
  return mulDiv(liquidity, sqrtPrice, liquidity + product, Rounding.Up);
}

/** √P' = √P + Δy * 2^128 / L, rounded DOWN. Quote token in. */
export function nextSqrtFromQuoteIn(sqrtPrice: bigint, liquidity: bigint, amount: bigint): bigint {
  assert(sqrtPrice > 0n && liquidity > 0n, 'nextSqrtFromQuoteIn: zero price or liquidity');
  const quotient = (amount << (RESOLUTION * 2n)) / liquidity;
  return sqrtPrice + quotient;
}

/** √P' = √P * L / (L - Δx * √P), rounded UP. Base token out (sell base). */
export function nextSqrtFromBaseOut(sqrtPrice: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtPrice;
  assert(sqrtPrice > 0n && liquidity > 0n, 'nextSqrtFromBaseOut: zero price or liquidity');
  const product = amount * sqrtPrice;
  const denominator = liquidity - product;
  if (denominator <= 0n) {
    throw new Error('insufficient liquidity for requested base output');
  }
  return mulDiv(liquidity, sqrtPrice, denominator, Rounding.Up);
}

/** √P' = √P - ceil(Δy * 2^128 / L), rounded DOWN. Quote token out. */
export function nextSqrtFromQuoteOut(sqrtPrice: bigint, liquidity: bigint, amount: bigint): bigint {
  assert(sqrtPrice > 0n && liquidity > 0n, 'nextSqrtFromQuoteOut: zero price or liquidity');
  const quotient = (amount << (RESOLUTION * 2n) + liquidity - 1n) / liquidity; // div_ceil
  const result = sqrtPrice - quotient;
  if (result < 0n) throw new Error('price underflow: requested quote output exceeds the segment');
  return result;
}

/* -------------------------------------------------------------------------- */
/*  Liquidity distribution (params/liquidity_distribution.rs)                  */
/* -------------------------------------------------------------------------- */

/** One segment of the curve: liquidity active up to `sqrtPrice`. */
export interface LiquidityDistribution {
  /** Upper sqrt-price boundary of this segment (Q64.64). */
  sqrtPrice: bigint;
  /** Liquidity deployed across this segment. */
  liquidity: bigint;
}

export interface CurveConfig {
  /** Price the token launches at. */
  sqrtStartPrice: bigint;
  /** Price at which the pool graduates and migrates to DAMM v2. */
  sqrtMigrationPrice: bigint;
  /** Ordered segments, strictly increasing in sqrtPrice. */
  curve: LiquidityDistribution[];
  /** Decimal places of the base (launched) token. */
  baseDecimals?: number;
  /** Decimal places of the quote token (SOL = 9, USDC = 6). */
  quoteDecimals?: number;
}

/**
 * Port of `get_base_token_for_swap`: total base tokens sold from the start
 * price up to the migration price, walking each segment and truncating the
 * final segment at `sqrtMigrationPrice`.
 *
 * The program uses `Rounding::Up` here (with a `TODO` noting the ambiguity),
 * so this port does too — matching on-chain behaviour is the point.
 */
export function totalBaseForCurve(cfg: CurveConfig): bigint {
  let total = 0n;
  for (let i = 0; i < cfg.curve.length; i++) {
    const lower = i === 0 ? cfg.sqrtStartPrice : cfg.curve[i - 1].sqrtPrice;
    const seg = cfg.curve[i];
    if (seg.sqrtPrice > cfg.sqrtMigrationPrice) {
      total += deltaBase(lower, cfg.sqrtMigrationPrice, seg.liquidity, Rounding.Up);
      break; // migration reached mid-segment; no further segments trade
    }
    total += deltaBase(lower, seg.sqrtPrice, seg.liquidity, Rounding.Up);
  }
  return total;
}

/** Total quote raised across the same traversal. Mirrors the base version. */
export function totalQuoteForCurve(cfg: CurveConfig): bigint {
  let total = 0n;
  for (let i = 0; i < cfg.curve.length; i++) {
    const lower = i === 0 ? cfg.sqrtStartPrice : cfg.curve[i - 1].sqrtPrice;
    const seg = cfg.curve[i];
    if (seg.sqrtPrice > cfg.sqrtMigrationPrice) {
      total += deltaQuote(lower, cfg.sqrtMigrationPrice, seg.liquidity, Rounding.Up);
      break;
    }
    total += deltaQuote(lower, seg.sqrtPrice, seg.liquidity, Rounding.Up);
  }
  return total;
}

/* -------------------------------------------------------------------------- */
/*  Price helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Convert a Q64.64 sqrt-price to a human price (quote per base, raw units).
 * P = (√P / 2^64)^2
 *
 * Done in floating point on the *sqrt* value rather than by bigint division:
 * squaring first would exceed Number.MAX_SAFE_INTEGER for large prices, and
 * bigint division would truncate small prices to zero. Dividing √P by 2^64
 * first keeps ~53 bits of precision, which is ample for display and for
 * progress reporting.
 */
export function priceFromSqrt(sqrtPrice: bigint): number {
  const n = Number(sqrtPrice) / Number(ONE_Q64);
  return n * n;
}

/** Exact integer square root (Newton's method over bigint). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt of negative');
  if (n < 2n) return n;
  let x = 1n << ((BigInt(n.toString(2).length) + 1n) / 2n);
  for (;;) {
    const y = (x + n / x) / 2n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * Inverse of {@link priceFromSqrt}: the Q64.64 sqrt-price for a target price.
 *
 * √P = isqrt(P * 2^128). The price is carried through as a rational scaled by
 * 1e24 so that sub-unit prices (1e-6 and below) keep full precision instead of
 * flooring to zero.
 */
export function sqrtFromPrice(price: number): bigint {
  if (!(price > 0)) throw new Error('price must be positive');
  const PRICE_SCALE = 10n ** 24n;
  const scaled = BigInt(Math.round(price * 1e12)) * 10n ** 12n; // price * 1e24
  const n = (scaled * QUOTE_SCALE) / PRICE_SCALE; // P * 2^128
  const r = isqrt(n);
  return r > MAX_SQRT_PRICE ? MAX_SQRT_PRICE : r;
}

/** Apply decimals so a raw-unit price reads as a quoted price. */
export function toHumanPrice(rawPrice: number, baseDecimals = 9, quoteDecimals = 9): number {
  return rawPrice * 10 ** baseDecimals / 10 ** quoteDecimals;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

export const _internal = { QUOTE_SCALE, ONE_Q64 };
