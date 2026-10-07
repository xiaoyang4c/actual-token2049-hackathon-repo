/**
 * @fileoverview Runs the live deposit watcher. Read deposit-watcher.ts for
 * the attribution rules and docs/wallets.md for the setup.
 *
 *   bun run deposits:status     deposits by status
 *   bun run deposits:worker     read the deposit address and credit deposits
 *   bun run deposits:worker --once
 *
 * Settings: CONTROL_DB_PATH, TALLY_DEPOSIT_ADDRESS, TALLY_DEPOSIT_CONFIRMATIONS,
 * and the Blockfrost preprod key (BLOCKFROST_PROJECT_ID, or blockfrost_preprod
 * in TALLY_SECRETS_DIR). The worker reads the chain only. It signs nothing.
 */

import {setTimeout as delay} from 'node:timers/promises';
import {AgentStore} from '../../packages/db/src/index';
import {depositSettingsFromEnv} from './deposit-chain';
import {DepositWatcher} from './deposit-watcher';

async function main(): Promise<void> {
  const env = process.env;
  const command = process.argv[2] ?? 'worker';
  const log = (line: {[key: string]: unknown}) => console.log(JSON.stringify({at: new Date().toISOString(), ...line}));
  const databasePath = env.CONTROL_DB_PATH;
  if (!databasePath) throw new Error('set CONTROL_DB_PATH to the control API database');
  const settings = depositSettingsFromEnv(env);
  const store = AgentStore.open(databasePath);
  try {
    if (command === 'status') {
      const rows = store.listLiveDeposits({limit: 1000});
      const byStatus: {[status: string]: number} = {};
      for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      console.log(JSON.stringify({depositAddress: settings.depositAddress, chain: settings.chain ? 'preprod' : null, confirmations: settings.confirmations, outputs: byStatus}, null, 2));
      return;
    }
    if (command !== 'worker') throw new Error(`unknown command ${command}: use status or worker`);
    if (!settings.chain || !settings.depositAddress) {
      throw new Error('set TALLY_DEPOSIT_ADDRESS and the Blockfrost preprod key to watch deposits');
    }
    const watcher = new DepositWatcher({
      store, chain: settings.chain, depositAddress: settings.depositAddress, confirmations: settings.confirmations, now: () => Date.now(), log,
    });
    log({event: 'deposit_worker_started', depositAddress: settings.depositAddress, confirmations: settings.confirmations});
    const stop = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
    const intervalMs = Number(env.DEPOSIT_POLL_MS ?? 20_000);
    do {
      try {
        await watcher.runOnce();
      } catch (error) {
        log({event: 'deposit_pass_failed', error: (error as Error).message});
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
    console.error(JSON.stringify({event: 'deposit_worker_stopped', error: (error as Error).message}));
    process.exit(1);
  });
}
