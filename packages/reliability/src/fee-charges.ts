/**
 * @fileoverview Accepted platform fee charges for one sale (lane B).
 *
 * The buyer fee uses the buyer's buyer-role lower bound. The seller fee
 * uses the seller's seller-role lower bound. Both come from score
 * snapshots taken before the parties agree, so the sale never prices
 * itself from the event it later creates.
 *
 * Collection convention (proposal in docs/reliability-math.md): the buyer
 * pays principal plus the buyer fee, and the seller receives principal
 * minus the seller fee. Amounts are integer minor units, rounded half up.
 * Refund rule: the platform collects both fees only when the seller is
 * paid (a successful outcome). A failed or cancelled sale waives both. A
 * collected charge whose outcome is later corrected to failed or cancelled
 * is refunded.
 * Later score changes never rewrite an accepted charge.
 */

import type {ReliabilityCategory, ScoreView, TermsDecision} from './types';

export const FEE_CHARGE_VERSION = 'fee-charge-v1';

export type FeeChargeStatus = 'accepted'|'collected'|'waived'|'refunded';

/** One side of an accepted charge. Minor units are decimal strings. */
export interface FeeChargeSide {
  entityId: string;
  category: ReliabilityCategory;
  lowerBound: number;
  feeBps: number;
  feeMinor: string;
  termsPolicyVersion: string;
}

/** Accepted charges for both participants of one sale. */
export interface FeeCharge {
  transactionId: string;
  currency: string;
  /** Minor units per major unit, as a power of ten. */
  decimals: number;
  principalMinor: string;
  buyer: FeeChargeSide;
  seller: FeeChargeSide;
  buyerTotalMinor: string;
  sellerNetMinor: string;
  rounding: 'half_up';
  collection: 'buyer_adds_seller_deducts';
  refundRule: 'collect_on_success_waive_otherwise';
  version: string;
  status: FeeChargeStatus;
  acceptedAt: string;
  settledAt?: string;
  settledBy?: string;
}

/** Converts a non-negative major amount to minor units, half up. */
export function toMinorUnits(major: number, decimals: number): bigint {
  if (!Number.isFinite(major) || major < 0 || major >= 1e15) {
    throw new Error('amount must be finite, non-negative, and below 1e15');
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('decimals must be an integer from 0 to 18');
  }
  const [whole = '0', fraction = ''] = major.toFixed(Math.min(decimals + 1, 20)).split('.');
  const padded = (fraction + '0'.repeat(decimals + 1)).slice(0, decimals + 1);
  const scaled = BigInt(whole + padded.slice(0, decimals));
  const next = Number(padded.slice(decimals, decimals + 1) || '0');
  return next >= 5 ? scaled + 1n : scaled;
}

/** fee = amount * bps / 10000, rounded half up. */
export function basisPointsOf(amountMinor: bigint, bps: number): bigint {
  if (amountMinor < 0n) throw new Error('amount must be non-negative');
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new Error('bps must be an integer from 0 to 10000');
  return (amountMinor * BigInt(bps) + 5000n) / 10000n;
}

/** One party's inputs for a quote. */
export interface FeeQuoteParty {
  entityId: string;
  score: ScoreView;
  decision: TermsDecision;
}

/** Builds the accepted charge from both score snapshots. */
export function quoteFeeCharge(input: {
  transactionId: string;
  category: ReliabilityCategory;
  currency: string;
  decimals: number;
  principalMinor: bigint;
  buyer: FeeQuoteParty;
  seller: FeeQuoteParty;
  at: string;
}): FeeCharge {
  if (input.principalMinor < 0n) throw new Error('principal must be non-negative');
  const buyerFee = basisPointsOf(input.principalMinor, input.buyer.decision.buyerFeeBps);
  const sellerFee = basisPointsOf(input.principalMinor, input.seller.decision.sellerFeeBps);
  return {
    transactionId: input.transactionId,
    currency: input.currency,
    decimals: input.decimals,
    principalMinor: input.principalMinor.toString(),
    buyer: {
      entityId: input.buyer.entityId, category: input.category,
      lowerBound: input.buyer.score.lowerBound, feeBps: input.buyer.decision.buyerFeeBps,
      feeMinor: buyerFee.toString(), termsPolicyVersion: input.buyer.decision.policyVersion,
    },
    seller: {
      entityId: input.seller.entityId, category: input.category,
      lowerBound: input.seller.score.lowerBound, feeBps: input.seller.decision.sellerFeeBps,
      feeMinor: sellerFee.toString(), termsPolicyVersion: input.seller.decision.policyVersion,
    },
    buyerTotalMinor: (input.principalMinor + buyerFee).toString(),
    sellerNetMinor: (input.principalMinor - sellerFee).toString(),
    rounding: 'half_up',
    collection: 'buyer_adds_seller_deducts',
    refundRule: 'collect_on_success_waive_otherwise',
    version: FEE_CHARGE_VERSION,
    status: 'accepted',
    acceptedAt: input.at,
  };
}

/**
 * Applies a final outcome to a charge. From `accepted`, `successful`
 * collects both fees and `failed` or `cancelled` waives them. From
 * `collected`, a corrected `failed` or `cancelled` outcome refunds them.
 * Other states and other moves leave the charge unchanged.
 */
export function settleFeeCharge(
  charge: FeeCharge, outcomeState: string, at: string, settledBy: string,
): FeeCharge {
  const final = outcomeState === 'failed' || outcomeState === 'cancelled';
  if (charge.status === 'accepted' && outcomeState === 'successful') {
    return {...charge, status: 'collected', settledAt: at, settledBy};
  }
  if (charge.status === 'accepted' && final) return {...charge, status: 'waived', settledAt: at, settledBy};
  if (charge.status === 'collected' && final) return {...charge, status: 'refunded', settledAt: at, settledBy};
  return charge;
}
