/**
 * @fileoverview Lifecycle contracts, stages, evidence tiers, and errors.
 * These contracts do not depend on the state machine or its adapters.
 */

import type {LifecycleCommandStore} from './commands';
import type {
  JsonValue, MarketplaceTransaction, Outcome, TermsVersion,
  TransactionType, VerificationMethod,
} from '../types';

export const LIFECYCLE_VERSION = 'lifecycle-v1';

/** Resolver review confidence. A named resolver is not a self-report. */
export const RESOLVER_CONFIDENCE = 0.85;

/** Confidence for a paper refund request with no fault finding. */
export const VOLUNTARY_REFUND_CONFIDENCE = 0.9;

/** Delivery tiers. The first three can settle. Self-report cannot. */
export const DELIVERY_TIERS = [
  'carrier_proof', 'buyer_confirmation', 'silent_release', 'self_report',
] as const;

export type DeliveryTier = typeof DELIVERY_TIERS[number];

export type DisputeDecision = 'uphold_seller'|'uphold_buyer';

/**
 * Verification for each delivery tier.
 * Carrier proof is strongest. Silent release is the weakest success.
 * Self-report is unverified and must not settle.
 */
export const DELIVERY_TIER_VERIFICATION: Record<DeliveryTier, {
  method: VerificationMethod;
  confidence: number;
}> = {
  carrier_proof: {method: 'lifecycle', confidence: 0.95},
  buyer_confirmation: {method: 'lifecycle', confidence: 0.7},
  silent_release: {method: 'lifecycle', confidence: 0.4},
  self_report: {method: 'unverified', confidence: 0.1},
};

/** One stage of a generic sale. */
export type LifecycleStage =
  'offer_accepted'|'escrow_funded'|'delivery_confirmed'|'payment_settled'|
  'dispute_opened'|'dispute_resolved'|'refunded'|'cancelled';

/** Allowed next stages. */
export const LIFECYCLE_NEXT_STAGES: Record<
  LifecycleStage, readonly LifecycleStage[]
> = {
  offer_accepted: ['escrow_funded', 'cancelled'],
  escrow_funded: ['delivery_confirmed', 'dispute_opened', 'refunded'],
  // `refunded` from delivery is mutual termination only. One-sided refund stays on escrow_funded.
  delivery_confirmed: ['payment_settled', 'dispute_opened', 'refunded'],
  payment_settled: ['dispute_opened'],
  dispute_opened: ['dispute_resolved'],
  dispute_resolved: ['payment_settled', 'refunded'],
  refunded: [],
  cancelled: [],
};

/** One verified stage transition with its evidence. */
export interface LifecycleTransition {
  transactionId: string;
  from: LifecycleStage|undefined;
  to: LifecycleStage;
  evidence: {[key: string]: string|number|boolean|null};
  at: string;
}

/** Row shape stored by the lifecycle history table. */
export interface StoredLifecycleTransition {
  transactionId: string;
  fromStage: string|null;
  toStage: string;
  evidenceJson: string;
  at: string;
}

/**
 * Store seam for lifecycle state, terms versions, and outcomes.
 * `AgentStore` implements this shape. The lifecycle does not import it.
 */
export interface LifecycleStore extends Partial<LifecycleCommandStore> {
  insertTransaction(record: MarketplaceTransaction): MarketplaceTransaction;
  getTransaction(id: string): MarketplaceTransaction|undefined;
  insertTermsVersion(transactionId: string, version: TermsVersion): void;
  updateTransactionTerms(
    transactionId: string,
    terms: {[key: string]: JsonValue},
    termsHash: string|undefined,
  ): void;
  setTransactionCompletedAt(transactionId: string, completedAt: string): void;
  saveOutcome(record: Outcome): Outcome;
  getOutcome?(transactionId: string): Outcome|undefined;
  transaction?<T>(work: () => T): T;
  insertLifecycleTransition(record: StoredLifecycleTransition): void;
  listLifecycleTransitions(transactionId: string): StoredLifecycleTransition[];
}

/** Inputs for a new transaction. Version 1 is recorded here. */
export interface OpenTransactionInput {
  id: string;
  type: TransactionType;
  buyerId: string;
  sellerId: string;
  terms: {[key: string]: JsonValue};
  value?: number;
  termsHash?: string;
  /** UTC end of the contract term. Mutual termination must happen before this time. */
  contractEnds?: string;
  at: string;
}

/** Inputs for paper escrow funding. */
export interface FundEscrowInput {
  commandId?: string;
  transactionId: string;
  amountLovelace: number;
  sellerReturnAddress: string;
  disputeWindowEnds: string;
  at: string;
}

/** Inputs for paper escrow release. */
export interface ReleaseEscrowInput {
  commandId?: string;
  transactionId: string;
  at: string;
  /**
   * Required only when the stage is still `escrow_funded`.
   * That path is silent release. Set `deliveryTier` to `silent_release`.
   */
  evidence?: LifecycleTransition['evidence'];
}

/** Inputs for a paper refund request. */
export interface RefundEscrowInput {
  commandId?: string;
  transactionId: string;
  at: string;
  reason?: string;
  /** Buyer-caused refund. A dispute refund stays a seller fault. */
  fault?: 'buyer';
}

/** Inputs for opening a dispute. */
export interface OpenDisputeInput {
  transactionId: string;
  resolver: string;
  resolveBy: string;
  at: string;
  reason?: string;
}

/** Inputs for a resolver decision. The money move follows in the same call. */
export interface ResolveDisputeInput {
  commandId?: string;
  transactionId: string;
  resolver: string;
  decision: DisputeDecision;
  at: string;
}

/**
 * Lifecycle seam. `advance` records a stage change.
 * Funding, release, and refund stay on the async methods so they can
 * call the escrow port. `advance` rejects those stages on its own.
 */
export interface TransactionLifecycle {
  readonly version: string;
  advance(transition: LifecycleTransition): LifecycleTransition;
  currentStage(transactionId: string): LifecycleStage|undefined;
  outcomeFor(
    transactionId: string, options: {
      resolver?: string;
      resolveBy?: string;
      now: string;
    },
  ): Outcome;
}

/** Rejected lifecycle input or illegal stage change. */
export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleError';
  }
}
