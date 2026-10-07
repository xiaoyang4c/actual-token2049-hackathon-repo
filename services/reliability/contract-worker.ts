/**
 * @fileoverview Contract lifecycle worker. It runs the scheduler on the
 * control store so escrow writes, chain status, deadlines, and reliability
 * publishing move without HTTP traffic. Live contracts need it.
 *
 *   bun run contracts:worker
 *
 * Run one worker per store. Leases stop a second worker from sending the
 * same escrow write, but one worker is the tested setup.
 */

import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AgentStore} from '../../packages/db/src/index';
import {ContractService} from './contract-service';

// Same default as the control API (services/agent-runtime.ts).
const databasePath = process.env.CONTROL_DB_PATH ?? fileURLToPath(new URL('../.data/agent.sqlite', import.meta.url));
mkdirSync(dirname(databasePath), {recursive: true});
const store = AgentStore.open(databasePath);
const service = new ContractService(store);
const label = service.mode === 'live' ? 'LIVE preprod' : 'paper';
console.log(`[contract-worker] ${label} mode, custody ${service.config.settings.custodyModel}, every ${service.config.workerIntervalMs} ms`);

let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});

while (!stopping) {
  try {
    const result = await service.tick();
    if (result.published > 0) console.log(`[contract-worker] published ${result.published} reliability update(s)`);
  } catch (error) {
    // Never print request bodies or credentials. The message is enough to act on.
    console.error(`[contract-worker] tick failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, service.config.workerIntervalMs));
}
store.close();
