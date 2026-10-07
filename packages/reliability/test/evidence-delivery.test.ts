/**
 * @fileoverview Goods delivery and service acceptance against agreed terms.
 */

import {describe, expect, test} from 'bun:test';
import {checkDeliveryAgainstTerms} from '../src/evidence-delivery';
import type {JsonValue, MarketplaceTransaction, TransactionType} from '../src/types';

const DEADLINE = '2026-10-10T00:00:00.000Z';
const EARLY = '2026-10-09T00:00:00.000Z';
const LATE = '2026-10-11T00:00:00.000Z';

function sale(type: TransactionType, terms: {[key: string]: JsonValue}): MarketplaceTransaction {
  return {
    id: 'tx', type, participants: [{entityId: 'b', role: 'buyer'}, {entityId: 's', role: 'seller'}],
    terms, versions: [], createdAt: '2026-10-01T00:00:00.000Z',
  };
}

function codes(transaction: MarketplaceTransaction, evidence: {[key: string]: string|number|boolean|null}, at: string) {
  return checkDeliveryAgainstTerms(transaction, evidence, at).violations.map((violation) => violation.code);
}

describe('delivery terms check', () => {
  const goods = sale('goods', {
    delivery: {deliverBy: DEADLINE, minimumTier: 'buyer_confirmation', carriers: ['DHL'], deliverableSha256: 'a'.repeat(64)},
  });
  const carrier = {deliveryTier: 'carrier_proof', carrier: 'DHL', proofRef: 'track-1', deliverableSha256: 'a'.repeat(64)};

  test('passes on-time goods evidence and records the check', () => {
    const check = checkDeliveryAgainstTerms(goods, carrier, EARLY);
    expect(check.passed).toBe(true);
    expect(check.evidence).toEqual({termsCheck: 'delivery-terms-check-v1', onTime: true, deliveredAt: EARLY});
  });

  test('accepts late goods only with the buyer confirmation', () => {
    expect(codes(goods, carrier, LATE)).toEqual(['late_delivery']);
    const confirmed = checkDeliveryAgainstTerms(
      goods, {deliveryTier: 'buyer_confirmation', confirmedBy: 'b', deliverableSha256: 'a'.repeat(64)}, LATE,
    );
    expect(confirmed.passed).toBe(true);
    expect(confirmed.evidence.onTime).toBe(false);
  });

  test('applies the minimum tier, the carrier list, and the deliverable hash', () => {
    expect(codes(goods, {deliveryTier: 'silent_release', deliverableSha256: 'a'.repeat(64)}, EARLY))
      .toEqual(['tier_below_terms']);
    expect(codes(goods, {...carrier, carrier: 'Acme'}, EARLY)).toEqual(['carrier_not_accepted']);
    expect(codes(goods, {...carrier, deliverableSha256: 'b'.repeat(64)}, EARLY)).toEqual(['deliverable_mismatch']);
  });

  test('keeps service acceptance separate from goods delivery evidence', () => {
    const service = sale('service', {service: {completeBy: DEADLINE, acceptanceBy: 'buyer'}});
    expect(codes(service, {deliveryTier: 'carrier_proof', carrier: 'DHL', proofRef: 'x'}, EARLY))
      .toEqual(['goods_evidence_for_service', 'buyer_acceptance_required']);
    expect(codes(service, {deliveryTier: 'silent_release'}, EARLY)).toEqual(['buyer_acceptance_required']);
    expect(codes(service, {deliveryTier: 'buyer_confirmation', confirmedBy: 'b'}, EARLY)).toEqual([]);
    // A service without terms still refuses carrier proof.
    expect(codes(sale('service', {}), {deliveryTier: 'carrier_proof', carrier: 'DHL', proofRef: 'x'}, EARLY))
      .toEqual(['goods_evidence_for_service']);
  });

  test('leaves evidence unchanged for sales without delivery terms', () => {
    const check = checkDeliveryAgainstTerms(sale('goods', {item: 'cable'}), carrier, LATE);
    expect(check).toEqual({passed: true, violations: [], evidence: {}});
  });
});
