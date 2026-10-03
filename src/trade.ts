/**
 * A demo-sized buy against a live DBC pool.
 *
 * Exists so the submission video can show the pool *trading*: quote in,
 * base out, progress-to-graduation ticking. The slippage guard is derived
 * from the live mid-price (this repo's tested snapshot math) rather than
 * the SDK's quote helper — fewer moving parts, and the bound is explicit:
 * at the current price amountIn buys at most amountIn/price base tokens,
 * so accepting (1 - slippage%) of that estimate can only fail on genuine
 * price movement or someone front-running the demo.
 */

import BN from 'bn.js';
import { Connection, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { loadKeypairFile } from './wallet.js';
import { openFeed, type PoolSnapshot } from './feed.js';

/** Minimum acceptable base out (raw units) for a quote-in buy. */
export function minOutFromPrice(
  amountInRaw: bigint,
  priceHuman: number,
  baseDecimals: number,
  quoteDecimals: number,
  slippagePct: number,
): bigint {
  if (!(priceHuman > 0)) throw new Error('pool price must be positive');
  // human amount in (quote units) -> estimated base units -> raw base units
  const amountInHuman = Number(amountInRaw) / 10 ** quoteDecimals;
  const baseOutHuman = amountInHuman / priceHuman;
  const baseOutRaw = baseOutHuman * 10 ** baseDecimals;
  return BigInt(Math.floor(baseOutRaw * (1 - slippagePct / 100)));
}

export interface BuyResult {
  signature: string;
  pool: string;
  amountInLamports: string;
  minimumBaseOut: string;
  before: PoolSnapshot;
  after: PoolSnapshot;
}

export async function executeBuy(opts: {
  rpcUrl: string;
  keypairPath: string;
  pool: string;
  solAmount: number;
  slippagePct: number;
}): Promise<BuyResult> {
  const connection = new Connection(opts.rpcUrl, 'confirmed');
  const client = DynamicBondingCurveClient.create(connection, 'confirmed');
  const owner = loadKeypairFile(opts.keypairPath);
  const feed = await openFeed(opts.rpcUrl, opts.pool, { baseDecimals: 6, quoteDecimals: 9 });

  const before = await feed.snapshot();
  const amountIn = BigInt(Math.round(opts.solAmount * 1e9));
  const minimumAmountOut = minOutFromPrice(
    amountIn,
    before.priceHuman,
    before.baseDecimals,
    before.quoteDecimals,
    opts.slippagePct,
  );

  const tx = await client.pool.swap({
    owner: owner.publicKey,
    pool: new PublicKey(opts.pool),
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(minimumAmountOut.toString()),
    swapBaseForQuote: false, // quote in, base out
    referralTokenAccount: null,
    payer: owner.publicKey,
  });
  tx.feePayer = owner.publicKey;
  const signature = await sendAndConfirmTransaction(connection, tx, [owner], {
    commitment: 'confirmed',
  });
  const after = await feed.snapshot();
  return {
    signature,
    pool: opts.pool,
    amountInLamports: amountIn.toString(),
    minimumBaseOut: minimumAmountOut.toString(),
    before,
    after,
  };
}
