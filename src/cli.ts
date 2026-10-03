#!/usr/bin/env node
/**
 * dbc-forge CLI
 *
 *   dbc-forge presets                     list built-in presets
 *   dbc-forge simulate --preset meme      simulate a preset's curve
 *   dbc-forge simulate --config c.json    simulate your own config
 *   dbc-forge validate --preset rwa       run only the validation checks
 *   dbc-forge emit --preset equity        print a deployable config as JSON
 */

import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { buildPreset, presetSummary, PRESETS, PresetSpec } from './presets.js';
import { simulate, validate, formatReport } from './simulate.js';
import { CurveConfig } from './dbc.js';
import { DEFAULT_DEVNET_OPTIONS, NATIVE_MINT, runDeploy } from './deploy.js';
import { formatLine, openFeed, serveFeed } from './feed.js';
import { DEFAULT_MIGRATION_OPTIONS, formatMigrationPreview, migrationPreview } from './migrate.js';

interface Args {
  cmd: string;
  preset?: string;
  config?: string;
  steps: number;
  raise?: number;
  multiple?: number;
  pool?: string;
  port?: number;
  interval?: number;
  once?: boolean;
  dryRun?: boolean;
  out?: string;
  quoteMint?: string;
  quoteDecimals?: number;
  baseDecimals?: number;
  name?: string;
  symbol?: string;
  uri?: string;
  json?: boolean;
}

function parse(argv: string[]): Args {
  const a: Args = { cmd: argv[0] ?? 'help', steps: 24 };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--preset') a.preset = argv[++i];
    else if (t === '--config') a.config = argv[++i];
    else if (t === '--steps') a.steps = Number(argv[++i]);
    else if (t === '--raise') a.raise = Number(argv[++i]);
    else if (t === '--multiple') a.multiple = Number(argv[++i]);
    else if (t === '--pool') a.pool = argv[++i];
    else if (t === '--port') a.port = Number(argv[++i]);
    else if (t === '--interval') a.interval = Number(argv[++i]);
    else if (t === '--once') a.once = true;
    else if (t === '--dry-run') a.dryRun = true;
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--quote-mint') a.quoteMint = argv[++i];
    else if (t === '--quote-decimals') a.quoteDecimals = Number(argv[++i]);
    else if (t === '--base-decimals') a.baseDecimals = Number(argv[++i]);
    else if (t === '--name') a.name = argv[++i];
    else if (t === '--symbol') a.symbol = argv[++i];
    else if (t === '--uri') a.uri = argv[++i];
    else if (t === '--json') a.json = true;
  }
  return a;
}

/** Load a config from --preset, optionally overriding raise/multiple. */
function loadConfig(a: Args): { cfg: CurveConfig; spec?: PresetSpec } {
  if (a.preset) {
    const spec = PRESETS[a.preset];
    if (!spec) throw new Error(`unknown preset "${a.preset}" — try: ${Object.keys(PRESETS).join(', ')}`);
    const tuned: PresetSpec = {
      ...spec,
      targetRaise: a.raise ?? spec.targetRaise,
      multiple: a.multiple ?? spec.multiple,
    };
    return { cfg: buildPreset(tuned), spec: tuned };
  }
  if (a.config) {
    const raw = JSON.parse(readFileSync(a.config, 'utf8'));
    return { cfg: revive(raw) };
  }
  throw new Error('pass --preset <name> or --config <file.json>');
}

/** JSON has no bigint, so configs are stored as strings and revived here. */
function revive(raw: any): CurveConfig {
  return {
    sqrtStartPrice: BigInt(raw.sqrtStartPrice),
    sqrtMigrationPrice: BigInt(raw.sqrtMigrationPrice),
    baseDecimals: raw.baseDecimals ?? 9,
    quoteDecimals: raw.quoteDecimals ?? 9,
    curve: (raw.curve ?? []).map((s: any) => ({
      sqrtPrice: BigInt(s.sqrtPrice),
      liquidity: BigInt(s.liquidity),
    })),
  };
}

function serialize(cfg: CurveConfig) {
  return JSON.stringify(
    {
      sqrtStartPrice: cfg.sqrtStartPrice.toString(),
      sqrtMigrationPrice: cfg.sqrtMigrationPrice.toString(),
      baseDecimals: cfg.baseDecimals ?? 9,
      quoteDecimals: cfg.quoteDecimals ?? 9,
      curve: cfg.curve.map((s) => ({ sqrtPrice: s.sqrtPrice.toString(), liquidity: s.liquidity.toString() })),
    },
    null,
    2,
  );
}

const HELP = `dbc-forge — simulation, validation and deployment tooling for Meteora Dynamic Bonding Curve configs

Usage
  dbc-forge presets
  dbc-forge simulate  (--preset <name> | --config <file>) [--steps N] [--raise N] [--multiple N]
  dbc-forge validate  (--preset <name> | --config <file>)
  dbc-forge emit      (--preset <name> | --config <file>)
  dbc-forge migrate-preview (--preset <name> | --config <file>) [--json]
  dbc-forge deploy    (--preset <name> | --config <file>) [--dry-run] [--out record.json]
                      [--quote-mint <addr>] [--name N] [--symbol S] [--uri U]
  dbc-forge feed      --pool <addr> [--once | --port N] [--interval ms]

deploy reads the paying keypair from KEYPAIR_PATH (env) and the RPC from
RPC_URL (default https://api.devnet.solana.com). --dry-run needs neither.
Presets: ${Object.keys(PRESETS).join(', ')}`;

function main(): void {
  const a = parse(process.argv.slice(2));
  switch (a.cmd) {
    case 'presets': {
      console.log('id        multiple        target raise  seg  name');
      for (const k of Object.keys(PRESETS)) console.log(presetSummary(PRESETS[k]));
      return;
    }
    case 'migrate-preview': {
      const { cfg } = loadConfig(a);
      const findings = validate(cfg);
      if (findings.some((f) => f.severity === 'error')) {
        console.log('config is invalid; preview skipped:');
        for (const f of findings) console.log(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
        process.exitCode = 1;
        return;
      }
      const sim = simulate(cfg, a.steps);
      const preview = migrationPreview(cfg, sim, {
        ...DEFAULT_MIGRATION_OPTIONS,
        baseDecimals: cfg.baseDecimals ?? 9,
        quoteDecimals: cfg.quoteDecimals ?? 9,
      });
      console.log(a.json ? JSON.stringify(preview, null, 2) : formatMigrationPreview(preview));
      return;
    }
    case 'deploy': {
      const { cfg, spec } = loadConfig(a);
      const findings = validate(cfg);
      if (findings.some((f) => f.severity === 'error')) {
        console.log('config is invalid; deploy skipped:');
        for (const f of findings) console.log(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
        process.exitCode = 1;
        return;
      }
      const sim = simulate(cfg, a.steps);
      const label = a.preset ?? a.config ?? 'config';
      // The config's own decimals are authoritative: raw prices and the
      // migration threshold are scaled by them. The quote mint must match.
      const quoteDecimals = a.quoteDecimals ?? cfg.quoteDecimals ?? 9;
      const baseDecimals = a.baseDecimals ?? cfg.baseDecimals ?? 6;
      let quoteMint = a.quoteMint ? new PublicKey(a.quoteMint) : NATIVE_MINT;
      if (!a.quoteMint && quoteDecimals !== 9) {
        throw new Error(
          `this config is quoted in a ${quoteDecimals}-decimal token; pass --quote-mint <addr> ` +
            `(and --quote-decimals ${quoteDecimals}) for a matching mint, or deploy a SOL-quoted preset`,
        );
      }
      void runDeploy({
        cfg,
        sim,
        opts: {
          ...DEFAULT_DEVNET_OPTIONS,
          baseDecimals,
          quoteDecimals,
          quoteMint,
          name: a.name ?? `dbc-forge ${label}`,
          symbol: a.symbol ?? `FORGE${(spec?.id ?? 'CFG').slice(0, 4).toUpperCase()}`,
          uri: a.uri ?? 'https://dbc-forge.local/metadata.json',
        },
        rpcUrl: process.env.RPC_URL ?? 'https://api.devnet.solana.com',
        dryRun: Boolean(a.dryRun),
        outPath: a.out ?? 'deploy-record.json',
        label,
      }).catch((e: any) => {
        console.error(`error: ${e?.message ?? e}`);
        process.exitCode = 2;
      });
      return;
    }
    case 'feed': {
      if (!a.pool) throw new Error('feed needs --pool <address>');
      const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
      const decimals = { baseDecimals: a.baseDecimals ?? 6, quoteDecimals: a.quoteDecimals ?? 9 };
      void openFeed(rpcUrl, a.pool, decimals).then(async (handle) => {
        if (a.once) {
          console.log(JSON.stringify(await handle.snapshot(), null, 2));
          return;
        }
        if (a.port) {
          await serveFeed(handle, a.port, a.interval ?? 2000);
          return;
        }
        const tick = async () => {
          try {
            console.log(formatLine(await handle.snapshot()));
          } catch (e: any) {
            console.log(`-- poll failed: ${e?.message ?? e}`);
          }
        };
        await tick();
        const t = setInterval(tick, a.interval ?? 5000);
        process.once('SIGINT', () => {
          clearInterval(t);
          process.exit(0);
        });
      });
      return;
    }
    case 'simulate':
    case 'validate': {
      const { cfg, spec } = loadConfig(a);
      // Validate FIRST. Simulation walks the curve and throws on a malformed
      // one, so running it first would make `validate` crash on exactly the
      // broken configs it exists to diagnose.
      const findings = validate(cfg);
      const hasError = findings.some((f) => f.severity === 'error');
      if (a.cmd === 'validate') {
        if (!findings.length) console.log('clean — no errors or warnings');
        for (const f of findings) console.log(`[${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
        process.exitCode = hasError ? 1 : 0;
        return;
      }
      if (spec) console.log(`preset: ${spec.id} — ${spec.rationale}\n`);
      if (hasError) {
        // Still print findings, but skip the simulation rather than throwing.
        console.log('config is invalid; simulation skipped:');
        for (const f of findings) console.log(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
        process.exitCode = 1;
        return;
      }
      const sim = simulate(cfg, a.steps);
      console.log(formatReport(cfg, sim, findings));
      process.exitCode = 0;
      return;
    }
    case 'emit': {
      const { cfg } = loadConfig(a);
      console.log(serialize(cfg));
      return;
    }
    default:
      console.log(HELP);
  }
}

try {
  main();
} catch (e: any) {
  console.error(`error: ${e?.message ?? e}`);
  process.exitCode = 2;
}
