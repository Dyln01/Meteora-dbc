/**
 * Devnet deployment of a validated dbc-forge config via the official
 * `@meteora-ag/dynamic-bonding-curve-sdk`.
 *
 * This is the step that turns the simulator into end-to-end tooling:
 * `emit` output goes in, a live DBC pool comes out.
 *
 * KEY MATERIAL POLICY
 *   The paying keypair is read from `KEYPAIR_PATH` (env) at run time and is
 *   never logged, never written to the deploy record, and never embedded in
 *   anything that gets committed. `--dry-run` builds and prints the exact
 *   config parameters and derived addresses without touching any keypair or
 *   RPC, so the whole path is demonstrable with zero funds.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2BaseFeeMode,
  DammV2DynamicFeeMode,
  DynamicBondingCurveClient,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithCustomSqrtPrices,
  createSqrtPrices,
  getMigrationBaseToken,
  deriveDbcPoolAddress,
  type ConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  CurveConfig,
  migrationBaseRequired,
  priceFromSqrt,
  toHumanPrice,
  totalBaseForCurveFull,
} from './dbc.js';
import { SimulationResult } from './simulate.js';

/** Wrapped SOL — always present on devnet, no faucet-mint required. */
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export interface DeployOptions {
  quoteMint: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  name: string;
  symbol: string;
  uri: string;
  /** Constant pool trading fee in bps (scheduler with start == end). */
  feeBps: number;
  /** Migration fee as a whole percent of the migration quote threshold. */
  migrationFeePct: number;
  /** Share of the migration fee routed to the creator, whole percent. */
  creatorShareOfMigrationFeePct: number;
}

export const DEFAULT_DEVNET_OPTIONS = {
  quoteMint: NATIVE_MINT,
  baseDecimals: 6,
  quoteDecimals: 9,
  feeBps: 100,
  migrationFeePct: 1,
  creatorShareOfMigrationFeePct: 50,
};

export interface DeployRecord {
  cluster: string;
  rpcUrl: string;
  deployedAt: string | null;
  signature: string | null;
  dryRun: boolean;
  config: string;
  baseMint: string;
  quoteMint: string;
  pool: string;
  payer: string;
  token: { name: string; symbol: string; uri: string };
  migrationQuoteThreshold: string;
  feeBps: number;
  migrationFeePct: number;
  curve: { sqrtPrice: string; liquidity: string }[];
  sqrtStartPrice: string;
}

/**
 * Map a validated forge config onto the SDK's `ConfigParameters`.
 *
 * The SDK's curve builders are used for the structurally fiddly sub-objects
 * (fee scheduler, migration fee, vesting), then the three numbers this repo
 * is the authority on — start price, curve segments, migration threshold —
 * are overwritten with the exact Q64.64 / raw-unit values from `emit`.
 * Pure: no network, no keys. Unit-testable.
 */
export function buildConfigParameters(
  cfg: CurveConfig,
  sim: SimulationResult,
  opts: DeployOptions,
): ConfigParameters {
  if (sim.quoteToGraduate === null || !sim.graduationReachable) {
    throw new Error('config cannot graduate; refusing to build deploy parameters (run `validate` first)');
  }
  const baseDec = opts.baseDecimals;
  const quoteDec = opts.quoteDecimals;
  const curveBaseRaw = totalBaseForCurveFull(cfg);
  const unit = 10n ** BigInt(baseDec);
  // The program's supply accounting needs headroom beyond the curve: its
  // validation walks the full curve as a swap buffer AND reserves the
  // migration base, so supply = curve + migration base + slack. The slack
  // rides in `leftover`, which the leftoverReceiver (the deployer) can
  // reclaim after migration.
  const netQuote = (sim.quoteToGraduate * 100n) / (100n + BigInt(opts.migrationFeePct));
  const migrationBase = BigInt(
    getMigrationBaseToken(
      new BN(netQuote.toString()),
      new BN(cfg.sqrtMigrationPrice.toString()),
      MigrationOption.MET_DAMM_V2,
    ).toString(),
  );
  const slack = 8n * unit;
  const leftoverRaw = migrationBase + slack;
  const supplyRaw = curveBaseRaw + leftoverRaw;
  const supplyHuman = Math.ceil(Number(supplyRaw) / 10 ** baseDec);

  // Human-readable boundary prices for the builder; the exact Q64.64 values
  // are stamped over the result below, so precision here only affects the
  // segment count.
  const sqrtPrices = [cfg.sqrtStartPrice, ...cfg.curve.map((s) => s.sqrtPrice)].map((sq) =>
    toHumanPrice(priceFromSqrt(sq), baseDec, quoteDec),
  );

  const params = buildCurveWithCustomSqrtPrices({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: baseDec as TokenDecimal,
      tokenQuoteDecimal: quoteDec,
      tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAuthority,
      totalTokenSupply: supplyHuman,
      leftover: Number(leftoverRaw) / 10 ** baseDec,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          // constant fee: the SDK requires zero scheduler periods when the
          // starting and ending fee are equal
          startingFeeBps: opts.feeBps,
          endingFeeBps: opts.feeBps,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 1,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: {
        feePercentage: opts.migrationFeePct,
        creatorFeePercentage: opts.creatorShareOfMigrationFeePct,
      },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: 30,
        baseFeeMode: DammV2BaseFeeMode.FeeTimeSchedulerLinear,
      },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    sqrtPrices: createSqrtPrices(sqrtPrices, baseDec as TokenDecimal, quoteDec),
    liquidityWeights: cfg.curve.map(() => 1),
  });

  // Stamp the authoritative numbers from the validated config.
  params.sqrtStartPrice = new BN(cfg.sqrtStartPrice.toString());
  params.curve = cfg.curve.map((s) => ({
    sqrtPrice: new BN(s.sqrtPrice.toString()),
    liquidity: new BN(s.liquidity.toString()),
  }));
  params.migrationQuoteThreshold = new BN(sim.quoteToGraduate.toString());
  const supply = params as unknown as { tokenSupply?: { totalTokenSupply?: BN; leftover?: BN } };
  if (supply.tokenSupply && typeof supply.tokenSupply === 'object') {
    supply.tokenSupply.totalTokenSupply = new BN(supplyRaw.toString());
    supply.tokenSupply.leftover = new BN(leftoverRaw.toString());
  }
  return params;
}

/** Read the paying keypair from KEYPAIR_PATH. Fails closed. */
export function loadPayerKeypair(): Keypair {
  const path = process.env.KEYPAIR_PATH;
  if (!path) {
    throw new Error(
      'KEYPAIR_PATH is not set. Point it at a local keypair json you generated yourself ' +
        '(solana-keygen new -o ~/keys/devnet.json). The key never enters the repo or the deploy record.',
    );
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export interface RunDeployArgs {
  cfg: CurveConfig;
  sim: SimulationResult;
  opts: DeployOptions;
  rpcUrl: string;
  dryRun: boolean;
  outPath: string;
  label: string;
}

export async function runDeploy(a: RunDeployArgs): Promise<DeployRecord> {
  const connection = new Connection(a.rpcUrl, 'confirmed');
  const client = DynamicBondingCurveClient.create(connection, 'confirmed');

  // Ephemeral signers: config and base mint are created by this transaction
  // and hold no funds; they only need to sign their own initialization.
  const config = Keypair.generate();
  const baseMint = Keypair.generate();
  const payer = a.dryRun ? Keypair.generate() : loadPayerKeypair();

  const params = buildConfigParameters(a.cfg, a.sim, a.opts);

  if (!a.dryRun) {
    const lamports = await connection.getBalance(payer.publicKey);
    if (lamports < 20_000_000) {
      throw new Error(
        `payer ${payer.publicKey.toBase58()} holds ${(lamports / 1e9).toFixed(4)} SOL — need >= 0.02. ` +
          `Airdrop first: solana airdrop 2 ${payer.publicKey.toBase58()}`,
      );
    }
  }

  const tx = await client.partner.createConfigAndPool({
    config: config.publicKey,
    feeClaimer: payer.publicKey,
    leftoverReceiver: payer.publicKey,
    payer: payer.publicKey,
    quoteMint: a.opts.quoteMint,
    ...params,
    preCreatePoolParam: {
      baseMint: baseMint.publicKey,
      name: a.opts.name,
      symbol: a.opts.symbol,
      uri: a.opts.uri,
      poolCreator: payer.publicKey,
    },
  });

  const pool = deriveDbcPoolAddress(a.opts.quoteMint, baseMint.publicKey, config.publicKey);

  const record: DeployRecord = {
    cluster: a.rpcUrl.includes('devnet') ? 'devnet' : a.rpcUrl.includes('mainnet') ? 'mainnet-beta' : 'local',
    rpcUrl: a.rpcUrl,
    deployedAt: null,
    signature: null,
    dryRun: a.dryRun,
    config: config.publicKey.toBase58(),
    baseMint: baseMint.publicKey.toBase58(),
    quoteMint: a.opts.quoteMint.toBase58(),
    pool: pool.toBase58(),
    payer: payer.publicKey.toBase58(),
    token: { name: a.opts.name, symbol: a.opts.symbol, uri: a.opts.uri },
    migrationQuoteThreshold: a.sim.quoteToGraduate!.toString(),
    feeBps: a.opts.feeBps,
    migrationFeePct: a.opts.migrationFeePct,
    curve: a.cfg.curve.map((s) => ({ sqrtPrice: s.sqrtPrice.toString(), liquidity: s.liquidity.toString() })),
    sqrtStartPrice: a.cfg.sqrtStartPrice.toString(),
  };

  if (a.dryRun) {
    console.log('dry run — transaction built, nothing signed or sent');
    console.log(`  config       ${record.config}`);
    console.log(`  base mint    ${record.baseMint}`);
    console.log(`  pool (PDA)   ${record.pool}`);
    console.log(`  instructions ${tx.instructions.length}`);
    writeFileSync(a.outPath, JSON.stringify(record, null, 2));
    console.log(`  record       ${a.outPath}`);
    return record;
  }

  tx.feePayer = payer.publicKey;
  const signature = await sendAndConfirmTransaction(connection, tx, [payer, config, baseMint], {
    commitment: 'confirmed',
  });
  record.signature = signature;
  record.deployedAt = new Date().toISOString();

  const live = await client.state.getPool(pool);
  if (!live) throw new Error(`pool ${pool.toBase58()} not found after confirmation — investigate ${signature}`);

  writeFileSync(a.outPath, JSON.stringify(record, null, 2));
  console.log(`deployed ${a.label}`);
  console.log(`  signature  ${signature}`);
  console.log(`  config     ${record.config}`);
  console.log(`  base mint  ${record.baseMint}`);
  console.log(`  pool       ${record.pool}`);
  console.log(`  record     ${a.outPath}`);
  console.log(`  feed       dbc-forge feed --pool ${record.pool}`);
  return record;
}
