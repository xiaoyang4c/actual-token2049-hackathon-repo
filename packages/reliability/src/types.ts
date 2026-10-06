/**
 * @fileoverview Domain types for the transaction reliability marketplace.
 * This file holds shared contracts only. It contains no scoring math, no
 * fee math, no verification logic, and no network calls. Lane owners
 * implement behavior behind the interfaces in the sibling modules.
 */

/** JSON value stored for terms, evidence, and decision inputs. */
export type JsonValue =
  string|number|boolean|null|JsonValue[]|{[key: string]: JsonValue};

/** Role an entity plays inside one transaction. */
export type EntityRole = 'buyer'|'seller';

/** Reliability category. One category never proves another. */
export type ReliabilityCategory =
  'compute'|'payment'|'fulfillment'|'delivery'|'sla'|'dispute';

/** Transaction type. Goods sales, services, and invoices. */
export type TransactionType = 'goods'|'service'|'invoice';

/** KYC status of an entity. Read through the provider interface. */
export type KycStatus = 'unverified'|'pending'|'verified'|'rejected';

/** KYC tier of an entity. Higher tiers unlock stricter-gated terms. */
export type KycTier = 'none'|'basic'|'enhanced';

/**
 * Outcome state of a transaction. Pending is not successful. Disputed is
 * not a final failure until the named resolver decides or the deadline
 * passes.
 */
export type OutcomeState =
  'pending'|'successful'|'failed'|'disputed'|'cancelled'|'unresolved';

/** How an outcome was verified. Unverified user ratings never count. */
export type VerificationMethod =
  'lifecycle'|'payment-settlement'|'manual-review'|'unverified';

/**
 * A marketplace participant. It can buy, sell, or both. A wallet address
 * never proves that two entities are independent.
 */
export interface Entity {
  id: string;
  displayName: string;
  wallets: string[];
  kycStatus: KycStatus;
  kycTier: KycTier;
  roles: EntityRole[];
  createdAt: string;
}

/** One participant inside a transaction. */
export interface TransactionParticipant {
  entityId: string;
  role: EntityRole;
}

/** One recorded version of transaction terms. Terms never change without a new version. */
export interface TermsVersion {
  version: number;
  terms: {[key: string]: JsonValue};
  reason: string;
  createdAt: string;
}

/**
 * An agreement between two or more entities. The terms hash is set when
 * immutable verification is required (B2B payment terms with a due date).
 */
export interface MarketplaceTransaction {
  id: string;
  type: TransactionType;
  participants: TransactionParticipant[];
  terms: {[key: string]: JsonValue};
  termsHash?: string;
  versions: TermsVersion[];
  value?: number;
  createdAt: string;
  completedAt?: string;
}

/**
 * The verified result of a transaction. Every outcome carries evidence.
 * Disputed outcomes name a resolver and a deadline.
 */
export interface Outcome {
  transactionId: string;
  state: OutcomeState;
  evidence: {[key: string]: JsonValue};
  verificationMethod: VerificationMethod;
  verificationConfidence?: number;
  resolver?: string;
  resolveBy?: string;
  decidedAt: string;
}

/** Success or failure applied to one entity for one transaction. */
export type ReliabilityOutcome = 'success'|'failure';

/**
 * One reliability input. It references a transaction, the affected
 * entity, the applicable category and role, the outcome, the evidence,
 * and the verification behind it.
 */
export interface ReliabilityEvent {
  id: string;
  transactionId: string;
  entityId: string;
  category: ReliabilityCategory;
  role: EntityRole;
  outcome: ReliabilityOutcome;
  evidence: {[key: string]: JsonValue};
  verificationMethod: VerificationMethod;
  verificationConfidence?: number;
  value?: number;
  createdAt: string;
}

/**
 * Beta posterior per entity, per category, per role. Every entity holds
 * a separate buyer score and a separate seller score.
 */
export interface ReliabilityState {
  entityId: string;
  category: ReliabilityCategory;
  role: EntityRole;
  alpha: number;
  beta: number;
  eventCount: number;
  updatedAt: string;
}

/** Read model for one score. Value and confidence stay separate. */
export interface ScoreView {
  entityId: string;
  category: ReliabilityCategory;
  role: EntityRole;
  /** Posterior mean, alpha / (alpha + beta). Display only. */
  value: number;
  /** Lower credible bound. Policy decisions use this, not the mean. */
  lowerBound: number;
  /** Confidence in the score, from zero to one. New entities score low. */
  confidence: number;
  eventCount: number;
}

/** Commercial terms granted to one entity in one category. */
export interface TermsOffer {
  deposit: number;
  premium: number;
  limit: number;
  paymentDays: number;
  verificationFrequency: number;
}

/** Reason recorded for every material change in terms. */
export type TermsReasonCode =
  'NEW_ENTITY'|'LOW_CONFIDENCE'|'STRONG_HISTORY'|'WEAK_HISTORY'|
  'REPEAT_PAIR_DISCOUNT'|'KYC_LIMIT'|'POLICY_DEFAULT';

/**
 * One policy decision. It records the entity, the category, the inputs,
 * the resulting terms, the buyer and seller fees, the reason code, and
 * the policy version.
 */
export interface TermsDecision {
  entityId: string;
  category: ReliabilityCategory;
  inputs: {[key: string]: JsonValue};
  terms: TermsOffer;
  buyerFeeBps: number;
  sellerFeeBps: number;
  reasonCode: TermsReasonCode;
  policyVersion: string;
  decidedAt: string;
}

/**
 * A marketplace listing. It can require a minimum buyer reliability
 * and a minimum seller reliability before a transaction is created.
 */
export interface Listing {
  id: string;
  sellerId: string;
  transactionType: TransactionType;
  title: string;
  price?: number;
  pricingMethod?: string;
  requiredTerms: {[key: string]: JsonValue};
  minBuyerReliability?: number;
  minSellerReliability?: number;
  createdAt: string;
}

/** Transaction plus its outcome, events, and latest terms decision. */
export interface Receipt {
  transaction: MarketplaceTransaction;
  outcome: Outcome|undefined;
  events: ReliabilityEvent[];
  termsDecision: TermsDecision|undefined;
}
