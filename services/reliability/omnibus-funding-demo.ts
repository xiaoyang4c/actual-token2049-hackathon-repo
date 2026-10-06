/** Offline paper deposit -> pool -> deal flow. No keys or network requests. */

import {AgentStore} from '../../packages/db/src/index';
import {
  FIXTURE_ENTITIES, FIXTURE_TRANSACTIONS,
} from '../../packages/reliability/src/index';
import {PaperOmnibusFunding} from './omnibus-funding';

const store = AgentStore.open();
const at = '2026-10-06T12:00:00.000Z';
try {
  for (const entity of FIXTURE_ENTITIES) store.insertEntity(entity);
  const funding = new PaperOmnibusFunding(store);
  const transfers = [];
  for (const businessId of ['entity-established', 'entity-new']) {
    store.insertTransaction({
      ...FIXTURE_TRANSACTIONS[1]!,
      id: `demo-deal-${businessId}`,
      completedAt: undefined,
      participants: [
        {entityId: businessId, role: 'buyer'},
        {entityId: 'entity-farm-a', role: 'seller'},
      ],
    });
    funding.recordDeposit({
      idempotencyKey: `demo-deposit-${businessId}`, businessId,
      sourceAddress: `paper:business:${businessId}`,
      depositTxHash: `paper:deposit:${businessId}`, outputIndex: 0,
      amountLovelace: 10_000_000, at,
    });
    transfers.push(await funding.fund({
      idempotencyKey: `demo-fund-${businessId}`, businessId,
      transactionId: `demo-deal-${businessId}`, amountLovelace: 3_000_000, at,
    }));
  }
  console.log(JSON.stringify({
    simulated: true, mode: 'paper', transfers,
    internalBalances: {
      established: funding.balance('entity-established'),
      new: funding.balance('entity-new'),
    },
  }, null, 2));
} finally {
  store.close();
}
