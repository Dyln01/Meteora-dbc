/**
 * Wallet utilities so the deploy flow needs NO Solana CLI:
 *
 *   dbc-forge keygen   --out <path>     same JSON format solana-keygen writes
 *   dbc-forge airdrop  [--sol 2]        devnet faucet via web3.js
 *
 * The keypair file is the standard Uint8Array-as-JSON format; anything that
 * reads solana-keygen files (including KEYPAIR_PATH in deploy) reads these.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

/**
 * Generate a keypair and write it in solana-keygen JSON format.
 * Refuses to overwrite. Returns the public key (base58).
 */
export function generateKeypairFile(path: string): string {
  if (existsSync(path)) {
    throw new Error(`refusing to overwrite existing file: ${path}`);
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp.publicKey.toBase58();
}

/** Read a solana-keygen-format JSON file into a Keypair. */
export function loadKeypairFile(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** Request a devnet airdrop and wait for confirmation. Returns the signature. */
export async function requestAirdrop(
  rpcUrl: string,
  keypairPath: string,
  sol: number,
): Promise<{ signature: string; pubkey: string; balanceSol: number }> {
  const connection = new Connection(rpcUrl, 'confirmed');
  const kp = loadKeypairFile(keypairPath);
  const signature = await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
    'confirmed',
  );
  const balance = await connection.getBalance(kp.publicKey);
  return { signature, pubkey: kp.publicKey.toBase58(), balanceSol: balance / LAMPORTS_PER_SOL };
}
