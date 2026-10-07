/**
 * @fileoverview Rebuilds every reliability score under the current policies.
 * Run it after a scoring, pair-decay, or fee policy change:
 *
 *   bun run scores:rebuild
 *
 * It recomputes every event weight and pair position in event order,
 * rebuilds each state from its stored baseline or the prior, and records a
 * terms decision for each rebuilt state. It reads CONTROL_DB_PATH like the
 * control API. It makes no network calls.
 */

import {fileURLToPath} from 'node:url';
import {AgentStore} from '../../packages/db/src/index';
import {DEFAULT_RELIABILITY_POLICIES} from './policies';
import {withRecordedWeights} from './score-ledger';

const databasePath = process.env.CONTROL_DB_PATH ??
  fileURLToPath(new URL('../.data/agent.sqlite', import.meta.url));
const store = AgentStore.open(databasePath);
try {
  const policies = withRecordedWeights(store, DEFAULT_RELIABILITY_POLICIES);
  const rebuilt = policies.ledger.rebuildAll(new Date().toISOString());
  console.log(JSON.stringify({
    databasePath,
    scoringVersion: policies.scoring.version,
    decayVersion: policies.decay.version,
    feeVersion: policies.fees.version,
    rebuiltStates: rebuilt.length,
  }, null, 2));
} finally {
  store.close();
}
