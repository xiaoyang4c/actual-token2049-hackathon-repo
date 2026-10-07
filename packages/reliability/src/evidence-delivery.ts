/**
 * @fileoverview B2C delivery and service acceptance checks against the
 * agreed terms (lane D).
 *
 * Goods use `terms.delivery`. Services use `terms.service`. Both blocks are
 * optional. Goods delivery evidence and service acceptance evidence stay
 * separate: carrier proof never accepts a service.
 *
 * - `deliverBy` / `completeBy`: delivery after this time is late. Late
 *   delivery passes only with the buyer's own confirmation. The check
 *   records `onTime` in the evidence.
 * - `minimumTier`: the weakest delivery tier that the terms accept.
 * - `carriers`: the carriers that the terms accept for carrier proof.
 * - `deliverableSha256`: the delivered file hash must match.
 * - `acceptanceBy: 'buyer'` (services): only the buyer's confirmation
 *   accepts the service. Silent release does not.
 */

import type {MarketplaceTransaction} from './types';

export const DELIVERY_TERMS_CHECK_VERSION = 'delivery-terms-check-v1';

type Scalar = string|number|boolean|null;

/** Strength of each delivery tier. */
const TIER_RANK: Readonly<Record<string, number>> = {
  self_report: 0,
  silent_release: 1,
  buyer_confirmation: 2,
  carrier_proof: 3,
};

export interface DeliveryTermsViolation {
  code: 'late_delivery'|'tier_below_terms'|'carrier_not_accepted'|'deliverable_mismatch'|
    'goods_evidence_for_service'|'buyer_acceptance_required';
  message: string;
}

export interface DeliveryTermsCheck {
  passed: boolean;
  violations: DeliveryTermsViolation[];
  /** Scalars to add to the delivery evidence. */
  evidence: {[key: string]: Scalar};
}

function record(value: unknown): {[key: string]: unknown}|undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ?
    value as {[key: string]: unknown} : undefined;
}

function text(value: unknown): string|undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Checks delivery or acceptance evidence against the transaction terms.
 * `at` is the time of the delivery transition.
 */
export function checkDeliveryAgainstTerms(
  transaction: MarketplaceTransaction,
  evidence: {[key: string]: Scalar},
  at: string,
): DeliveryTermsCheck {
  const violations: DeliveryTermsViolation[] = [];
  const tier = text(evidence.deliveryTier);
  const isService = transaction.type === 'service';
  const terms = record(isService ? transaction.terms.service : transaction.terms.delivery);
  if (transaction.type === 'invoice') return {passed: true, violations, evidence: {}};
  if (isService && tier === 'carrier_proof') {
    violations.push({
      code: 'goods_evidence_for_service',
      message: 'carrier proof is goods delivery evidence; a service needs acceptance evidence',
    });
  }
  const deadline = text(terms?.[isService ? 'completeBy' : 'deliverBy']);
  const deliveredAt = text(evidence.deliveredAt) ?? at;
  let onTime: boolean|null = null;
  if (deadline && !Number.isNaN(Date.parse(deadline))) {
    onTime = Date.parse(deliveredAt) <= Date.parse(deadline);
    if (!onTime && tier !== 'buyer_confirmation') {
      violations.push({
        code: 'late_delivery',
        message: `delivery at ${deliveredAt} is after the agreed ${deadline}; only the buyer can accept it`,
      });
    }
  }
  const minimum = text(terms?.minimumTier);
  if (minimum && tier && (TIER_RANK[tier] ?? 0) < (TIER_RANK[minimum] ?? 0)) {
    violations.push({code: 'tier_below_terms', message: `the terms need ${minimum} evidence; got ${tier}`});
  }
  const carriers = terms?.carriers;
  if (tier === 'carrier_proof' && Array.isArray(carriers) && carriers.length > 0 &&
      !carriers.includes(evidence.carrier)) {
    violations.push({code: 'carrier_not_accepted', message: `carrier ${String(evidence.carrier)} is not in the agreed list`});
  }
  const expectedHash = text(terms?.deliverableSha256);
  if (expectedHash && evidence.deliverableSha256 !== expectedHash) {
    violations.push({code: 'deliverable_mismatch', message: 'the delivered file hash does not match the agreed hash'});
  }
  if (isService && terms?.acceptanceBy === 'buyer' && tier !== 'buyer_confirmation') {
    violations.push({code: 'buyer_acceptance_required', message: 'the terms need the buyer to accept the service'});
  }
  // Sales without delivery or service terms keep their evidence unchanged.
  const additions: {[key: string]: Scalar} = terms ? {
    termsCheck: DELIVERY_TERMS_CHECK_VERSION, onTime,
    ...(text(evidence.deliveredAt) ? {} : {deliveredAt}),
  } : {};
  return {passed: violations.length === 0, violations, evidence: additions};
}
