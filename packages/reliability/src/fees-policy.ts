/**
 * @fileoverview Fee and terms policy for the math lane (lane B).
 *
 * decide maps the lower bound L of one entity in one category to
 * commercial terms (docs/reliability-math.md):
 * - Platform fee in basis points on BOTH the buyer and the seller side:
 *   f(L) = f_min + (f_max - f_min) * (1 - L)^eta. Higher L gives a lower fee.
 *   The buyer fee applies to the buyer-role bound. The seller fee applies
 *   to the seller-role bound. fee-charges.ts snapshots both for one sale.
 * - Deposit d = d_max * (1 - L). Premium p = k * (1 - L).
 * - Verification probability u = max(u_min, u_0 * (1 - L)).
 * - Payment days t = t_min + (t_max - t_min) * L.
 * - Exposure limit E = min(E_max * L^gamma, E_KYC). KYC tier `none` has
 *   a zero cap, so an unverified entity gets no limit.
 * Every decision records entity, category, inputs, terms, reason code,
 * and policy version. The parameters are defaults. The product owner has
 * not selected fee bounds, term scales, or KYC caps.
 */

import type {
  JsonValue, KycTier, ReliabilityCategory, ScoreView, TermsDecision, TermsOffer,
  TermsReasonCode,
} from './types';

export const STUB_FEE_TERMS_VERSION = 'fee-terms-stub-v0';
export const CURVE_FEE_TERMS_VERSION = 'fee-terms-curve-v1';

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

/** One side of the fee curve, in basis points. */
export interface FeeCurveSide {
  readonly minBps: number;
  readonly maxBps: number;
  /** Curve power eta > 0. One is linear. */
  readonly power: number;
}

/** Parameters of the curve policy. Amounts use the accounting currency. */
export interface CurveFeeTermsParams {
  readonly version: string;
  readonly buyer: FeeCurveSide;
  readonly seller: FeeCurveSide;
  readonly maxDeposit: number;
  readonly premiumScale: number;
  readonly verification: {readonly min: number; readonly base: number};
  readonly paymentDays: {readonly min: number; readonly max: number};
  readonly exposure: {readonly max: number; readonly power: number};
  /** E_KYC for each tier. `none` must stay zero. */
  readonly kycCaps: Readonly<Record<KycTier, number>>;
  readonly thresholds: {
    readonly strong: number;
    readonly weak: number;
    readonly lowConfidence: number;
    readonly repeatPairs: number;
  };
}

/** Default parameters. Not a product decision. */
export const DEFAULT_CURVE_FEE_TERMS_PARAMS: CurveFeeTermsParams = {
  version: CURVE_FEE_TERMS_VERSION,
  buyer: {minBps: MIN_BUYER_FEE_BPS, maxBps: MAX_BUYER_FEE_BPS, power: 1},
  seller: {minBps: MIN_SELLER_FEE_BPS, maxBps: MAX_SELLER_FEE_BPS, power: 1},
  maxDeposit: MAX_DEPOSIT,
  premiumScale: 500,
  verification: {min: MIN_VERIFICATION_FREQUENCY, base: BASE_VERIFICATION_FREQUENCY},
  paymentDays: {min: MIN_PAYMENT_DAYS, max: MAX_PAYMENT_DAYS},
  exposure: {max: 100000, power: 1},
  kycCaps: {none: 0, basic: 10000, enhanced: 250000},
  thresholds: {strong: 0.7, weak: 0.4, lowConfidence: 0.2, repeatPairs: 5},
};

/** f(L) = f_min + (f_max - f_min) * (1 - L)^eta, rounded to whole basis points. */
export function feeBpsFor(side: FeeCurveSide, lowerBound: number): number {
  const bound = clamp01(lowerBound);
  return Math.round(side.minBps + (side.maxBps - side.minBps) * Math.pow(1 - bound, side.power));
}

function validateSide(label: string, side: FeeCurveSide): void {
  if (!(side.minBps >= 0 && side.minBps <= side.maxBps && side.maxBps <= 10000)) {
    throw new Error(`${label} fee bounds must satisfy 0 <= min <= max <= 10000`);
  }
  if (!(side.power > 0) || !Number.isFinite(side.power)) {
    throw new Error(`${label} fee power must be finite and positive`);
  }
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The agreed curve proposal with versioned default parameters. */
export class CurveFeeTermsPolicy implements FeeTermsPolicy {
  readonly version: string;

  constructor(readonly params: CurveFeeTermsParams = DEFAULT_CURVE_FEE_TERMS_PARAMS) {
    validateSide('buyer', params.buyer);
    validateSide('seller', params.seller);
    if (params.kycCaps.none !== 0) throw new Error('the KYC cap for tier none must be zero');
    if (!(params.verification.min >= 0 && params.verification.min <= params.verification.base &&
        params.verification.base <= 1)) {
      throw new Error('verification bounds must satisfy 0 <= min <= base <= 1');
    }
    if (!(params.paymentDays.min >= 0 && params.paymentDays.min <= params.paymentDays.max)) {
      throw new Error('payment days must satisfy 0 <= min <= max');
    }
    if (!(params.exposure.power > 0) || !(params.exposure.max >= 0)) {
      throw new Error('exposure needs a non-negative maximum and a positive power');
    }
    this.version = params.version;
  }

  decide(input: TermsPolicyInput): TermsDecision {
    const bound = clamp01(input.score.lowerBound);
    const tier = isKycTier(input.kycTier) ? input.kycTier : 'none';
    const scoreLimit = this.params.exposure.max * Math.pow(bound, this.params.exposure.power);
    const kycCap = this.params.kycCaps[tier];
    const terms: TermsOffer = {
      deposit: money(this.params.maxDeposit * (1 - bound)),
      premium: money(this.params.premiumScale * (1 - bound)),
      limit: money(Math.min(scoreLimit, kycCap)),
      paymentDays: Math.round(
        this.params.paymentDays.min + (this.params.paymentDays.max - this.params.paymentDays.min) * bound,
      ),
      verificationFrequency: Math.max(
        this.params.verification.min, this.params.verification.base * (1 - bound),
      ),
    };
    const reasonCode = this.reasonFor(input, bound, tier, kycCap < scoreLimit);
    return {
      entityId: input.entityId, category: input.category,
      inputs: {
        ...input.inputs, role: input.score.role, lowerBound: bound,
        kycTier: tier, kycCap, scoreLimit: money(scoreLimit),
      },
      terms,
      buyerFeeBps: feeBpsFor(this.params.buyer, bound),
      sellerFeeBps: feeBpsFor(this.params.seller, bound),
      reasonCode, policyVersion: this.version, decidedAt: input.now,
    };
  }

  private reasonFor(
    input: TermsPolicyInput, bound: number, tier: KycTier, kycBinds: boolean,
  ): TermsReasonCode {
    const thresholds = this.params.thresholds;
    if (tier === 'none') return 'KYC_LIMIT';
    if (input.score.eventCount === 0) return 'NEW_ENTITY';
    if (input.repeatPairCount > thresholds.repeatPairs) return 'REPEAT_PAIR_DISCOUNT';
    if (input.score.confidence < thresholds.lowConfidence) return 'LOW_CONFIDENCE';
    if (kycBinds) return 'KYC_LIMIT';
    if (bound >= thresholds.strong) return 'STRONG_HISTORY';
    if (bound < thresholds.weak) return 'WEAK_HISTORY';
    return 'POLICY_DEFAULT';
  }
}

function isKycTier(value: string): value is KycTier {
  return value === 'none' || value === 'basic' || value === 'enhanced';
}
