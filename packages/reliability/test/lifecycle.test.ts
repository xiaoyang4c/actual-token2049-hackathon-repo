/**
 * @fileoverview Pins the generic lifecycle seam shape for lane A.
 */

import {describe, expect, test} from 'bun:test';
import {StubTransactionLifecycle} from '../src/lifecycle';

const NOW = '2026-10-06T00:00:00.000Z';

function fullSale(lifecycle: StubTransactionLifecycle, id: string): void {
  lifecycle.advance({
    transactionId: id, from: undefined, to: 'offer_accepted',
    evidence: {offer: 'accepted'}, at: NOW,
  });
  lifecycle.advance({
    transactionId: id, from: 'offer_accepted', to: 'escrow_funded',
    evidence: {escrowTx: 'simulated-escrow'}, at: NOW,
  });
  lifecycle.advance({
    transactionId: id, from: 'escrow_funded', to: 'delivery_confirmed',
    evidence: {delivery: 'confirmed'}, at: NOW,
  });
  lifecycle.advance({
    transactionId: id, from: 'delivery_confirmed', to: 'payment_settled',
    evidence: {settlement: 'confirmed'}, at: NOW,
  });
}

describe('StubTransactionLifecycle', () => {
  test('walks offer to escrow to delivery to settlement', () => {
    const lifecycle = new StubTransactionLifecycle();
    fullSale(lifecycle, 'tx-1');
    expect(lifecycle.currentStage('tx-1')).toBe('payment_settled');
    const outcome = lifecycle.outcomeFor('tx-1', {now: NOW});
    expect(outcome.state).toBe('successful');
    expect(outcome.verificationMethod).toBe('lifecycle');
  });

  test('rejects a skipped stage', () => {
    const lifecycle = new StubTransactionLifecycle();
    expect(() => lifecycle.advance({
      transactionId: 'tx-2', from: undefined, to: 'escrow_funded',
      evidence: {}, at: NOW,
    })).toThrow();
  });

  test('names a resolver and deadline for a dispute', () => {
    const lifecycle = new StubTransactionLifecycle();
    lifecycle.advance({
      transactionId: 'tx-3', from: undefined, to: 'offer_accepted',
      evidence: {}, at: NOW,
    });
    lifecycle.advance({
      transactionId: 'tx-3', from: 'offer_accepted', to: 'escrow_funded',
      evidence: {}, at: NOW,
    });
    lifecycle.advance({
      transactionId: 'tx-3', from: 'escrow_funded', to: 'dispute_opened',
      evidence: {}, at: NOW,
    });
    expect(() => lifecycle.outcomeFor('tx-3', {now: NOW})).toThrow();
    const outcome = lifecycle.outcomeFor('tx-3', {
      resolver: 'marketplace-arbiter', resolveBy: '2026-10-13T00:00:00.000Z',
      now: NOW,
    });
    expect(outcome.state).toBe('disputed');
    expect(outcome.resolver).toBe('marketplace-arbiter');
  });
});
