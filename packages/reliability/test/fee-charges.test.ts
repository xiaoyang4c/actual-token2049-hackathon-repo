/**
 * @fileoverview Accepted platform fee charges for both participants.
 */

import {describe, expect, test} from 'bun:test';
import {
  basisPointsOf, quoteFeeCharge, settleFeeCharge, toMinorUnits,
} from '../src/fee-charges';
import type {ScoreView, TermsDecision} from '../src/types';

const NOW = '2026-10-07T00:00:00.000Z';

function party(entityId: string, role: 'buyer'|'seller', lowerBound: number, fees: [number, number]) {
  const score: ScoreView = {
    entityId, category: 'delivery', role, value: 0.5, lowerBound, confidence: 0, eventCount: 0,
  };
  const decision: TermsDecision = {
    entityId, category: 'delivery', inputs: {},
    terms: {deposit: 0, premium: 0, limit: 0, paymentDays: 7, verificationFrequency: 1},
    buyerFeeBps: fees[0], sellerFeeBps: fees[1], reasonCode: 'POLICY_DEFAULT',
    policyVersion: 'fee-terms-curve-v1', decidedAt: NOW,
  };
  return {entityId, score, decision};
}

describe('fee charges', () => {
  test('converts major amounts to minor units, half up', () => {
    expect(toMinorUnits(50, 2)).toBe(5000n);
    expect(toMinorUnits(0.125, 2)).toBe(13n);
    expect(toMinorUnits(12.3456789, 6)).toBe(12345679n);
    expect(toMinorUnits(2.5, 0)).toBe(3n);
    expect(() => toMinorUnits(-1, 2)).toThrow();
  });

  test('takes basis points with half-up rounding', () => {
    expect(basisPointsOf(5000n, 285)).toBe(143n);
    expect(basisPointsOf(3n, 5000)).toBe(2n);
    expect(() => basisPointsOf(100n, 10001)).toThrow();
  });

  test('charges the buyer from its buyer bound and the seller from its seller bound', () => {
    const charge = quoteFeeCharge({
      transactionId: 'tx', category: 'delivery', currency: 'USD', decimals: 2,
      principalMinor: 100000n,
      // Each party's decision holds both rates. Only its own side applies.
      buyer: party('b', 'buyer', 0.2, [250, 999]),
      seller: party('s', 'seller', 0.8, [999, 60]),
      at: NOW,
    });
    expect(charge.buyer).toMatchObject({entityId: 'b', feeBps: 250, feeMinor: '2500', lowerBound: 0.2});
    expect(charge.seller).toMatchObject({entityId: 's', feeBps: 60, feeMinor: '600', lowerBound: 0.8});
    expect(charge.buyerTotalMinor).toBe('102500');
    expect(charge.sellerNetMinor).toBe('99400');
    expect(charge.status).toBe('accepted');
  });

  test('collects on success, waives on failure, and refunds after a correction', () => {
    const charge = quoteFeeCharge({
      transactionId: 'tx', category: 'delivery', currency: 'USD', decimals: 2, principalMinor: 1000n,
      buyer: party('b', 'buyer', 0.5, [100, 100]), seller: party('s', 'seller', 0.5, [100, 100]), at: NOW,
    });
    expect(settleFeeCharge(charge, 'pending', NOW, 'test')).toBe(charge);
    expect(settleFeeCharge(charge, 'disputed', NOW, 'test')).toBe(charge);
    const collected = settleFeeCharge(charge, 'successful', NOW, 'test');
    expect(collected).toMatchObject({status: 'collected', settledAt: NOW, settledBy: 'test'});
    expect(settleFeeCharge(charge, 'failed', NOW, 'test').status).toBe('waived');
    expect(settleFeeCharge(charge, 'cancelled', NOW, 'test').status).toBe('waived');
    expect(settleFeeCharge(collected, 'failed', NOW, 'test').status).toBe('refunded');
    expect(settleFeeCharge(collected, 'successful', NOW, 'test')).toBe(collected);
  });
});
