/**
 * @fileoverview Seed helper. Writes the reliability fixtures into an
 * AgentStore. Lane D extends the fixtures. Other lanes add their own
 * seed files instead of editing this one.
 */

import type {AgentStore} from '../../packages/db/src/index';
import {
  FIXTURE_ENTITIES,
  FIXTURE_OUTCOMES,
  FIXTURE_STATES,
  FIXTURE_TRANSACTIONS,
  outcomeToEvents,
} from '../../packages/reliability/src/index';

/** Writes entities, transactions, outcomes, events, and states. */
export function seedReliabilityStore(store: AgentStore): void {
  store.transaction(() => {
    for (const entity of FIXTURE_ENTITIES) {
      if (!store.getEntity(entity.id)) store.insertEntity(entity);
    }
    for (const transaction of FIXTURE_TRANSACTIONS) {
      if (!store.getTransaction(transaction.id)) {
        store.insertTransaction(transaction);
      }
    }
    for (const outcome of FIXTURE_OUTCOMES) {
      store.saveOutcome(outcome);
      const transaction = FIXTURE_TRANSACTIONS.find(
        (entry) => entry.id === outcome.transactionId,
      );
      if (!transaction) continue;
      for (const event of outcomeToEvents(transaction, outcome)) {
        const existing = store
          .listReliabilityEventsForTransaction(event.transactionId)
          .some((entry) => entry.id === event.id);
        if (!existing) store.insertReliabilityEvent(event);
      }
    }
    for (const state of FIXTURE_STATES) {
      store.saveReliabilityState(state);
    }
  });
}
