/**
 * Live pool-state feed for trading terminals and builders.
 *
 * Reads a DBC virtual pool + its config and publishes the numbers a terminal
 * actually needs: current price, reserves, quote raised vs the graduation
 * threshold, and migration status. Three modes:
 *
 *   --once          single JSON snapshot (scripting, CI, docs)
 *   default         compact line per interval (watching from a shell)
 *   --port <n>      HTTP: GET / (json), GET /events (SSE), GET /dashboard
 *
 * The SSE endpoint is the "plug-and-play" story from the track brief: a
 * terminal subscribes with one EventSource and never polls.
 */

import { createServer } from 'node:http';
import BN from 'bn.js';
import {
  DynamicBondingCurveClient,
  getPriceFromSqrtPrice,
  type PoolConfig,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

export interface PoolSnapshot {
  pool: string;
  at: string;
  slot: number | null;
  priceHuman: number;
  sqrtPrice: string;
  baseReserve: string;
  quoteReserve: string;
  /** Quote held by the pool; approaches migrationQuoteThreshold at graduation. */
  raisedQuote: string;
  migrationQuoteThreshold: string;
  /** raisedQuote / threshold, capped at 100. */
  progressComputedPct: number;
  /** Program-reported migration progress (u8 percent). */
  progressOnchainPct: number;
  isMigrated: boolean;
  baseDecimals: number;
  quoteDecimals: number;
}

export interface PoolStateLike {
  sqrtPrice: { toString(): string };
  baseReserve: { toString(): string };
  quoteReserve: { toString(): string };
  migrationProgress: unknown;
  isMigrated: unknown;
}

/** The SDK decodes the virtual pool with its fields under `poolState`. */
export function unwrapPoolState(pool: unknown): PoolStateLike {
  const p = pool as any;
  return (p?.poolState ?? p) as PoolStateLike;
}

/**
 * Pure mapping from on-chain state to a snapshot — isolated so it can be
 * tested without an RPC and reused by every output mode.
 */
export function snapshotFromPool(
  pool: PoolStateLike,
  config: Pick<PoolConfig, 'migrationQuoteThreshold'>,
  opts: { pool: string; baseDecimals: number; quoteDecimals: number; slot?: number | null },
): PoolSnapshot {
  const threshold = new BN(config.migrationQuoteThreshold.toString());
  const raised = new BN(pool.quoteReserve.toString());
  const computed = threshold.isZero()
    ? 0
    : Math.min(100, (raised.toNumber() / threshold.toNumber()) * 100);
  const priceHuman = getPriceFromSqrtPrice(
    new BN(pool.sqrtPrice.toString()),
    opts.baseDecimals as any,
    opts.quoteDecimals,
  ).toNumber();
  return {
    pool: opts.pool,
    at: new Date().toISOString(),
    slot: opts.slot ?? null,
    priceHuman,
    sqrtPrice: pool.sqrtPrice.toString(),
    baseReserve: pool.baseReserve.toString(),
    quoteReserve: pool.quoteReserve.toString(),
    raisedQuote: pool.quoteReserve.toString(),
    migrationQuoteThreshold: threshold.toString(),
    progressComputedPct: Number(computed.toFixed(4)),
    progressOnchainPct: Number(pool.migrationProgress as any),
    isMigrated: Boolean(pool.isMigrated as any),
    baseDecimals: opts.baseDecimals,
    quoteDecimals: opts.quoteDecimals,
  };
}

export interface FeedHandle {
  snapshot(): Promise<PoolSnapshot>;
  close(): void;
}

/** Build a live feed handle against an RPC. */
export async function openFeed(
  rpcUrl: string,
  poolAddress: string,
  decimals: { baseDecimals: number; quoteDecimals: number },
): Promise<FeedHandle> {
  const connection = new (await import('@solana/web3.js')).Connection(rpcUrl, 'confirmed');
  const client = DynamicBondingCurveClient.create(connection, 'confirmed');
  const snapshot = async (): Promise<PoolSnapshot> => {
    const poolRaw = await client.state.getPool(poolAddress);
    if (!poolRaw) throw new Error(`no DBC pool at ${poolAddress}`);
    const state = unwrapPoolState(poolRaw);
    const configAddress = (poolRaw as any).poolState?.config ?? (poolRaw as any).config;
    const config = await client.state.getPoolConfig(configAddress);
    if (!config) throw new Error(`no pool config for pool ${poolAddress}`);
    const slot = await connection.getSlot('confirmed').catch(() => null);
    return snapshotFromPool(state, config, {
      pool: poolAddress,
      baseDecimals: decimals.baseDecimals,
      quoteDecimals: decimals.quoteDecimals,
      slot,
    });
  };
  return { snapshot, close: () => undefined };
}

const DASHBOARD = (pool: string) => `<!doctype html><meta charset=utf-8><title>dbc-forge feed</title>
<style>body{font:14px/1.5 ui-monospace,monospace;margin:2rem auto;max-width:46rem;color:#111}
h1{font-size:1.1rem}td:first-child{color:#666;padding-right:1rem}#bar{height:8px;background:#eee}
#fill{height:8px;background:#6c4df6;width:0%}</style>
<h1>dbc-forge live feed</h1><p>pool <code id=pc>…</code></p>
<table id=t></table><div id=bar><div id=fill></div></div><p id=err></p>
<script>
const es=new EventSource('/events');
es.onmessage=e=>{const s=JSON.parse(e.data);pc.textContent=s.pool;
 t.innerHTML=[['price',s.priceHuman],['raised quote',s.raisedQuote],['threshold',s.migrationQuoteThreshold],
 ['base reserve',s.baseReserve],['on-chain progress',s.progressOnchainPct+'%'],
 ['computed progress',s.progressComputedPct+'%'],['migrated',s.isMigrated],['slot',s.slot]]
 .map(r=>'<tr><td>'+r[0]+'</td><td>'+r[1]+'</td></tr>').join('');
 fill.style.width=s.progressComputedPct+'%';};
es.onerror=()=>err.textContent='feed disconnected — retrying';
</script>`;

/** HTTP front-end: JSON snapshot, SSE stream, self-contained dashboard. */
export function serveFeed(handle: FeedHandle, port: number, intervalMs: number): Promise<void> {
  const subscribers = new Set<(s: PoolSnapshot) => void>();
  const push = async () => {
    try {
      const s = await handle.snapshot();
      for (const cb of subscribers) cb(s);
    } catch {
      /* a missed poll is not fatal; subscribers keep their connection */
    }
  };
  const timer = setInterval(push, intervalMs);
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': connected\n\n');
      const cb = (s: PoolSnapshot) => res.write(`data: ${JSON.stringify(s)}\n\n`);
      subscribers.add(cb);
      req.on('close', () => subscribers.delete(cb));
      return;
    }
    if (url === '/dashboard') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD(''));
      return;
    }
    handle
      .snapshot()
      .then((s) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(s, null, 2));
      })
      .catch((e) => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      });
  });
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`feed listening on :${port}  (/, /events, /dashboard)`);
      void push();
      const stop = () => {
        clearInterval(timer);
        server.close();
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  });
}

export function formatLine(s: PoolSnapshot): string {
  const bar = '█'.repeat(Math.round(s.progressComputedPct / 5)).padEnd(20, '░');
  return `${s.at.slice(11, 19)}  price ${s.priceHuman.toExponential(4)}  raised ${s.raisedQuote} / ${s.migrationQuoteThreshold}  [${bar}] ${s.progressComputedPct.toFixed(2)}%${s.isMigrated ? '  MIGRATED' : ''}`;
}
