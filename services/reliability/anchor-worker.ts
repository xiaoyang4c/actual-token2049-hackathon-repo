/**
 * @fileoverview Runs the settlement anchors. Read anchors.ts for the rules.
 *
 *   bun run anchors:wallet     create the anchor key if it is missing; print the address
 *   bun run anchors:status     entries, batches, and the wallet balance
 *   bun run anchors:worker     record fingerprints; with ANCHOR_SUBMIT=on, also post them
 *   bun run anchors:worker --once
 *
 * Secrets in TALLY_SECRETS_DIR (default ~/tally-secrets): anchor_wallet_skey
 * and blockfrost_preprod. Without either, the worker records fingerprints only.
 */

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AgentStore} from '../../packages/db/src/index';
import {anchorAddress, BlockfrostAnchorChain, generateAnchorKey} from './anchor-chain';
import {AnchorWorker} from './anchors';

const KEY_FILE = 'anchor_wallet_skey';

function secret(directory: string, name: string): string|null {
  const path = join(directory, name);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
}

async function main(): Promise<void> {
  const env = process.env;
  const secretsDir = env.TALLY_SECRETS_DIR ?? join(homedir(), 'tally-secrets');
  const command = process.argv[2] ?? 'worker';
  const log = (line: {[key: string]: unknown}) => console.log(JSON.stringify({at: new Date().toISOString(), ...line}));

  if (command === 'wallet') {
    let key = secret(secretsDir, KEY_FILE);
    if (!key) {
      key = generateAnchorKey();
      // 'wx' never overwrites a key that appeared in the meantime.
      writeFileSync(join(secretsDir, KEY_FILE), `${key}\n`, {mode: 0o600, flag: 'wx'});
      console.log('created a new anchor key');
    }
    console.log(`anchor wallet (Cardano preprod): ${anchorAddress(key)}`);
    console.log('Fund it with a few test ADA from https://dispenser.masumi.network. Each batch costs about 0.2 test ADA.');
    return;
  }

  const databasePath = env.CONTROL_DB_PATH;
  if (!databasePath) throw new Error('set CONTROL_DB_PATH to the control API database');
  const key = secret(secretsDir, KEY_FILE);
  const blockfrost = secret(secretsDir, 'blockfrost_preprod');
  const chain = key && blockfrost ? new BlockfrostAnchorChain(blockfrost, key) : null;
  const store = AgentStore.open(databasePath);
  try {
    if (command === 'status') {
      const counts = store.anchorCounts();
      const utxos = chain ? await chain.utxos() : [];
      const balance = utxos.reduce((sum, utxo) => sum + BigInt(utxo.lovelace), 0n);
      console.log(JSON.stringify({
        ...counts, wallet: chain?.address ?? null, walletAda: chain ? Number(balance) / 1_000_000 : null,
        submit: env.ANCHOR_SUBMIT === 'on', ready: chain !== null,
      }, null, 2));
      return;
    }
    if (command !== 'worker') throw new Error(`unknown command ${command}: use wallet, status, or worker`);
    const submit = env.ANCHOR_SUBMIT === 'on';
    const worker = new AnchorWorker({store, chain, submit, now: () => Date.now(), log});
    log({event: 'anchor_worker_started', submit, chain: chain ? 'preprod' : 'none (fingerprints only)', wallet: chain?.address ?? null});
    const stop = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
    const intervalMs = Number(env.ANCHOR_POLL_MS ?? 60_000);
    do {
      try {
        await worker.runOnce();
      } catch (error) {
        log({event: 'anchor_pass_failed', error: (error as Error).message});
      }
      if (process.argv.includes('--once')) break;
      try {
        await delay(intervalMs, undefined, {signal: stop.signal});
      } catch {
        break;
      }
    } while (!stop.signal.aborted);
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(JSON.stringify({event: 'anchor_worker_stopped', error: (error as Error).message}));
    process.exit(1);
  });
}
