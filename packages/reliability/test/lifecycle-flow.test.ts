/**
 * @fileoverview Persists a lifecycle outcome and runs it through event-flow.
 */

import {describe, expect, test} from 'bun:test';
import {AgentStore} from '../../db/src/index';
import type {Entity} from '../src/types';
import type {EscrowPort, EscrowSession} from '../src/escrow-port';
import {StubFeeTermsPolicy} from '../src/fees-policy';
import {
  EscrowTransactionLifecycle,
  flowLifecycleOutcome,
} from '../src/index';
import {StubPairDecay} from '../src/pair-decay';
import {StubScoringPolicy} from '../src/scoring';

const OPEN = '2026-10-06T00:00:00.000Z';
const AMEND_AT = '2026-10-06T01:00:00.000Z';
const WINDOW = '2026-10-13T00:00:00.000Z';
const HASH = 'cd'.repeat(32);

function party(id: string): Entity {
  return {
    id,
    displayName: id,
    wallets: [],
    kycStatus: 'verified',
    kycTier: 'basic',
    roles: ['buyer', 'seller'],
    createdAt: OPEN,
  };
}

function paperEscrow(): EscrowPort {
  return {
    simulated: true,
    async fund(request) {
      const session: EscrowSession = {
        simulated: true,
        mode: 'paper',
        blockchainIdentifier: `simulated:${request.transactionId}`,
        txHash: 'ab'.repeat(32),
        escrowAddress: 'addr_test1_simulated_escrow',
        amountLovelace: request.amountLovelace,
        onChainState: 'FundsLocked',
        inputHash: request.inputHash,
        agentIdentifier: 'simulated-reliability-agent',
        purchaserId: request.purchaserId,
        identifierFromPurchaser: request.transactionId,
        sellerVkey: 'simulated-seller-vkey',
        paymentSourceType: 'Web3CardanoV1',
        payByTime: request.payByTime,
        submitResultTime: request.submitResultTime,
        unlockTime: request.unlockTime,
        externalDisputeUnlockTime: request.externalDisputeUnlockTime,
        sellerReturnAddress: request.sellerReturnAddress,
      };
      return session;
    },
    async release(session, resultHash) {
      return {
        simulated: true,
        mode: 'paper',
        action: 'submit_result',
        resultHash,
        blockchainIdentifier: session.blockchainIdentifier,
      };
    },
    async refund(session) {
      return {
        simulated: true,
        mode: 'paper',
        action: 'request_refund',
        blockchainIdentifier: session.blockchainIdentifier,
      };
    },
  };
}

describe('lifecycle event flow', () => {
  test('stores the outcome and refreshes stub terms', async () => {
    const store = AgentStore.open();
    try {
      store.insertEntity(party('buyer-1'));
      store.insertEntity(party('seller-1'));
      const life = new EscrowTransactionLifecycle({
        store, escrow: paperEscrow(),
      });
      life.open({
        id: 'tx-flow',
        type: 'goods',
        buyerId: 'buyer-1',
        sellerId: 'seller-1',
        terms: {goods: 'cable', quantity: 1},
        termsHash: HASH,
        value: 50,
        at: OPEN,
      });
      life.amendTerms(
        'tx-flow',
        {goods: 'cable', quantity: 2},
        'quantity amendment',
        AMEND_AT,
      );
      await life.fund({
        transactionId: 'tx-flow',
        amountLovelace: 50_000_000,
        sellerReturnAddress: 'addr_test1_seller',
        disputeWindowEnds: WINDOW,
        at: AMEND_AT,
      });
      life.confirmDelivery({
        transactionId: 'tx-flow',
        at: AMEND_AT,
        evidence: {deliveryTier: 'buyer_confirmation', confirmedBy: 'buyer-1'},
      });
      await life.release({transactionId: 'tx-flow', at: AMEND_AT});

      const outcome = life.outcomeFor('tx-flow', {now: AMEND_AT});
      expect(outcome.state).toBe('successful');
      expect(outcome.verificationMethod).toBe('lifecycle');
      expect(outcome.verificationConfidence).toBe(0.7);
      expect(store.getOutcome('tx-flow')?.state).toBe('successful');
      expect(store.getTransaction('tx-flow')?.completedAt).toBe(AMEND_AT);
      expect(store.getTransaction('tx-flow')?.termsHash).toBeUndefined();
      expect(store.getTransaction('tx-flow')?.versions[0]?.terms).toEqual({
        goods: 'cable', quantity: 1,
      });
      expect(store.getTransaction('tx-flow')?.versions[1]?.terms).toEqual({
        goods: 'cable', quantity: 2,
      });
      expect(store.listLifecycleTransitions('tx-flow')).toHaveLength(4);

      const scoring = new StubScoringPolicy();
      const entities = new Map(
        [party('buyer-1'), party('seller-1')].map((entity) => [entity.id, entity]),
      );
      const transaction = life.getTransaction('tx-flow');
      const flowed = flowLifecycleOutcome(
        transaction, outcome, scoring, new StubPairDecay(),
        new StubFeeTermsPolicy(), AMEND_AT, entities,
      );
      expect(flowed.events).toHaveLength(2);
      expect(flowed.events.map((event) => event.role)).toEqual(['buyer', 'seller']);
      expect(flowed.events[0]?.category).toBe('delivery');
      expect(flowed.events[0]?.outcome).toBe('success');
      expect(flowed.events[0]?.verificationConfidence).toBe(0.7);
      expect(flowed.events[0]?.verificationMethod).toBe('lifecycle');
      expect(flowed.states).toHaveLength(2);
      expect(flowed.decisions).toHaveLength(2);
      expect(flowed.decisions.every(
        (decision) => decision.policyVersion === 'fee-terms-stub-v0',
      )).toBe(true);
      expect(flowed.decisions.every(
        (decision) => decision.reasonCode === 'LOW_CONFIDENCE',
      )).toBe(true);
      for (const event of flowed.events) store.insertReliabilityEvent(event);
      for (const state of flowed.states) store.saveReliabilityState(state);
      for (const decision of flowed.decisions) store.insertTermsDecision(decision);
      expect(store.listReliabilityEventsForTransaction('tx-flow')).toHaveLength(2);
      expect(store.listTermsDecisions('buyer-1', 'delivery')).toHaveLength(1);
      expect(store.getReliabilityState('seller-1', 'delivery', 'seller')?.eventCount)
        .toBe(1);

      const reloaded = new EscrowTransactionLifecycle({store});
      expect(reloaded.currentStage('tx-flow')).toBe('payment_settled');
      expect(reloaded.getTransaction('tx-flow').versions).toHaveLength(2);
      expect(reloaded.outcomeFor('tx-flow', {now: AMEND_AT}).state).toBe('successful');
      expect(reloaded.listTransitions('tx-flow')[1]?.evidence.mode).toBe('paper');
    } finally {
      store.close();
    }
  });
});
