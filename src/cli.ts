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
import { buildPreset, presetSummary, PRESETS, PresetSpec } from './presets.js';
import { simulate, validate, formatReport } from './simulate.js';
import { CurveConfig } from './dbc.js';

interface Args {
  cmd: string;
  preset?: string;
  config?: string;
  steps: number;
  raise?: number;
  multiple?: number;
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

const HELP = `dbc-forge — offline simulation and validation for Meteora Dynamic Bonding Curve configs

Usage
  dbc-forge presets
  dbc-forge simulate  (--preset <name> | --config <file>) [--steps N] [--raise N] [--multiple N]
  dbc-forge validate  (--preset <name> | --config <file>)
  dbc-forge emit      (--preset <name> | --config <file>)

Presets: ${Object.keys(PRESETS).join(', ')}
All computation is offline. Nothing is signed, broadcast, or deployed.`;

function main(): void {
  const a = parse(process.argv.slice(2));
  switch (a.cmd) {
    case 'presets': {
      console.log('id        multiple        target raise  seg  name');
      for (const k of Object.keys(PRESETS)) console.log(presetSummary(PRESETS[k]));
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
