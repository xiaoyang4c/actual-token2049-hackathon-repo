/**
 * @fileoverview Pins the fee and terms seam shape for lane 2.
 */

import {describe, expect, test} from 'bun:test';
import {StubFeeTermsPolicy} from '../src/fees-policy';

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
