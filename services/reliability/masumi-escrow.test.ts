/**
 * @fileoverview Proves escrow calls the simulated Masumi adapter.
 * The test also runs the outcome through the shared event flow.
 */

import {describe, expect, spyOn, test} from 'bun:test';
import {AgentStore} from '../../packages/db/src/index';
import {
  EscrowTransactionLifecycle,
  flowLifecycleOutcome,
} from '../../packages/reliability/src/index';
import {StubFeeTermsPolicy} from '../../packages/reliability/src/fees-policy';
import {StubPairDecay} from '../../packages/reliability/src/pair-decay';
import {StubScoringPolicy} from '../../packages/reliability/src/scoring';
import type {Entity} from '../../packages/reliability/src/types';
import {
  PreprodMasumiAdapter,
  SimulatedMasumiAdapter,
} from '../cardano-agents-ts/masumi';
import {createSimulatedMasumiEscrow} from './masumi-escrow';

const OPEN = '2026-10-06T00:00:00.000Z';
const WINDOW = '2026-10-13T00:00:00.000Z';

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

describe('simulated Masumi escrow', () => {
  test('funds, releases, and refunds without a network broadcast', async () => {
    const createPayment = spyOn(SimulatedMasumiAdapter.prototype, 'createPayment');
    const createPurchase = spyOn(SimulatedMasumiAdapter.prototype, 'createPurchase');
    const submitResult = spyOn(SimulatedMasumiAdapter.prototype, 'submitResult');
    const requestRefund = spyOn(SimulatedMasumiAdapter.prototype, 'requestRefund');
    const preprodPayment = spyOn(PreprodMasumiAdapter.prototype, 'createPayment');
    const fetched: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string|URL|Request) => {
      fetched.push(String(input));
      return new Response('blocked', {status: 500});
    }) as typeof fetch;
    const store = AgentStore.open();
    try {
      store.insertEntity(party('buyer-1'));
      store.insertEntity(party('seller-1'));
      const escrow = createSimulatedMasumiEscrow();
      expect(escrow.simulated).toBe(true);
      const life = new EscrowTransactionLifecycle({store, escrow});
      life.open({
        id: 'tx-masumi',
        type: 'service',
        buyerId: 'buyer-1',
        sellerId: 'seller-1',
        terms: {service: 'repair'},
        value: 80,
        at: OPEN,
      });
      const funded = await life.fund({
        transactionId: 'tx-masumi',
        amountLovelace: 80_000_000,
        sellerReturnAddress: 'addr_test1_seller',
        disputeWindowEnds: WINDOW,
        at: OPEN,
      });
      expect(funded.evidence.mode).toBe('paper');
      expect(funded.evidence.blockchainIdentifier).toBe('simulated:tx-masumi');
      expect(funded.evidence.txHash).toMatch(/^[a-f0-9]{64}$/);
      life.confirmDelivery({
        transactionId: 'tx-masumi',
        at: OPEN,
        evidence: {deliveryTier: 'buyer_confirmation', confirmedBy: 'buyer-1'},
      });
      await life.release({transactionId: 'tx-masumi', at: OPEN});
      const outcome = life.outcomeFor('tx-masumi', {now: OPEN});
      expect(outcome.state).toBe('successful');
      expect(outcome.verificationConfidence).toBe(0.7);
      const entities = new Map(
        [party('buyer-1'), party('seller-1')].map((entity) => [entity.id, entity]),
      );
      const flowed = flowLifecycleOutcome(
        life.getTransaction('tx-masumi'),
        outcome,
        new StubScoringPolicy(),
        new StubPairDecay(),
        new StubFeeTermsPolicy(),
        OPEN,
        entities,
      );
      expect(flowed.events).toHaveLength(2);
      expect(flowed.events[0]?.category).toBe('fulfillment');
      expect(flowed.decisions[0]?.policyVersion).toBe('fee-terms-stub-v0');
      expect(store.getOutcome('tx-masumi')?.evidence.mode).toBe('paper');

      const refundLife = new EscrowTransactionLifecycle({
        store, escrow: createSimulatedMasumiEscrow(),
      });
      refundLife.open({
        id: 'tx-refund',
        type: 'goods',
        buyerId: 'buyer-1',
        sellerId: 'seller-1',
        terms: {goods: 'cable'},
        at: OPEN,
      });
      await refundLife.fund({
        transactionId: 'tx-refund',
        amountLovelace: 10_000_000,
        sellerReturnAddress: 'addr_test1_seller',
        disputeWindowEnds: WINDOW,
        at: OPEN,
      });
      await refundLife.refund({transactionId: 'tx-refund', at: OPEN});
      expect(refundLife.outcomeFor('tx-refund', {now: OPEN}).state).toBe('cancelled');

      expect(createPayment).toHaveBeenCalled();
      expect(createPurchase).toHaveBeenCalled();
      expect(submitResult).toHaveBeenCalled();
      expect(requestRefund).toHaveBeenCalled();
      const paymentCall = createPayment.mock.calls[0];
      expect(paymentCall?.[1]).toBe(80_000_000);
      expect(paymentCall?.[0].network).toBe('Preprod');
      expect(paymentCall?.[0].identifierFromPurchaser).toBe('tx-masumi');
      expect(outcome.evidence.resultHash).toMatch(/^[a-f0-9]{64}$/);
      expect(preprodPayment).not.toHaveBeenCalled();
      expect(fetched).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      createPayment.mockRestore();
      createPurchase.mockRestore();
      submitResult.mockRestore();
      requestRefund.mockRestore();
      preprodPayment.mockRestore();
      store.close();
    }
  });
});
