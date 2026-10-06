/**
 * @fileoverview Round trips for the reliability marketplace tables.
 */

import {describe, expect, test} from 'bun:test';
import {AgentStore} from '../src/index';
import {
  FIXTURE_ENTITIES,
  FIXTURE_STATES,
  FIXTURE_TRANSACTIONS,
  OUTCOME_INVOICE,
} from '../../reliability/src/index';
import {StubFeeTermsPolicy} from '../../reliability/src/fees-policy';
import {StubScoringPolicy} from '../../reliability/src/scoring';

describe('AgentStore reliability tables', () => {
  test('stores entities, transactions, outcomes, events, and states', () => {
    const store = AgentStore.open();
    try {
      for (const entity of FIXTURE_ENTITIES) {
        store.insertEntity(entity);
      }
      expect(store.listEntities().map((entity) => entity.id)).toEqual([
        'entity-established',
        'entity-farm-a',
        'entity-farm-b',
        'entity-new',
      ]);
      expect(
        store.getEntity('entity-established')?.wallets,
      ).toHaveLength(2);

      const stored = store.insertTransaction(FIXTURE_TRANSACTIONS[1]!);
      expect(stored.versions).toHaveLength(2);
      expect(stored.termsHash).toMatch(/^[a-f0-9]{64}$/);
      expect(
        store.listTransactions().map((transaction) => transaction.id),
      ).toEqual(['tx-invoice-1']);

      const outcome = store.saveOutcome(OUTCOME_INVOICE);
      expect(outcome.state).toBe('successful');
      expect(store.getOutcome('tx-invoice-1')?.state).toBe('successful');

      store.insertReliabilityEvent({
        id: 'tx-invoice-1:entity-established:buyer',
        transactionId: 'tx-invoice-1',
        entityId: 'entity-established',
        category: 'payment',
        role: 'buyer',
        outcome: 'success',
        evidence: {},
        verificationMethod: 'payment-settlement',
        value: 1200,
        createdAt: '2026-10-02T00:00:00.000Z',
      });
      expect(
        store.listReliabilityEventsForTransaction('tx-invoice-1'),
      ).toHaveLength(1);
      expect(
        store.listReliabilityEventsForState(
          'entity-established', 'payment', 'buyer',
        ),
      ).toHaveLength(1);

      const scoring = new StubScoringPolicy();
      const state = scoring.initialState(
        'entity-established', 'payment', 'buyer', '2026-10-02T00:00:00.000Z',
      );
      const saved = store.saveReliabilityState(state);
      expect(saved.alpha).toBe(1);
      expect(
        store.getReliabilityState(
          'entity-established', 'payment', 'buyer',
        )?.beta,
      ).toBe(1);
      expect(store.listReliabilityStates()).toHaveLength(1);

      const fees = new StubFeeTermsPolicy();
      const view = scoring.scoreView(saved);
      const decision = fees.decide({
        entityId: 'entity-established',
        category: 'payment',
        score: view,
        kycTier: 'enhanced',
        repeatPairCount: 0,
        inputs: {},
        now: '2026-10-02T00:00:00.000Z',
      });
      const decisionId = store.insertTermsDecision(decision);
      expect(decisionId).toBeGreaterThan(0);
      const listed = store.listTermsDecisions('entity-established', 'payment');
      expect(listed).toHaveLength(1);
      expect(listed[0]?.buyerFeeBps).toBeGreaterThan(0);
      expect(listed[0]?.sellerFeeBps).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  test('keeps the seeded fixture states separate per role', () => {
    const store = AgentStore.open();
    try {
      for (const entity of FIXTURE_ENTITIES) {
        store.insertEntity(entity);
      }
      for (const state of FIXTURE_STATES) {
        store.saveReliabilityState(state);
      }
      const buyer = store.getReliabilityState(
        'entity-farm-b', 'delivery', 'buyer',
      );
      const seller = store.getReliabilityState(
        'entity-farm-a', 'delivery', 'seller',
      );
      expect(buyer?.eventCount).toBe(12);
      expect(seller?.eventCount).toBe(12);
      expect(
        store.getReliabilityState('entity-new', 'fulfillment', 'buyer')
          ?.eventCount,
      ).toBe(0);
    } finally {
      store.close();
    }
  });
});
