/**
 * @fileoverview Pins the fee and terms seam shape for lane 2.
 */

import {describe, expect, test} from 'bun:test';
import {
  CurveFeeTermsPolicy, DEFAULT_CURVE_FEE_TERMS_PARAMS, StubFeeTermsPolicy, feeBpsFor,
} from '../src/fees-policy';

const NOW = '2026-10-06T00:00:00.000Z';

function score(lowerBound: number, eventCount: number) {
  return {
    entityId: 'e1', category: 'compute' as const, role: 'seller' as const,
    value: lowerBound, lowerBound, confidence: 0.8, eventCount,
  };
}

describe('StubFeeTermsPolicy', () => {
  test('charges a lower fee on both sides for a higher lower bound', () => {
    const policy = new StubFeeTermsPolicy();
    const weak = policy.decide({
      entityId: 'e1', category: 'compute', score: score(0.2, 10),
      kycTier: 'basic', repeatPairCount: 0, inputs: {}, now: NOW,
    });
    const strong = policy.decide({
      entityId: 'e1', category: 'compute', score: score(0.9, 40),
      kycTier: 'basic', repeatPairCount: 0, inputs: {}, now: NOW,
    });
    expect(strong.buyerFeeBps).toBeLessThan(weak.buyerFeeBps);
    expect(strong.sellerFeeBps).toBeLessThan(weak.sellerFeeBps);
    expect(strong.terms.deposit).toBeLessThan(weak.terms.deposit);
    expect(strong.terms.paymentDays).toBeGreaterThan(weak.terms.paymentDays);
  });

  test('records a reason code and policy version', () => {
    const policy = new StubFeeTermsPolicy();
    const decided = policy.decide({
      entityId: 'entity-new', category: 'compute', score: score(0.1, 0),
      kycTier: 'none', repeatPairCount: 0, inputs: {}, now: NOW,
    });
    expect(decided.reasonCode).toBe('NEW_ENTITY');
    expect(decided.policyVersion).toBe(policy.version);
    expect(decided.decidedAt).toBe(NOW);
  });
});

describe('CurveFeeTermsPolicy', () => {
  const policy = new CurveFeeTermsPolicy();
  const params = DEFAULT_CURVE_FEE_TERMS_PARAMS;

  function decide(lowerBound: number, eventCount: number, kycTier = 'enhanced') {
    return policy.decide({
      entityId: 'e1', category: 'delivery', score: {...score(lowerBound, eventCount), confidence: 0.5},
      kycTier, repeatPairCount: 0, inputs: {}, now: NOW,
    });
  }

  test('charges the ceiling at L = 0 and the floor at L = 1 on each side', () => {
    expect(feeBpsFor(params.buyer, 0)).toBe(params.buyer.maxBps);
    expect(feeBpsFor(params.buyer, 1)).toBe(params.buyer.minBps);
    expect(feeBpsFor(params.seller, 0)).toBe(params.seller.maxBps);
    expect(feeBpsFor(params.seller, 1)).toBe(params.seller.minBps);
    // Linear at eta = 1: halfway between floor and ceiling.
    expect(feeBpsFor({minBps: 20, maxBps: 220, power: 1}, 0.5)).toBe(120);
    expect(feeBpsFor({minBps: 20, maxBps: 220, power: 2}, 0.5)).toBe(70);
  });

  test('maps the bound to deposit, premium, payment days, and verification', () => {
    const decision = decide(0.6, 12);
    expect(decision.terms.deposit).toBe(400);
    expect(decision.terms.premium).toBe(200);
    expect(decision.terms.paymentDays).toBe(Math.round(7 + 53 * 0.6));
    expect(decision.terms.verificationFrequency).toBeCloseTo(0.4, 12);
    expect(decision.policyVersion).toBe('fee-terms-curve-v1');
    expect(decision.inputs).toMatchObject({lowerBound: 0.6, kycTier: 'enhanced'});
  });

  test('caps exposure at min(E_max L^gamma, E_KYC)', () => {
    expect(decide(0.5, 10, 'enhanced').terms.limit).toBe(50000);
    const capped = decide(0.5, 10, 'basic');
    expect(capped.terms.limit).toBe(params.kycCaps.basic);
    expect(capped.reasonCode).toBe('KYC_LIMIT');
    const unverified = decide(0.9, 30, 'none');
    expect(unverified.terms.limit).toBe(0);
    expect(unverified.reasonCode).toBe('KYC_LIMIT');
  });

  test('records reason codes for new, strong, and weak histories', () => {
    expect(decide(0.05, 0).reasonCode).toBe('NEW_ENTITY');
    expect(decide(0.8, 40).reasonCode).toBe('STRONG_HISTORY');
    expect(decide(0.3, 40).reasonCode).toBe('WEAK_HISTORY');
  });

  test('rejects invalid bounds and a non-zero cap for tier none', () => {
    expect(() => new CurveFeeTermsPolicy({...params, buyer: {minBps: 50, maxBps: 10, power: 1}})).toThrow();
    expect(() => new CurveFeeTermsPolicy({...params, seller: {minBps: 0, maxBps: 20000, power: 1}})).toThrow();
    expect(() => new CurveFeeTermsPolicy({...params, kycCaps: {...params.kycCaps, none: 5}})).toThrow();
  });
});
