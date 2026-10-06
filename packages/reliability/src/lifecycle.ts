/**
 * @fileoverview Transaction lifecycle and paper escrow state machine.
 *
 * A sale moves from offer accepted to escrow funded, delivery confirmed,
 * and payment settled. Cancel, refund, and dispute are side paths.
 * Pending is not successful. Disputed is not a final failure.
 *
 * A successful outcome has no fault. A resolver refund sets fault to
 * seller. A buyer-caused failure sets fault to buyer. A mutual end sets
 * fault to none.
 *
 * Delivery evidence has three tiers, strongest first: carrier proof,
 * buyer confirmation, and silent release after the dispute window.
 * A self-reported claim stays pending and cannot settle escrow.
 *
 * An open dispute names a resolver and a deadline. After that deadline
 * the outcome is unresolved and the paper escrow stays held.
 *
 * Terms are copied at creation. A later change appends a version.
 * Escrow funding, release, and refund call the escrow port. The port
 * must be simulated. This file does not broadcast a live order.
 */

import {createHash} from 'node:crypto';
import type {
  EscrowFundRequest, EscrowPort, EscrowSession,
} from './escrow-port';
import type {
  JsonValue, MarketplaceTransaction, Outcome, OutcomeState, TermsVersion,
  TransactionType, VerificationMethod,
} from './types';

export const LIFECYCLE_VERSION = 'lifecycle-v1';

/** Resolver review confidence. A named resolver is not a self-report. */
export const RESOLVER_CONFIDENCE = 0.85;

/** Confidence for a paper refund request with no fault finding. */
export const VOLUNTARY_REFUND_CONFIDENCE = 0.9;

const CANCEL_CONFIDENCE = 1;
const TIMEOUT_CONFIDENCE = 1;

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
  delivery_confirmed: ['payment_settled', 'dispute_opened'],
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
export interface LifecycleStore {
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
  at: string;
}

/** Inputs for paper escrow funding. */
export interface FundEscrowInput {
  transactionId: string;
  amountLovelace: number;
  sellerReturnAddress: string;
  disputeWindowEnds: string;
  at: string;
}

/** Inputs for paper escrow release. */
export interface ReleaseEscrowInput {
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

const STAGES: readonly LifecycleStage[] = [
  'offer_accepted', 'escrow_funded', 'delivery_confirmed', 'payment_settled',
  'dispute_opened', 'dispute_resolved', 'refunded', 'cancelled',
];

const TRANSACTION_TYPES: readonly TransactionType[] = [
  'goods', 'service', 'invoice',
];

const MONEY_STAGES: readonly LifecycleStage[] = [
  'escrow_funded', 'payment_settled', 'refunded',
];

const TERMINAL_OUTCOMES: readonly OutcomeState[] = [
  'successful', 'failed', 'cancelled', 'unresolved',
];

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Evidence = LifecycleTransition['evidence'];

/**
 * Paper escrow state machine.
 * Pass a simulated `EscrowPort`. Pass a `LifecycleStore` to persist
 * stages, terms versions, and outcomes.
 */
export class EscrowTransactionLifecycle implements TransactionLifecycle {
  readonly version = LIFECYCLE_VERSION;
  private readonly transactions = new Map<string, MarketplaceTransaction>();
  private readonly memory = new Map<string, LifecycleTransition[]>();
  private escrowDepth = 0;

  constructor(private readonly options: {
    store?: LifecycleStore;
    escrow?: EscrowPort;
  } = {}) {}

  /**
   * Records terms version 1 and moves the sale to `offer_accepted`.
   * The buyer and the seller must already exist when a store is set.
   */
  open(input: OpenTransactionInput): MarketplaceTransaction {
    this.requireText(input.id, 'id');
    this.requireText(input.buyerId, 'buyerId');
    this.requireText(input.sellerId, 'sellerId');
    if (input.buyerId === input.sellerId) {
      throw new LifecycleError('the buyer and the seller must be different entities');
    }
    if (!TRANSACTION_TYPES.includes(input.type)) {
      throw new LifecycleError('unknown transaction type');
    }
    parseTime(input.at, 'at');
    if (input.value !== undefined && (!Number.isFinite(input.value) || input.value < 0)) {
      throw new LifecycleError('value must be a non-negative number');
    }
    if (input.termsHash !== undefined) this.requireText(input.termsHash, 'termsHash');
    assertJson(input.terms, 'terms');
    if (this.hasTransaction(input.id)) {
      throw new LifecycleError(`transaction ${input.id} already exists`);
    }
    const version: TermsVersion = {
      version: 1,
      terms: copyTerms(input.terms),
      reason: 'initial terms',
      createdAt: input.at,
    };
    const transaction: MarketplaceTransaction = {
      id: input.id,
      type: input.type,
      participants: [
        {entityId: input.buyerId, role: 'buyer'},
        {entityId: input.sellerId, role: 'seller'},
      ],
      terms: copyTerms(input.terms),
      termsHash: input.termsHash,
      versions: [version],
      value: input.value,
      createdAt: input.at,
    };
    if (this.options.store) {
      this.transactions.set(
        input.id, this.options.store.insertTransaction(transaction),
      );
    } else {
      this.transactions.set(input.id, transaction);
    }
    this.advance({
      transactionId: input.id,
      from: undefined,
      to: 'offer_accepted',
      evidence: {reason: 'offer accepted'},
      at: input.at,
    });
    return this.transaction(input.id);
  }

  /**
   * Appends a terms version.
   * Older versions stay as stored. This does not edit them.
   */
  amendTerms(
    transactionId: string,
    terms: {[key: string]: JsonValue},
    reason: string,
    at: string,
  ): TermsVersion {
    this.requireText(reason, 'reason');
    parseTime(at, 'at');
    assertJson(terms, 'terms');
    const current = this.transaction(transactionId);
    const stage = this.currentStage(transactionId);
    if (stage === 'payment_settled' || stage === 'refunded' || stage === 'cancelled') {
      throw new LifecycleError(`terms are frozen after ${stage}`);
    }
    if (stage === 'dispute_opened' && this.pastDeadline(transactionId, at)) {
      throw new LifecycleError('terms are frozen after an unresolved dispute');
    }
    const nextTerms = copyTerms(terms);
    const versionNumber = current.versions.reduce(
      (max, item) => Math.max(max, item.version), 0,
    ) + 1;
    const version: TermsVersion = {
      version: versionNumber,
      terms: nextTerms,
      reason,
      createdAt: at,
    };
    const store = this.options.store;
    if (store) {
      store.insertTermsVersion(transactionId, version);
      store.updateTransactionTerms(transactionId, nextTerms, undefined);
      const reloaded = store.getTransaction(transactionId);
      if (!reloaded) throw new LifecycleError('transaction was not stored');
      this.transactions.set(transactionId, reloaded);
      const saved = reloaded.versions[reloaded.versions.length - 1];
      if (!saved) throw new LifecycleError('terms version was not stored');
      return saved;
    }
    this.transactions.set(transactionId, {
      ...current,
      terms: nextTerms,
      termsHash: undefined,
      versions: [...current.versions, version],
    });
    return version;
  }

  /** Returns the transaction, including every terms version. */
  getTransaction(transactionId: string): MarketplaceTransaction {
    return this.transaction(transactionId);
  }

  /** Returns whether creation already recorded this id. */
  hasTransaction(transactionId: string): boolean {
    if (this.transactions.has(transactionId)) return true;
    return this.options.store?.getTransaction(transactionId) !== undefined;
  }

  /** Funds paper escrow through the escrow port. */
  async fund(input: FundEscrowInput): Promise<LifecycleTransition> {
    parseTime(input.at, 'at');
    const windowEnds = parseTime(input.disputeWindowEnds, 'disputeWindowEnds');
    if (windowEnds <= parseTime(input.at, 'at')) {
      throw new LifecycleError('the dispute window must end after funding');
    }
    if (!Number.isSafeInteger(input.amountLovelace) || input.amountLovelace <= 0) {
      throw new LifecycleError('amountLovelace must be a positive integer');
    }
    this.requireText(input.sellerReturnAddress, 'sellerReturnAddress');
    const stage = this.currentStage(input.transactionId);
    if (stage !== 'offer_accepted') {
      throw new LifecycleError(`cannot fund escrow from ${stage ?? 'none'}`);
    }
    const request: EscrowFundRequest = {
      transactionId: input.transactionId,
      purchaserId: this.party(input.transactionId, 'buyer'),
      amountLovelace: input.amountLovelace,
      sellerReturnAddress: input.sellerReturnAddress,
      payByTime: input.at,
      submitResultTime: input.disputeWindowEnds,
      unlockTime: input.disputeWindowEnds,
      externalDisputeUnlockTime: input.disputeWindowEnds,
      inputHash: sha256(
        `${input.transactionId}:${JSON.stringify(this.transaction(input.transactionId).terms)}`,
      ),
    };
    const session = await this.paperPort().fund(request);
    this.assertPaper(session.simulated, session.mode);
    return this.commitEscrow({
      transactionId: input.transactionId,
      from: 'offer_accepted',
      to: 'escrow_funded',
      at: input.at,
      evidence: sessionEvidence(session, {
        disputeWindowEnds: input.disputeWindowEnds,
        masumiAction: 'create_purchase',
      }),
    });
  }

  /** Records delivery or fulfillment evidence. Does not move funds. */
  confirmDelivery(input: {
    transactionId: string;
    at: string;
    evidence: Evidence;
  }): LifecycleTransition {
    return this.advance({
      transactionId: input.transactionId,
      from: this.currentStage(input.transactionId),
      to: 'delivery_confirmed',
      evidence: input.evidence,
      at: input.at,
    });
  }

  /**
   * Queues a Masumi result and settles the sale.
   * From `escrow_funded`, the only path is silent release.
   */
  async release(input: ReleaseEscrowInput): Promise<LifecycleTransition> {
    parseTime(input.at, 'at');
    let stage = this.requireStage(input.transactionId);
    if (stage === 'escrow_funded') {
      const evidence = input.evidence ?? {};
      if (evidence.deliveryTier !== 'silent_release') {
        throw new LifecycleError('confirm delivery before release');
      }
      this.advance({
        transactionId: input.transactionId,
        from: 'escrow_funded',
        to: 'delivery_confirmed',
        evidence,
        at: input.at,
      });
      stage = 'delivery_confirmed';
    }
    const decision = stage === 'dispute_resolved' ?
      this.requireDecision(input.transactionId) :
      undefined;
    if (decision !== undefined && decision !== 'uphold_seller') {
      throw new LifecycleError('this dispute resolution refunds the buyer');
    }
    if (decision === undefined && stage !== 'delivery_confirmed') {
      throw new LifecycleError(`cannot release escrow from ${stage}`);
    }
    const tier = this.optionalTier(input.transactionId);
    if (decision === undefined && tier === 'self_report') {
      throw new LifecycleError('a self-reported delivery cannot settle');
    }
    if (decision === undefined && tier === undefined) {
      throw new LifecycleError('settlement is missing delivery evidence');
    }
    if (input.evidence?.deliveryTier !== undefined &&
        tier !== undefined &&
        input.evidence.deliveryTier !== tier) {
      throw new LifecycleError('delivery evidence is already recorded');
    }
    const session = this.sessionFor(input.transactionId);
    const result = await this.paperPort().release(
      session,
      sha256(`${input.transactionId}:${tier ?? 'resolver'}:${input.at}`),
    );
    this.assertPaper(result.simulated, result.mode);
    return this.commitEscrow({
      transactionId: input.transactionId,
      from: stage,
      to: 'payment_settled',
      at: input.at,
      evidence: {
        simulated: true,
        mode: 'paper',
        masumiAction: result.action,
        resultHash: result.resultHash,
        blockchainIdentifier: result.blockchainIdentifier,
        ...(tier ? {deliveryTier: tier} : {}),
        ...(decision ? {
          resolution: decision,
          resolver: this.disputeRecord(input.transactionId).resolver,
        } : {}),
      },
    });
  }

  /** Queues a Masumi refund request. */
  async refund(input: RefundEscrowInput): Promise<LifecycleTransition> {
    parseTime(input.at, 'at');
    if (input.reason !== undefined) this.requireText(input.reason, 'reason');
    const stage = this.requireStage(input.transactionId);
    if (stage !== 'escrow_funded' && stage !== 'dispute_resolved') {
      throw new LifecycleError(`cannot refund from ${stage}`);
    }
    if (stage === 'dispute_resolved' &&
        this.requireDecision(input.transactionId) !== 'uphold_buyer') {
      throw new LifecycleError('this dispute resolution releases escrow to the seller');
    }
    const session = this.sessionFor(input.transactionId);
    const result = await this.paperPort().refund(session);
    this.assertPaper(result.simulated, result.mode);
    const fault = stage === 'dispute_resolved' ? 'seller' :
      input.fault === 'buyer' ? 'buyer' : 'none';
    return this.commitEscrow({
      transactionId: input.transactionId,
      from: stage,
      to: 'refunded',
      at: input.at,
      evidence: {
        simulated: true,
        mode: 'paper',
        masumiAction: result.action,
        blockchainIdentifier: result.blockchainIdentifier,
        fault,
        refunded: true,
        ...(fault === 'seller' ? {resolution: 'uphold_buyer'} : {}),
        ...(input.reason ? {reason: input.reason} : {}),
      },
    });
  }

  /** Cancels an accepted offer before escrow funding. */
  cancel(input: {
    transactionId: string;
    at: string;
    reason: string;
  }): LifecycleTransition {
    this.requireText(input.reason, 'reason');
    return this.advance({
      transactionId: input.transactionId,
      from: this.currentStage(input.transactionId),
      to: 'cancelled',
      evidence: {reason: input.reason},
      at: input.at,
    });
  }

  /** Opens a dispute. The resolver and the deadline are stored. */
  openDispute(input: OpenDisputeInput): LifecycleTransition {
    if (input.reason !== undefined) this.requireText(input.reason, 'reason');
    return this.advance({
      transactionId: input.transactionId,
      from: this.currentStage(input.transactionId),
      to: 'dispute_opened',
      at: input.at,
      evidence: {
        resolver: input.resolver,
        resolveBy: input.resolveBy,
        ...(input.reason ? {reason: input.reason} : {}),
      },
    });
  }

  /**
   * Records the resolver decision and moves the escrow.
   * Seller upheld releases escrow. Buyer upheld requests a refund.
   */
  async resolveDispute(input: ResolveDisputeInput): Promise<LifecycleTransition> {
    const stage = this.currentStage(input.transactionId);
    this.advance({
      transactionId: input.transactionId,
      from: stage,
      to: 'dispute_resolved',
      at: input.at,
      evidence: {resolver: input.resolver, decision: input.decision},
    });
    if (input.decision === 'uphold_seller') {
      return this.release({transactionId: input.transactionId, at: input.at});
    }
    return this.refund({transactionId: input.transactionId, at: input.at});
  }

  /** Stage changes that do not move escrow. */
  advance(transition: LifecycleTransition): LifecycleTransition {
    const stored = copyTransition(transition);
    assertEvidence(stored.evidence);
    parseTime(stored.at, 'at');
    if (!this.hasTransaction(stored.transactionId)) {
      throw new LifecycleError('record transaction terms before offer_accepted');
    }
    const current = this.currentStage(stored.transactionId);
    this.validateMove(stored, current);
    if (MONEY_STAGES.includes(stored.to) && this.escrowDepth === 0) {
      throw new LifecycleError(
        'escrow funding, release, and refund go through the Masumi escrow port',
      );
    }
    if (current === 'dispute_opened' && this.pastDeadline(stored.transactionId, stored.at)) {
      throw new LifecycleError('the dispute deadline has passed; the result is unresolved');
    }
    this.validateStage(stored);
    this.append(stored);
    this.outcomeFor(stored.transactionId, {now: stored.at});
    return stored;
  }

  currentStage(transactionId: string): LifecycleStage|undefined {
    const history = this.history(transactionId);
    if (history.length === 0) return undefined;
    return history[history.length - 1]?.to;
  }

  /** Copies of the stage history, oldest first. */
  listTransitions(transactionId: string): readonly LifecycleTransition[] {
    return this.history(transactionId).map((item) => ({
      ...item,
      evidence: {...item.evidence},
    }));
  }

  /**
   * Derives the verified outcome.
   * A dispute past its deadline returns `unresolved` and, when a store
   * is set, writes that outcome. The paper escrow stays held.
   */
  outcomeFor(
    transactionId: string, options: {
      resolver?: string;
      resolveBy?: string;
      now: string;
    },
  ): Outcome {
    parseTime(options.now, 'now');
    const history = this.history(transactionId);
    const stage = history.length === 0 ?
      undefined :
      history[history.length - 1]?.to;
    const latest = history[history.length - 1];
    const evidence: {[key: string]: JsonValue} = {
      ...(latest ? {...latest.evidence} : {}),
      stage: stage ?? 'none',
      transitions: history.length,
      producer: this.version,
    };
    const outcome = this.buildOutcome(
      transactionId, stage, evidence, options,
    );
    this.persist(outcome);
    return outcome;
  }

  private buildOutcome(
    transactionId: string,
    stage: LifecycleStage|undefined,
    evidence: {[key: string]: JsonValue},
    options: {resolver?: string; resolveBy?: string; now: string},
  ): Outcome {
    const base = {
      transactionId,
      evidence,
      decidedAt: options.now,
    };
    if (stage === 'payment_settled') {
      return this.settledOutcome(transactionId, base);
    }
    if (stage === 'refunded') return this.refundedOutcome(transactionId, base);
    if (stage === 'cancelled') {
      return {
        ...base,
        state: 'cancelled',
        ...(evidence.termination === 'mutual' ? {fault: 'none' as const} : {}),
        verificationMethod: 'lifecycle',
        verificationConfidence: CANCEL_CONFIDENCE,
      };
    }
    if (stage === 'dispute_opened') {
      return this.disputedOutcome(transactionId, base, options);
    }
    if (stage === 'delivery_confirmed') {
      const tier = this.requiredTier(evidence.deliveryTier);
      const verification = DELIVERY_TIER_VERIFICATION[tier];
      return {
        ...base,
        state: 'pending',
        verificationMethod: verification.method,
        verificationConfidence: verification.confidence,
      };
    }
    return {...base, state: 'pending', verificationMethod: 'lifecycle'};
  }

  private settledOutcome(
    transactionId: string,
    base: {transactionId: string; evidence: {[key: string]: JsonValue}; decidedAt: string},
  ): Outcome {
    const settlement = this.findStage(transactionId, 'payment_settled');
    if (settlement?.evidence.resolution === 'uphold_seller') {
      return {
        ...base,
        state: 'successful',
        verificationMethod: 'manual-review',
        verificationConfidence: RESOLVER_CONFIDENCE,
      };
    }
    const tierValue = settlement?.evidence.deliveryTier;
    const tier = this.requiredTier(tierValue);
    if (tier === 'self_report') {
      throw new LifecycleError('a self-reported delivery cannot settle');
    }
    const verification = DELIVERY_TIER_VERIFICATION[tier];
    return {
      ...base,
      state: 'successful',
      verificationMethod: verification.method,
      verificationConfidence: verification.confidence,
    };
  }

  private refundedOutcome(
    transactionId: string,
    base: {transactionId: string; evidence: {[key: string]: JsonValue}; decidedAt: string},
  ): Outcome {
    const refunded = this.findStage(transactionId, 'refunded');
    const fault = refunded?.evidence.fault;
    if (fault === 'seller' || fault === 'buyer') {
      return {
        ...base,
        state: 'failed',
        fault,
        verificationMethod: fault === 'seller' ? 'manual-review' : 'lifecycle',
        verificationConfidence: fault === 'seller' ?
          RESOLVER_CONFIDENCE : VOLUNTARY_REFUND_CONFIDENCE,
      };
    }
    if (fault === 'none') {
      return {
        ...base,
        state: 'cancelled',
        fault: 'none',
        verificationMethod: 'lifecycle',
        verificationConfidence: VOLUNTARY_REFUND_CONFIDENCE,
      };
    }
    throw new LifecycleError('refund evidence is missing a fault');
  }

  private disputedOutcome(
    transactionId: string,
    base: {transactionId: string; evidence: {[key: string]: JsonValue}; decidedAt: string},
    options: {resolver?: string; resolveBy?: string; now: string},
  ): Outcome {
    const dispute = this.disputeRecord(transactionId);
    if (options.resolver !== undefined && options.resolver !== dispute.resolver) {
      throw new LifecycleError('the resolver is already set');
    }
    if (options.resolveBy !== undefined && options.resolveBy !== dispute.resolveBy) {
      throw new LifecycleError('the dispute deadline is already set');
    }
    if (parseTime(options.now, 'now') > parseTime(dispute.resolveBy, 'resolveBy')) {
      base.evidence.timeoutResult = 'unresolved';
      base.evidence.escrowDisposition = 'held';
      return {
        ...base,
        state: 'unresolved',
        verificationMethod: 'lifecycle',
        verificationConfidence: TIMEOUT_CONFIDENCE,
        resolver: dispute.resolver,
        resolveBy: dispute.resolveBy,
      };
    }
    return {
      ...base,
      state: 'disputed',
      verificationMethod: 'lifecycle',
      resolver: dispute.resolver,
      resolveBy: dispute.resolveBy,
    };
  }

  private validateMove(
    transition: LifecycleTransition, current: LifecycleStage|undefined,
  ): void {
    if (current === undefined) {
      if (transition.to !== 'offer_accepted') {
        throw new LifecycleError('a transaction starts at offer_accepted');
      }
      if (transition.from !== undefined) {
        throw new LifecycleError('transition source does not match the current stage');
      }
      return;
    }
    if (transition.from !== current) {
      throw new LifecycleError('transition source does not match the current stage');
    }
    if (!LIFECYCLE_NEXT_STAGES[current].includes(transition.to)) {
      throw new LifecycleError(`cannot move from ${current} to ${transition.to}`);
    }
  }

  private validateStage(transition: LifecycleTransition): void {
    if (transition.to === 'delivery_confirmed') {
      this.validateDelivery(transition);
    }
    if (transition.to === 'dispute_opened') this.validateDisputeOpen(transition);
    if (transition.to === 'dispute_resolved') {
      this.validateDisputeResolve(transition);
    }
    if (transition.to === 'payment_settled') {
      this.validateSettlement(transition);
    }
  }

  private validateDelivery(transition: LifecycleTransition): void {
    const tier = readTier(transition.evidence.deliveryTier, true);
    if (tier === 'carrier_proof') {
      this.assertCarrier(transition.transactionId, transition.evidence);
    }
    if (tier === 'buyer_confirmation' &&
        transition.evidence.confirmedBy !== this.party(transition.transactionId, 'buyer')) {
      throw new LifecycleError('buyer confirmation must come from the buyer');
    }
    if (tier === 'silent_release') {
      this.assertSilent(transition.transactionId, transition.at, transition.evidence);
    }
  }

  private validateDisputeOpen(transition: LifecycleTransition): void {
    const resolver = transition.evidence.resolver;
    const resolveBy = transition.evidence.resolveBy;
    if (typeof resolver !== 'string' || resolver.trim() === '' ||
        typeof resolveBy !== 'string') {
      throw new LifecycleError('a dispute names a resolver and a deadline');
    }
    if (parseTime(resolveBy, 'resolveBy') <= parseTime(transition.at, 'at')) {
      throw new LifecycleError('the deadline must be after the dispute opened');
    }
  }

  private validateDisputeResolve(transition: LifecycleTransition): void {
    const decision = transition.evidence.decision;
    if (decision !== 'uphold_seller' && decision !== 'uphold_buyer') {
      throw new LifecycleError(
        'a dispute resolution must uphold the seller or the buyer',
      );
    }
    const dispute = this.disputeRecord(transition.transactionId);
    if (transition.evidence.resolver !== dispute.resolver) {
      throw new LifecycleError('the resolver does not match the named resolver');
    }
  }

  private validateSettlement(transition: LifecycleTransition): void {
    if (transition.evidence.resolution === 'uphold_seller') return;
    const tier = readTier(transition.evidence.deliveryTier, true);
    if (tier === 'self_report') {
      throw new LifecycleError('a self-reported delivery cannot settle');
    }
  }

  private assertCarrier(transactionId: string, evidence: Evidence): void {
    const carrier = evidence.carrier;
    const proofRef = evidence.proofRef;
    if (typeof carrier !== 'string' || carrier.trim() === '' ||
        typeof proofRef !== 'string' || proofRef.trim() === '') {
      throw new LifecycleError('carrier proof needs a carrier and a proof reference');
    }
    const seller = this.party(transactionId, 'seller');
    if (carrier === seller || carrier === 'seller' || carrier === 'self' ||
        proofRef === seller || proofRef === 'self') {
      throw new LifecycleError('a seller claim is not carrier proof');
    }
  }

  private assertSilent(
    transactionId: string, at: string, evidence: Evidence,
  ): void {
    if (this.findStage(transactionId, 'dispute_opened')) {
      throw new LifecycleError('a complaint blocks silent release; open a dispute');
    }
    if ('complaint' in evidence && evidence.complaint !== false) {
      throw new LifecycleError('a complaint blocks silent release; open a dispute');
    }
    const windowEnds = this.disputeWindow(transactionId);
    if (parseTime(at, 'at') < parseTime(windowEnds, 'disputeWindowEnds')) {
      throw new LifecycleError('silent release waits until the dispute window ends');
    }
  }

  private commitEscrow(transition: LifecycleTransition): LifecycleTransition {
    this.escrowDepth += 1;
    try {
      return this.advance(transition);
    } finally {
      this.escrowDepth -= 1;
    }
  }

  private paperPort(): EscrowPort {
    const port = this.options.escrow;
    if (!port) throw new LifecycleError('an escrow port is required');
    if (!port.simulated) {
      throw new LifecycleError('escrow must stay simulated; live broadcast is disabled');
    }
    return port;
  }

  private assertPaper(simulated: boolean, mode: string): void {
    if (!simulated || mode !== 'paper') {
      throw new LifecycleError('escrow must stay simulated; live broadcast is disabled');
    }
  }

  private persist(outcome: Outcome): void {
    const store = this.options.store;
    if (!store) return;
    store.saveOutcome(outcome);
    if (!TERMINAL_OUTCOMES.includes(outcome.state)) return;
    const current = this.transaction(outcome.transactionId);
    if (current.completedAt) return;
    store.setTransactionCompletedAt(outcome.transactionId, outcome.decidedAt);
    current.completedAt = outcome.decidedAt;
  }

  private append(transition: LifecycleTransition): void {
    const store = this.options.store;
    if (store) {
      store.insertLifecycleTransition({
        transactionId: transition.transactionId,
        fromStage: transition.from ?? null,
        toStage: transition.to,
        evidenceJson: JSON.stringify(transition.evidence),
        at: transition.at,
      });
      return;
    }
    const list = this.memory.get(transition.transactionId) ?? [];
    list.push(transition);
    this.memory.set(transition.transactionId, list);
  }

  private history(transactionId: string): LifecycleTransition[] {
    const store = this.options.store;
    if (store) {
      return store.listLifecycleTransitions(transactionId).map((row) => ({
        transactionId: row.transactionId,
        from: row.fromStage === null ? undefined : parseStage(row.fromStage),
        to: parseStage(row.toStage),
        evidence: parseEvidenceJson(row.evidenceJson),
        at: row.at,
      }));
    }
    return this.memory.get(transactionId) ?? [];
  }

  private transaction(id: string): MarketplaceTransaction {
    const cached = this.transactions.get(id);
    if (cached) return cached;
    const stored = this.options.store?.getTransaction(id);
    if (!stored) throw new LifecycleError(`unknown transaction ${id}`);
    this.transactions.set(id, stored);
    return stored;
  }

  private requireStage(transactionId: string): LifecycleStage {
    const stage = this.currentStage(transactionId);
    if (stage === undefined) {
      throw new LifecycleError(`unknown transaction ${transactionId}`);
    }
    return stage;
  }

  private party(
    transactionId: string, role: 'buyer'|'seller',
  ): string {
    const found = this.transaction(transactionId).participants.find(
      (item) => item.role === role,
    );
    if (!found) throw new LifecycleError(`transaction needs a ${role}`);
    return found.entityId;
  }

  private findStage(
    transactionId: string, stage: LifecycleStage,
  ): LifecycleTransition|undefined {
    const history = this.history(transactionId);
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const item = history[index];
      if (item?.to === stage) return item;
    }
    return undefined;
  }

  private optionalTier(transactionId: string): DeliveryTier|undefined {
    const delivery = this.findStage(transactionId, 'delivery_confirmed');
    if (!delivery) return undefined;
    return readTier(delivery.evidence.deliveryTier, true);
  }

  private requiredTier(value: JsonValue|undefined): DeliveryTier {
    return readTier(value, true);
  }

  private requireDecision(transactionId: string): DisputeDecision {
    const resolved = this.findStage(transactionId, 'dispute_resolved');
    const decision = resolved?.evidence.decision;
    if (decision === 'uphold_seller' || decision === 'uphold_buyer') {
      return decision;
    }
    throw new LifecycleError(
      'a dispute resolution must uphold the seller or the buyer',
    );
  }

  private disputeRecord(
    transactionId: string,
  ): {resolver: string; resolveBy: string} {
    const opened = this.findStage(transactionId, 'dispute_opened');
    const resolver = opened?.evidence.resolver;
    const resolveBy = opened?.evidence.resolveBy;
    if (typeof resolver !== 'string' || resolver === '' || typeof resolveBy !== 'string') {
      throw new LifecycleError('a dispute names a resolver and a deadline');
    }
    return {resolver, resolveBy};
  }

  private disputeWindow(transactionId: string): string {
    const funded = this.findStage(transactionId, 'escrow_funded');
    const value = funded?.evidence.disputeWindowEnds;
    if (typeof value !== 'string' || value === '') {
      throw new LifecycleError('escrow funding is missing a dispute window');
    }
    return value;
  }

  private pastDeadline(transactionId: string, at: string): boolean {
    const dispute = this.disputeRecord(transactionId);
    return parseTime(at, 'at') > parseTime(dispute.resolveBy, 'resolveBy');
  }

  private sessionFor(transactionId: string): EscrowSession {
    const funded = this.findStage(transactionId, 'escrow_funded');
    if (!funded) throw new LifecycleError('escrow is not funded');
    return sessionFromEvidence(funded.evidence);
  }

  private requireText(value: string, label: string): void {
    if (value.trim() === '') {
      throw new LifecycleError(`${label} must be a non-empty string`);
    }
  }
}

function copyTransition(transition: LifecycleTransition): LifecycleTransition {
  return {
    transactionId: transition.transactionId,
    from: transition.from,
    to: transition.to,
    at: transition.at,
    evidence: {...transition.evidence},
  };
}

function sessionEvidence(
  session: EscrowSession, extra: Evidence,
): Evidence {
  return {
    simulated: session.simulated,
    mode: session.mode,
    blockchainIdentifier: session.blockchainIdentifier,
    txHash: session.txHash,
    escrowAddress: session.escrowAddress,
    amountLovelace: session.amountLovelace,
    onChainState: session.onChainState,
    inputHash: session.inputHash,
    agentIdentifier: session.agentIdentifier,
    purchaserId: session.purchaserId,
    identifierFromPurchaser: session.identifierFromPurchaser,
    sellerVkey: session.sellerVkey,
    paymentSourceType: session.paymentSourceType,
    payByTime: session.payByTime,
    submitResultTime: session.submitResultTime,
    unlockTime: session.unlockTime,
    externalDisputeUnlockTime: session.externalDisputeUnlockTime,
    sellerReturnAddress: session.sellerReturnAddress,
    ...extra,
  };
}

function sessionFromEvidence(evidence: Evidence): EscrowSession {
  const text = (key: string): string => {
    const value = evidence[key];
    if (typeof value !== 'string' || value === '') {
      throw new LifecycleError('escrow session evidence is incomplete');
    }
    return value;
  };
  const amount = evidence.amountLovelace;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new LifecycleError('escrow session evidence is incomplete');
  }
  if (evidence.simulated !== true || evidence.mode !== 'paper') {
    throw new LifecycleError('escrow must stay simulated; live broadcast is disabled');
  }
  return {
    simulated: true,
    mode: 'paper',
    blockchainIdentifier: text('blockchainIdentifier'),
    txHash: text('txHash'),
    escrowAddress: text('escrowAddress'),
    amountLovelace: amount,
    onChainState: text('onChainState'),
    inputHash: text('inputHash'),
    agentIdentifier: text('agentIdentifier'),
    purchaserId: text('purchaserId'),
    identifierFromPurchaser: text('identifierFromPurchaser'),
    sellerVkey: text('sellerVkey'),
    paymentSourceType: text('paymentSourceType'),
    payByTime: text('payByTime'),
    submitResultTime: text('submitResultTime'),
    unlockTime: text('unlockTime'),
    externalDisputeUnlockTime: text('externalDisputeUnlockTime'),
    sellerReturnAddress: text('sellerReturnAddress'),
  };
}

function readTier(value: unknown, required: true): DeliveryTier;
function readTier(value: unknown, required: false): DeliveryTier|undefined;
function readTier(value: unknown, required: boolean): DeliveryTier|undefined {
  if (value === undefined || value === null) {
    if (required) throw new LifecycleError('delivery confirmation needs a delivery tier');
    return undefined;
  }
  for (const tier of DELIVERY_TIERS) {
    if (tier === value) return tier;
  }
  throw new LifecycleError('unknown delivery tier');
}

function parseStage(value: string): LifecycleStage {
  for (const stage of STAGES) {
    if (stage === value) return stage;
  }
  throw new LifecycleError(`unknown lifecycle stage ${value}`);
}

function parseTime(value: string, label: string): number {
  if (!TIMESTAMP.test(value)) {
    throw new LifecycleError(`${label} must be a UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new LifecycleError(`${label} must be a UTC timestamp`);
  }
  return parsed;
}

function assertEvidence(evidence: Evidence): void {
  for (const value of Object.values(evidence)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    throw new LifecycleError('evidence values must be scalars');
  }
}

function parseEvidenceJson(raw: string): Evidence {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LifecycleError('evidence must be an object');
  }
  const evidence: Evidence = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) {
      evidence[key] = value;
      continue;
    }
    throw new LifecycleError('evidence values must be scalars');
  }
  return evidence;
}

function copyTerms(
  terms: {[key: string]: JsonValue},
): {[key: string]: JsonValue} {
  const parsed: unknown = JSON.parse(JSON.stringify(terms));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LifecycleError('terms must be an object');
  }
  return parsed as {[key: string]: JsonValue};
}

function assertJson(value: JsonValue, label: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new LifecycleError(`${label} must be finite`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, label);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) assertJson(item, label);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
