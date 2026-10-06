/**
 * @fileoverview State machine coverage for the paper escrow lifecycle.
 */

import {describe, expect, test} from 'bun:test';
import type {
  EscrowFundRequest, EscrowPort, EscrowRefundResult, EscrowReleaseResult,
  EscrowSession,
} from '../src/escrow-port';
import {flowLifecycleOutcome} from '../src/lifecycle-flow';
import {StubFeeTermsPolicy} from '../src/fees-policy';
import {StubPairDecay} from '../src/pair-decay';
import {
  DELIVERY_TIER_VERIFICATION,
  EscrowTransactionLifecycle,
  LifecycleError,
  RESOLVER_CONFIDENCE,
  VOLUNTARY_REFUND_CONFIDENCE,
  type LifecycleTransition,
} from '../src/lifecycle';
import {StubScoringPolicy} from '../src/scoring';
import type {Outcome} from '../src/types';

const OPEN = '2026-10-06T00:00:00.000Z';
const AMEND_AT = '2026-10-06T01:00:00.000Z';
const WINDOW = '2026-10-13T00:00:00.000Z';
const BEFORE_WINDOW = '2026-10-12T23:59:59.999Z';
const AFTER_WINDOW = '2026-10-13T00:00:00.001Z';

class FakeEscrow implements EscrowPort {
  readonly simulated = true;
  readonly calls: string[] = [];

  async fund(request: EscrowFundRequest): Promise<EscrowSession> {
    this.calls.push('fund');
    return {
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
  }

  async release(
    session: EscrowSession, resultHash: string,
  ): Promise<EscrowReleaseResult> {
    this.calls.push('release');
    return {
      simulated: true,
      mode: 'paper',
      action: 'submit_result',
      resultHash,
      blockchainIdentifier: session.blockchainIdentifier,
    };
  }

  async refund(session: EscrowSession): Promise<EscrowRefundResult> {
    this.calls.push('refund');
    return {
      simulated: true,
      mode: 'paper',
      action: 'request_refund',
      blockchainIdentifier: session.blockchainIdentifier,
    };
  }
}

function lifecycle(): {life: EscrowTransactionLifecycle; escrow: FakeEscrow} {
  const escrow = new FakeEscrow();
  return {life: new EscrowTransactionLifecycle({escrow}), escrow};
}

function openSale(
  life: EscrowTransactionLifecycle, id = 'tx-1',
): void {
  const terms = {goods: 'cable', quantity: 1};
  life.open({
    id,
    type: 'goods',
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    terms,
    value: 50,
    at: OPEN,
  });
  terms.quantity = 9;
}

async function fundSale(
  life: EscrowTransactionLifecycle, id = 'tx-1',
): Promise<LifecycleTransition> {
  return life.fund({
    transactionId: id,
    amountLovelace: 50_000_000,
    sellerReturnAddress: 'addr_test1_seller',
    disputeWindowEnds: WINDOW,
    at: OPEN,
  });
}

function expectPending(outcome: Outcome): void {
  expect(outcome.state).toBe('pending');
  expect(outcome.state).not.toBe('successful');
}

function eventsFor(life: EscrowTransactionLifecycle, id: string, now: string) {
  return flowLifecycleOutcome(
    life.getTransaction(id),
    life.outcomeFor(id, {now}),
    new StubScoringPolicy(),
    new StubPairDecay(),
    new StubFeeTermsPolicy(),
    now,
  ).events;
}

describe('delivery evidence tiers', () => {
  test('keeps the tiers ordered and leaves self-report unverified', () => {
    expect(DELIVERY_TIER_VERIFICATION.carrier_proof).toEqual({
      method: 'lifecycle', confidence: 0.95,
    });
    expect(DELIVERY_TIER_VERIFICATION.buyer_confirmation).toEqual({
      method: 'lifecycle', confidence: 0.7,
    });
    expect(DELIVERY_TIER_VERIFICATION.silent_release).toEqual({
      method: 'lifecycle', confidence: 0.4,
    });
    expect(DELIVERY_TIER_VERIFICATION.self_report).toEqual({
      method: 'unverified', confidence: 0.1,
    });
    expect(DELIVERY_TIER_VERIFICATION.carrier_proof.confidence).toBeGreaterThan(
      DELIVERY_TIER_VERIFICATION.buyer_confirmation.confidence,
    );
    expect(DELIVERY_TIER_VERIFICATION.buyer_confirmation.confidence).toBeGreaterThan(
      DELIVERY_TIER_VERIFICATION.silent_release.confidence,
    );
    expect(DELIVERY_TIER_VERIFICATION.silent_release.confidence).toBeGreaterThan(
      DELIVERY_TIER_VERIFICATION.self_report.confidence,
    );
  });

  test('settles carrier proof as a strong lifecycle outcome', async () => {
    const {life, escrow} = lifecycle();
    openSale(life);
    expectPending(life.outcomeFor('tx-1', {now: OPEN}));
    const funded = await fundSale(life);
    expect(funded.evidence.mode).toBe('paper');
    expect(funded.evidence.simulated).toBe(true);
    expect(funded.evidence.blockchainIdentifier).toBe('simulated:tx-1');
    expectPending(life.outcomeFor('tx-1', {now: OPEN}));
    life.confirmDelivery({
      transactionId: 'tx-1',
      at: OPEN,
      evidence: {
        deliveryTier: 'carrier_proof', carrier: 'DHL', proofRef: '1Z999',
      },
    });
    const delivered = life.outcomeFor('tx-1', {now: OPEN});
    expectPending(delivered);
    expect(delivered.verificationMethod).toBe('lifecycle');
    expect(delivered.verificationConfidence).toBe(0.95);
    await life.release({transactionId: 'tx-1', at: OPEN});
    const outcome = life.outcomeFor('tx-1', {now: OPEN});
    expect(outcome.state).toBe('successful');
    expect(outcome.verificationMethod).toBe('lifecycle');
    expect(outcome.verificationConfidence).toBe(0.95);
    expect(outcome.evidence.mode).toBe('paper');
    expect(escrow.calls).toEqual(['fund', 'release']);
    expect(life.currentStage('tx-1')).toBe('payment_settled');
  });

  test('settles buyer confirmation at confidence 0.7', async () => {
    const {life} = lifecycle();
    openSale(life);
    await fundSale(life);
    life.confirmDelivery({
      transactionId: 'tx-1',
      at: OPEN,
      evidence: {deliveryTier: 'buyer_confirmation', confirmedBy: 'buyer-1'},
    });
    await life.release({transactionId: 'tx-1', at: OPEN});
    const outcome = life.outcomeFor('tx-1', {now: OPEN});
    expect(outcome.state).toBe('successful');
    expect(outcome.verificationMethod).toBe('lifecycle');
    expect(outcome.verificationConfidence).toBe(0.7);
    expect(eventsFor(life, 'tx-1', OPEN)).toHaveLength(2);
  });

  test('settles silent release after the dispute window', async () => {
    const {life, escrow} = lifecycle();
    openSale(life);
    await fundSale(life);
    await expect(life.release({
      transactionId: 'tx-1',
      at: BEFORE_WINDOW,
      evidence: {deliveryTier: 'silent_release', complaint: false},
    })).rejects.toThrow('silent release waits until the dispute window ends');
    await expect(life.release({
      transactionId: 'tx-1',
      at: WINDOW,
      evidence: {deliveryTier: 'silent_release', complaint: true},
    })).rejects.toThrow('a complaint blocks silent release; open a dispute');
    await life.release({
      transactionId: 'tx-1',
      at: WINDOW,
      evidence: {deliveryTier: 'silent_release'},
    });
    const outcome = life.outcomeFor('tx-1', {now: WINDOW});
    expect(outcome.state).toBe('successful');
    expect(outcome.verificationMethod).toBe('lifecycle');
    expect(outcome.verificationConfidence).toBe(0.4);
    expect(life.listTransitions('tx-1').map((item) => item.to)).toEqual([
      'offer_accepted', 'escrow_funded', 'delivery_confirmed', 'payment_settled',
    ]);
    expect(escrow.calls).toEqual(['fund', 'release']);
  });

  test('keeps a self-report pending and refuses settlement', async () => {
    const {life, escrow} = lifecycle();
    openSale(life);
    await fundSale(life);
    life.confirmDelivery({
      transactionId: 'tx-1',
      at: OPEN,
      evidence: {
        deliveryTier: 'self_report',
        carrier: 'DHL',
        proofRef: '1Z999',
        note: 'seller says it shipped',
      },
    });
    const outcome = life.outcomeFor('tx-1', {now: OPEN});
    expectPending(outcome);
    expect(outcome.verificationMethod).toBe('unverified');
    expect(outcome.verificationConfidence).toBe(0.1);
    expect(eventsFor(life, 'tx-1', OPEN)).toEqual([]);
    await expect(life.release({transactionId: 'tx-1', at: OPEN})).rejects.toThrow(
      'a self-reported delivery cannot settle',
    );
    expect(escrow.calls).toEqual(['fund']);
    expect(life.currentStage('tx-1')).toBe('delivery_confirmed');
  });
});

describe('dispute, refund, and cancel', () => {
  test('names a resolver and does not treat the dispute as failure', async () => {
    const {life} = lifecycle();
    openSale(life);
    await fundSale(life);
    expect(() => life.openDispute({
      transactionId: 'tx-1', resolver: ' ', resolveBy: WINDOW, at: OPEN,
    })).toThrow('a dispute names a resolver and a deadline');
    expect(() => life.outcomeFor('tx-1', {now: OPEN})).not.toThrow();
    life.openDispute({
      transactionId: 'tx-1',
      resolver: 'marketplace-arbiter',
      resolveBy: WINDOW,
      at: OPEN,
      reason: 'item missing',
    });
    const open = life.outcomeFor('tx-1', {now: OPEN});
    expect(open.state).toBe('disputed');
    expect(open.state).not.toBe('failed');
    expect(open.state).not.toBe('successful');
    expect(open.resolver).toBe('marketplace-arbiter');
    expect(open.resolveBy).toBe(WINDOW);
    expect(eventsFor(life, 'tx-1', OPEN)).toEqual([]);
    const atDeadline = life.outcomeFor('tx-1', {now: WINDOW});
    expect(atDeadline.state).toBe('disputed');
  });

  test('upholds the seller and the buyer, including the deadline instant', async () => {
    const seller = lifecycle();
    openSale(seller.life, 'tx-seller');
    await fundSale(seller.life, 'tx-seller');
    seller.life.openDispute({
      transactionId: 'tx-seller',
      resolver: 'marketplace-arbiter',
      resolveBy: WINDOW,
      at: OPEN,
    });
    await seller.life.resolveDispute({
      transactionId: 'tx-seller',
      resolver: 'marketplace-arbiter',
      decision: 'uphold_seller',
      at: WINDOW,
    });
    const released = seller.life.outcomeFor('tx-seller', {now: WINDOW});
    expect(released.state).toBe('successful');
    expect(released.verificationMethod).toBe('manual-review');
    expect(released.verificationConfidence).toBe(RESOLVER_CONFIDENCE);
    expect(released.evidence.resolution).toBe('uphold_seller');
    expect(seller.escrow.calls).toEqual(['fund', 'release']);

    const buyer = lifecycle();
    openSale(buyer.life, 'tx-buyer');
    await fundSale(buyer.life, 'tx-buyer');
    buyer.life.openDispute({
      transactionId: 'tx-buyer',
      resolver: 'marketplace-arbiter',
      resolveBy: WINDOW,
      at: OPEN,
    });
    await buyer.life.resolveDispute({
      transactionId: 'tx-buyer',
      resolver: 'marketplace-arbiter',
      decision: 'uphold_buyer',
      at: WINDOW,
    });
    const refunded = buyer.life.outcomeFor('tx-buyer', {now: WINDOW});
    expect(refunded.state).toBe('failed');
    expect(refunded.verificationMethod).toBe('manual-review');
    expect(refunded.verificationConfidence).toBe(RESOLVER_CONFIDENCE);
    expect(refunded.evidence.fault).toBe('seller');
    expect(buyer.life.currentStage('tx-buyer')).toBe('refunded');
    const events = eventsFor(buyer.life, 'tx-buyer', WINDOW);
    expect(events.map((event) => event.outcome)).toEqual(['failure', 'failure']);
    expect(buyer.escrow.calls).toEqual(['fund', 'refund']);
  });

  test('holds escrow when the resolver misses the deadline', async () => {
    const {life, escrow} = lifecycle();
    openSale(life);
    await fundSale(life);
    life.openDispute({
      transactionId: 'tx-1',
      resolver: 'marketplace-arbiter',
      resolveBy: WINDOW,
      at: OPEN,
    });
    const outcome = life.outcomeFor('tx-1', {now: AFTER_WINDOW});
    expect(outcome.state).toBe('unresolved');
    expect(outcome.verificationMethod).toBe('lifecycle');
    expect(outcome.verificationConfidence).toBe(1);
    expect(outcome.resolver).toBe('marketplace-arbiter');
    expect(outcome.resolveBy).toBe(WINDOW);
    expect(outcome.evidence.timeoutResult).toBe('unresolved');
    expect(outcome.evidence.escrowDisposition).toBe('held');
    expect(life.currentStage('tx-1')).toBe('dispute_opened');
    expect(eventsFor(life, 'tx-1', AFTER_WINDOW)).toEqual([]);
    await expect(life.resolveDispute({
      transactionId: 'tx-1',
      resolver: 'marketplace-arbiter',
      decision: 'uphold_seller',
      at: AFTER_WINDOW,
    })).rejects.toThrow(
      'the dispute deadline has passed; the result is unresolved',
    );
    expect(escrow.calls).toEqual(['fund']);
    expect(() => life.amendTerms(
      'tx-1', {goods: 'cable', quantity: 2}, 'late change', AFTER_WINDOW,
    )).toThrow('terms are frozen after an unresolved dispute');
  });

  test('refunds a funded escrow without a fault finding', async () => {
    const {life, escrow} = lifecycle();
    openSale(life);
    await fundSale(life);
    await life.refund({
      transactionId: 'tx-1', at: OPEN, reason: 'buyer withdrew',
    });
    const outcome = life.outcomeFor('tx-1', {now: OPEN});
    expect(life.currentStage('tx-1')).toBe('refunded');
    expect(outcome.state).toBe('cancelled');
    expect(outcome.verificationMethod).toBe('lifecycle');
    expect(outcome.verificationConfidence).toBe(VOLUNTARY_REFUND_CONFIDENCE);
    expect(outcome.evidence.refunded).toBe(true);
    expect(outcome.evidence.fault).toBe('none');
    expect(outcome.evidence.mode).toBe('paper');
    expect(eventsFor(life, 'tx-1', OPEN)).toEqual([]);
    expect(escrow.calls).toEqual(['fund', 'refund']);
  });

  test('cancels an accepted offer before funding', () => {
    const {life, escrow} = lifecycle();
    openSale(life);
    life.cancel({transactionId: 'tx-1', at: OPEN, reason: 'buyer withdrew'});
    const outcome = life.outcomeFor('tx-1', {now: OPEN});
    expect(life.currentStage('tx-1')).toBe('cancelled');
    expect(outcome.state).toBe('cancelled');
    expect(outcome.verificationConfidence).toBe(1);
    expect(eventsFor(life, 'tx-1', OPEN)).toEqual([]);
    expect(escrow.calls).toEqual([]);
    expect(() => life.amendTerms(
      'tx-1', {goods: 'cable', quantity: 2}, 'too late', AMEND_AT,
    )).toThrow('terms are frozen after cancelled');
  });
});

describe('terms and invalid transitions', () => {
  test('records terms at creation and appends amendments', () => {
    const {life} = lifecycle();
    openSale(life);
    const first = life.getTransaction('tx-1').versions[0];
    expect(first?.version).toBe(1);
    expect(first?.reason).toBe('initial terms');
    expect(first?.terms).toEqual({goods: 'cable', quantity: 1});
    life.amendTerms(
      'tx-1', {goods: 'cable', quantity: 2}, 'quantity amendment', AMEND_AT,
    );
    const versions = life.getTransaction('tx-1').versions;
    expect(versions[0]).toBe(first);
    expect(versions[1]?.terms).toEqual({goods: 'cable', quantity: 2});
    expect(life.getTransaction('tx-1').terms).toEqual({
      goods: 'cable', quantity: 2,
    });
    expect(() => life.amendTerms('tx-1', {goods: 'cable'}, ' ', AMEND_AT))
      .toThrow('reason must be a non-empty string');
  });

  test('rejects skipped stages, bad sources, and escrow bypass', async () => {
    const {life} = lifecycle();
    expect(() => life.advance({
      transactionId: 'tx-missing',
      from: undefined,
      to: 'escrow_funded',
      evidence: {},
      at: OPEN,
    })).toThrow('record transaction terms before offer_accepted');
    openSale(life);
    expect(() => life.advance({
      transactionId: 'tx-1',
      from: 'offer_accepted',
      to: 'payment_settled',
      evidence: {},
      at: OPEN,
    })).toThrow('cannot move from offer_accepted to payment_settled');
    expect(() => life.advance({
      transactionId: 'tx-1',
      from: undefined,
      to: 'cancelled',
      evidence: {reason: 'no'},
      at: OPEN,
    })).toThrow('transition source does not match the current stage');
    expect(() => life.advance({
      transactionId: 'tx-1',
      from: 'offer_accepted',
      to: 'escrow_funded',
      evidence: {mode: 'paper'},
      at: OPEN,
    })).toThrow(
      'escrow funding, release, and refund go through the Masumi escrow port',
    );
    await fundSale(life);
    expect(() => life.cancel({
      transactionId: 'tx-1', at: OPEN, reason: 'too late',
    })).toThrow('cannot move from escrow_funded to cancelled');
    expect(() => life.confirmDelivery({
      transactionId: 'tx-1',
      at: OPEN,
      evidence: {deliveryTier: 'buyer_confirmation', confirmedBy: 'seller-1'},
    })).toThrow('buyer confirmation must come from the buyer');
    expect(() => life.confirmDelivery({
      transactionId: 'tx-1',
      at: OPEN,
      evidence: {deliveryTier: 'carrier_proof', carrier: 'seller-1', proofRef: '1'},
    })).toThrow('a seller claim is not carrier proof');
    expect(() => life.confirmDelivery({
      transactionId: 'tx-1',
      at: OPEN,
      evidence: {deliveryTier: 'carrier_proof', carrier: 'DHL', proofRef: ''},
    })).toThrow('carrier proof needs a carrier and a proof reference');
    expect(() => life.confirmDelivery({
      transactionId: 'tx-1',
      at: OPEN,
      evidence: {deliveryTier: 'phone_photo'},
    })).toThrow('unknown delivery tier');
    expect(() => life.openDispute({
      transactionId: 'tx-1',
      resolver: 'other-person',
      resolveBy: WINDOW,
      at: OPEN,
    })).not.toThrow();
    expect(() => life.advance({
      transactionId: 'tx-1',
      from: 'dispute_opened',
      to: 'dispute_resolved',
      evidence: {resolver: 'someone-else', decision: 'uphold_seller'},
      at: OPEN,
    })).toThrow('the resolver does not match the named resolver');
    await expect(life.release({transactionId: 'tx-1', at: OPEN})).rejects.toThrow(
      'cannot release escrow from dispute_opened',
    );
  });

  test('rejects a live escrow port before it can broadcast', async () => {
    let called = false;
    const escrow: EscrowPort = {
      simulated: false,
      async fund() {
        called = true;
        throw new Error('broadcast');
      },
      async release() {
        throw new Error('broadcast');
      },
      async refund() {
        throw new Error('broadcast');
      },
    };
    const life = new EscrowTransactionLifecycle({escrow});
    openSale(life);
    await expect(fundSale(life)).rejects.toThrow(LifecycleError);
    await expect(fundSale(life)).rejects.toThrow(
      'escrow must stay simulated; live broadcast is disabled',
    );
    expect(called).toBe(false);
  });
});
