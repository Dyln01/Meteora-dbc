import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { generateKeypairFile, loadKeypairFile } from '../src/wallet.js';

test('keygen writes solana-keygen-compatible JSON and refuses overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-'));
  const path = join(dir, 'kp.json');
  const pubkey = generateKeypairFile(path);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  assert.equal(raw.length, 64);
  const kp = Keypair.fromSecretKey(Uint8Array.from(raw));
  assert.equal(kp.publicKey.toBase58(), pubkey);
  assert.equal(loadKeypairFile(path).publicKey.toBase58(), pubkey);
  assert.throws(() => generateKeypairFile(path), /refusing to overwrite/);
});
