/**
 * @fileoverview Fee and terms policy seam for the math lane.
 *
 * Contract for a mathematically strong reader with no other context.
 *
 * Intended policy (NOT implemented here): decide maps the lower bound
 * LB of one entity in one category to commercial terms, all as
 * functions of LB:
 * - Platform fee in basis points on BOTH the buyer and the seller
 *   side. Higher LB means a lower fee on each side. Record both.
 * - Deposit d = d_max * (1 - LB). Premium p = k * (1 - LB).
 * - Verification frequency f = max(p_min, p0 * (1 - LB)).
 * - Payment days t = t_min + (t_max - t_min) * LB.
 * - Limit = exposure cap from the scoring model.
 * - A material change means a move above 10 percent in a term or a
 *   tier crossing. Every decision records entity, category, inputs,
 *   resulting terms, reason code, and policy version. New entities get
 *   limited initial trust and stricter controls.
 *
 * TODO(math-lane): implement the policy above in this file. Keep the
 * file separate from scoring.ts and keep the interface shape: decide,
 * version. This stub uses simple linear placeholders.
 */

import type {
  JsonValue, ReliabilityCategory, ScoreView, TermsDecision, TermsOffer,
  TermsReasonCode,
} from './types';

export const STUB_FEE_TERMS_VERSION = 'fee-terms-stub-v0';

const MAX_BUYER_FEE_BPS = 300;
const MIN_BUYER_FEE_BPS = 25;
const MAX_SELLER_FEE_BPS = 250;
const MIN_SELLER_FEE_BPS = 20;
const MAX_DEPOSIT = 1000;
const MIN_PAYMENT_DAYS = 7;
const MAX_PAYMENT_DAYS = 60;
const BASE_VERIFICATION_FREQUENCY = 1;
const MIN_VERIFICATION_FREQUENCY = 0.05;
const STUB_EXPOSURE_SCALE = 10000;

/** Inputs to one fee and terms decision. */
export interface TermsPolicyInput {
  entityId: string;
  category: ReliabilityCategory;
  score: ScoreView;
  kycTier: string;
  repeatPairCount: number;
  inputs: {[key: string]: JsonValue};
  now: string;
}

/**
 * Fees and terms seam. Lane 2 owns the real fee curve and terms
 * functions. The stub lowers fees for higher lower bounds.
 */
export interface FeeTermsPolicy {
  readonly version: string;
  decide(input: TermsPolicyInput): TermsDecision;
}

/** Deterministic placeholder. Not the real fee curve. */
export class StubFeeTermsPolicy implements FeeTermsPolicy {
  readonly version = STUB_FEE_TERMS_VERSION;

  decide(input: TermsPolicyInput): TermsDecision {
    const bound = clamp01(input.score.lowerBound);
    const buyerFeeBps = Math.round(
      MAX_BUYER_FEE_BPS - bound * (MAX_BUYER_FEE_BPS - MIN_BUYER_FEE_BPS),
    );
    const sellerFeeBps = Math.round(
      MAX_SELLER_FEE_BPS - bound * (MAX_SELLER_FEE_BPS - MIN_SELLER_FEE_BPS),
    );
    const terms: TermsOffer = {
      deposit: Math.round(MAX_DEPOSIT * (1 - bound)),
      premium: Math.round(MAX_DEPOSIT * (1 - bound)),
      limit: Math.round(bound * STUB_EXPOSURE_SCALE),
      paymentDays: Math.round(
        MIN_PAYMENT_DAYS + (MAX_PAYMENT_DAYS - MIN_PAYMENT_DAYS) * bound,
      ),
      verificationFrequency: Math.max(
        MIN_VERIFICATION_FREQUENCY,
        BASE_VERIFICATION_FREQUENCY * (1 - bound),
      ),
    };
    return {
      entityId: input.entityId, category: input.category, inputs: input.inputs,
      terms, buyerFeeBps, sellerFeeBps, reasonCode: reasonFor(input, bound),
      policyVersion: this.version, decidedAt: input.now,
    };
  }
}

function reasonFor(
  input: TermsPolicyInput, bound: number,
): TermsReasonCode {
  if (input.score.eventCount === 0) return 'NEW_ENTITY';
  if (input.kycTier === 'none') return 'KYC_LIMIT';
  if (input.repeatPairCount > 5) return 'REPEAT_PAIR_DISCOUNT';
  if (input.score.confidence < 0.5) return 'LOW_CONFIDENCE';
  if (bound >= 0.7) return 'STRONG_HISTORY';
  if (bound < 0.4) return 'WEAK_HISTORY';
  return 'POLICY_DEFAULT';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) throw new Error('lowerBound must be finite');
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
