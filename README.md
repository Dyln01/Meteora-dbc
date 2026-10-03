# dbc-forge

Offline simulation, validation and presets for **Meteora's Dynamic Bonding Curve (DBC)**.

Answer the two questions every launchpad builder has *before* spending money on a
deployment — "what does my price path look like?" and "at what market cap does
this graduate, and how much quote does it take to get there?" — without touching
a chain.

Built for the [Crypto World's Fair — Best use of Meteora's DBC](https://superteam.fun/earn/listing/meteora-dbc) track.

---

## Why

Meteora's DBC is a fully configurable token-launch primitive: you control the
curve shape, fee schedule, quote token, graduation threshold, and how the pool
migrates into DAMM v2 liquidity. That configurability is the point — and it is
also the failure mode. A config is a list of `(sqrt_price, liquidity)` segments
in Q64.64 fixed point, and nothing about that representation tells you whether
the result is a sensible launch or a curve that can never graduate.

Today the only way to find out is to deploy and watch. `dbc-forge` moves that
feedback loop to your laptop:

```bash
npx dbc-forge simulate --preset meme --steps 12
```

```
preset: meme — Front-loads supply cheaply, then steepens...

DBC curve report
────────────────────────────────────────────────────────────────
  segments            3
  start price         1.000000e-6
  migration price     1.000000e-4
  price multiple      100.00x
  quote to graduate   800.000000
  base sold           7960000.0000
  graduation          reachable

  progress   quote spent        price                segment
     8.3%         66.6667     1.27934e-6       0
    ...
   100.0%        800.0000     1.00000e-4       2

  validation: clean
```

## Install

```bash
npm install
npm run build
npm test
```

No Solana toolchain, no Rust, no keypair, no RPC. Pure TypeScript on `bigint`.

## CLI

```bash
dbc-forge presets                       # list built-in presets
dbc-forge simulate --preset meme        # simulate a preset
dbc-forge simulate --preset rwa --raise 500000 --steps 40
dbc-forge validate --config my.json     # exit 1 on any error-level finding
dbc-forge emit --preset equity          # print a deployable config as JSON
```

`emit` writes bigints as strings (JSON has no bigint type); `--config` reads them
back. That round-trip is the handoff point to the `@meteora-ag/dynamic-bonding-curve`
SDK for an actual deployment.

## Library

```ts
import { buildPreset, PRESETS, simulate, validate, curveFromPrices } from 'dbc-forge';

const cfg = buildPreset({ ...PRESETS.equity, targetRaise: 250_000 });

const problems = validate(cfg);          // never throws on bad input
const sim = simulate(cfg, 50);
console.log(sim.quoteToGraduate, sim.priceMultiple, sim.graduationReachable);
```

Or build a curve straight from human prices:

```ts
const cfg = curveFromPrices(172.5, 198.0, [
  { atPriceFraction: 0.5, liquidity: 8n * 10n ** 30n },
  { atPriceFraction: 1.0, liquidity: 4n * 10n ** 30n },
]);
```

## Presets

Four starting points for the asset classes Meteora names in the track brief.
Liquidity is **derived** from a target raise by inverting the quote-delta
formula, not hard-coded — so a preset stays correct across decimals and quote
tokens, and you retarget it by changing one number.

| id | multiple | raise | segments | for |
|---|---|---|---|---|
| `meme` | 100x | 800 SOL | 4 | fast graduation, steep late curve |
| `rwa` | 1.06x | 250k USDC | 7 | stable issuance near reference value |
| `equity` | 1.15x | 500k USDC | 9 | tokenized stocks, low slippage on size |
| `agent` | 300x | 1,200 SOL | 7 | AI agent tokens, deep first segment |

The final segment of every preset is a **migration reserve tail**: liquidity
above the migration price that never trades pre-graduation but keeps the
base tokens in the vault that DAMM v2 seeding demands at graduation (see
below).

The shapes are deliberately different because the goals are: an RWA has an
off-chain reference price, so its curve should *track* value, not discover it.
An agent token gets bought programmatically in small increments, so its first
segment needs depth or every automated buy moves price.

## Model note — raise and float are coupled

Worth stating because it surprises people. Segment liquidity `L` scales **both**
totals:

- quote raised: `Δb = L · (√P_u − √P_l) / 2¹²⁸`
- base sold: `Δa = L · (√P_u − √P_l) / (√P_u · √P_l)`

Both are linear in `L`. So doubling `targetRaise` doubles the float too. If you
need a specific float *and* a specific raise, you have to move the price range as
well — you cannot hit both with the liquidity knob alone. `dbc-forge` will show
you both numbers so you can see the coupling instead of discovering it on
mainnet.

## Fidelity to the program

Every formula is transcribed from `MeteoraAg/dynamic-bonding-curve` **v0.2.1**:

| This repo | Program source |
|---|---|
| `deltaBase` | `curve.rs::get_delta_amount_base_unsigned_256` |
| `deltaQuote` | `curve.rs::get_delta_amount_quote_unsigned_unchecked` |
| `nextSqrtFromBaseIn` | `curve.rs::get_next_sqrt_price_from_base_amount_in_rounding_up` |
| `nextSqrtFromQuoteIn` | `curve.rs::get_next_sqrt_price_from_quote_amount_in_rounding_down` |
| `nextSqrtFromBaseOut` | `curve.rs::get_next_sqrt_price_from_base_amount_out_rounding_up` |
| `nextSqrtFromQuoteOut` | `curve.rs::get_next_sqrt_price_from_quote_amount_out_rounding_down` |
| `totalBaseForCurve` | `params/liquidity_distribution.rs::get_base_token_for_swap` |
| constants | `constants.rs` — `RESOLUTION = 64`, `MIN_SQRT_PRICE = 4295048016`, `MAX_SQRT_PRICE = 79226673521066979257578248091` |

**Rounding direction is preserved exactly**, because it is load-bearing: the
program rounds prices so a swap never accidentally crosses a segment boundary.
A simulator that rounds the other way drifts from mainnet by a few wei per trade
— enough to make graduation predictions unreliable, which is the entire point of
the tool.

`totalBaseForCurve` uses `Rounding::Up` to match the program, which carries a
`// TODO check whether we should use round down or round up` at that call site.
If the program changes, this needs to change with it.

## Validation

`validate()` returns findings rather than throwing — a validator that crashes on
malformed input is worse than no validator, because the malformed input is
exactly what you handed it.

**Errors** (the program will reject or misbehave): `EMPTY_CURVE`,
`START_PRICE_BOUNDS`, `MIGRATION_PRICE_BOUNDS`, `MIGRATION_BEFORE_START`,
`NON_MONOTONIC`, `ZERO_LIQUIDITY`, `SEGMENT_BOUNDS`, `MIGRATION_UNREACHABLE`,
`OVERSELL`, `UNWALKABLE`, `MIGRATION_RESERVE_SHORTFALL`.

**Warnings** (valid but economically suspicious): `TINY_RAISE`,
`EXTREME_MULTIPLE`, `FLAT_CURVE`.

`MIGRATION_UNREACHABLE` is the one worth the tool on its own: if
`sqrtMigrationPrice` sits above your final segment boundary, the pool can never
graduate and liquidity never migrates to DAMM v2. That is a silent, permanent
failure mode, and it is invisible in the raw parameter list.

## Tests

```bash
npm test
```

13 tests covering the delta formulas against their closed forms, rounding
direction, price monotonicity under quote-in/base-in, `sqrtFromPrice` ⇄
`priceFromSqrt` round-trips across five orders of magnitude, single-segment
totals, all three validator error paths, preset validity, and the raise/float
coupling.

## Migration reserve — the failure mode nobody sees

Graduation seeds the DAMM v2 pool with base tokens computed by the program
(`getMigrationBaseToken`: concentrated-liquidity math over
`[MIN_SQRT_PRICE, migrationPrice]`, not a simple quote/price division), drawn
from the pool's **unsold base vault**. A trading curve that ends exactly at the
migration price sells every base token on the way up and arrives at graduation
with an empty base side — the migrated pool opens broken, silently, on-chain.

`dbc-forge` therefore:

- sizes a reserve tail into every preset so the vault holds exactly the
  required migration base (`validate` reports `MIGRATION_RESERVE_SHORTFALL`
  when a hand-built config does not), and
- previews the whole hand-off offline: `dbc-forge migrate-preview --preset rwa`
  prints threshold, migration fee split, quote/base seeds, post-migration
  surplus and the LP split.

## Deploy (devnet or mainnet)

```bash
export KEYPAIR_PATH=~/keys/devnet.json     # generated by you, never committed
export RPC_URL=https://api.devnet.solana.com
dbc-forge deploy --preset meme             # builds, signs with KEYPAIR_PATH, sends
dbc-forge deploy --preset meme --dry-run   # no keypair, no RPC: prints params + addresses
```

`deploy` maps `emit` output onto the official
`@meteora-ag/dynamic-bonding-curve-sdk` (`createConfigAndPool`), confirms it,
and writes `deploy-record.json` (addresses, signature, curve) — public
evidence for a submission, no key material. Configs quoted in 6-decimal tokens
need a matching `--quote-mint`; SOL-quoted presets deploy against wrapped SOL
by default.

## Live pool-state feed

```bash
dbc-forge feed --pool <addr>                 # compact line every 5s
dbc-forge feed --pool <addr> --once          # single JSON snapshot
dbc-forge feed --pool <addr> --port 8787     # GET / (json), /events (SSE), /dashboard
```

Price, reserves, quote raised vs threshold, on-chain and computed graduation
progress, migration flag. The SSE endpoint is the plug-and-play story for
trading terminals: one `EventSource`, no polling.

## Roadmap

- [x] `deploy` — devnet deployment via the `@meteora-ag/dynamic-bonding-curve-sdk`
- [x] live pool-state feed (supply, price, progress-to-graduation) for trading terminals
- [x] DAMM v2 migration preview: liquidity split and post-graduation pool parameters
- [ ] DLMM hand-off for conviction-pool style flows
- [ ] fee-schedule simulation (`FeeSchedulerLinear` / `Exponential`, market-cap vs time)

## Scope

Simulation, validation and deployment tooling. Offline commands
(`simulate`, `validate`, `emit`, `migrate-preview`) touch no network and no
keys; `deploy` signs only with the keypair at `KEYPAIR_PATH`, and `--dry-run`
needs neither. Fees, the migration step into DAMM v2, and partner/referral
splits are modelled only insofar as they affect the curve; they are not
reproduced exactly.

## License

MIT
