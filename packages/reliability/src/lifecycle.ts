/**
 * @fileoverview Coordinates transaction stages, escrow actions, and persistence.
 * Contracts, stored-value codecs, escrow evidence, and outcome projection
 * live in lifecycle/. Public imports from this module remain available.
 */

import {createHash} from 'node:crypto';
import type {EscrowFundRequest, EscrowPort, EscrowSession} from './escrow-port';
import type {
  JsonValue, MarketplaceTransaction, Outcome, OutcomeState, TermsVersion,
  TransactionType,
} from './types';
import {
  assertEvidence, assertJson, contractEnd, copyTerms, copyTransition,
  parseEvidenceJson, parseStage, parseTime, readTier,
} from './lifecycle/codecs';
import {
  LIFECYCLE_NEXT_STAGES, LIFECYCLE_VERSION, LifecycleError,
  type DeliveryTier, type DisputeDecision, type FundEscrowInput,
  type LifecycleStage, type LifecycleStore, type LifecycleTransition,
  type OpenDisputeInput, type OpenTransactionInput, type RefundEscrowInput,
  type ReleaseEscrowInput, type ResolveDisputeInput, type TransactionLifecycle,
} from './lifecycle/contracts';
import {sessionEvidence, sessionFromEvidence} from './lifecycle/escrow-evidence';
import {disputeRecord, findStage, projectLifecycleOutcome} from './lifecycle/outcome';

export {
  DELIVERY_TIER_VERIFICATION, DELIVERY_TIERS, LIFECYCLE_NEXT_STAGES,
  LIFECYCLE_VERSION, LifecycleError, RESOLVER_CONFIDENCE,
  VOLUNTARY_REFUND_CONFIDENCE,
} from './lifecycle/contracts';
export type {
  DeliveryTier, DisputeDecision, FundEscrowInput, LifecycleStage,
  LifecycleStore, LifecycleTransition, OpenDisputeInput, OpenTransactionInput,
  RefundEscrowInput, ReleaseEscrowInput, ResolveDisputeInput,
  StoredLifecycleTransition, TransactionLifecycle,
} from './lifecycle/contracts';

const TRANSACTION_TYPES: readonly TransactionType[] = [
  'goods', 'service', 'invoice',
];

const MONEY_STAGES: readonly LifecycleStage[] = [
  'escrow_funded', 'payment_settled', 'refunded',
];

const TERMINAL_OUTCOMES: readonly OutcomeState[] = [
  'successful', 'failed', 'cancelled', 'unresolved',
];

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
    const contractEnds = contractEnd(input.contractEnds, input.terms.contractEnds);
    if (this.hasTransaction(input.id)) {
      throw new LifecycleError(`transaction ${input.id} already exists`);
    }
    const terms = copyTerms(input.terms);
    if (contractEnds && terms.contractEnds === undefined) terms.contractEnds = contractEnds;
    const version: TermsVersion = {
      version: 1,
      terms: copyTerms(terms),
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
      terms: copyTerms(terms),
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
      evidence: {
        reason: 'offer accepted',
        ...(contractEnds ? {contractEnds} : {}),
      },
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
    const port = this.requireEscrow();
    const session = await port.fund(request);
    this.assertEscrowResult(session.simulated, session.mode);
    const chain = await this.chainEvidence(session);
    return this.commitEscrow({
      transactionId: input.transactionId,
      from: 'offer_accepted',
      to: 'escrow_funded',
      at: input.at,
      evidence: sessionEvidence(session, {
        disputeWindowEnds: input.disputeWindowEnds,
        masumiAction: 'create_purchase',
        ...chain,
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
    const port = this.requireEscrow();
    const result = await port.release(
      session,
      sha256(`${input.transactionId}:${tier ?? 'resolver'}:${input.at}`),
    );
    this.assertEscrowResult(result.simulated, result.mode);
    const chain = await this.chainEvidence(session);
    return this.commitEscrow({
      transactionId: input.transactionId,
      from: stage,
      to: 'payment_settled',
      at: input.at,
      evidence: {
        simulated: result.simulated,
        mode: result.mode,
        masumiAction: result.action,
        resultHash: result.resultHash,
        blockchainIdentifier: result.blockchainIdentifier,
        ...chain,
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
    const port = this.requireEscrow();
    const result = await port.refund(session);
    this.assertEscrowResult(result.simulated, result.mode);
    const chain = await this.chainEvidence(session);
    const fault = stage === 'dispute_resolved' ? 'seller' :
      input.fault === 'buyer' ? 'buyer' : 'none';
    return this.commitEscrow({
      transactionId: input.transactionId,
      from: stage,
      to: 'refunded',
      at: input.at,
      evidence: {
        simulated: result.simulated,
        mode: result.mode,
        masumiAction: result.action,
        blockchainIdentifier: result.blockchainIdentifier,
        ...chain,
        fault,
        refunded: true,
        ...(fault === 'seller' ? {resolution: 'uphold_buyer'} : {}),
        ...(input.reason ? {reason: input.reason} : {}),
      },
    });
  }

  /**
   * Ends the contract when both parties consent before `contractEnds`.
   * Escrow is returned through the port. The outcome emits no events.
   * A one-sided cancel stays on `cancel`.
   */
  async mutualTerminate(input: {
    transactionId: string;
    at: string;
    buyerConsentAt: string;
    sellerConsentAt: string;
  }): Promise<LifecycleTransition> {
    const at = parseTime(input.at, 'at');
    const buyerConsentAt = parseTime(input.buyerConsentAt, 'buyerConsentAt');
    const sellerConsentAt = parseTime(input.sellerConsentAt, 'sellerConsentAt');
    if (buyerConsentAt > at || sellerConsentAt > at) {
      throw new LifecycleError('consent must be at or before termination');
    }
    const ends = this.contractEnds(input.transactionId);
    if (at >= parseTime(ends, 'contractEnds')) {
      throw new LifecycleError('the contract term has ended');
    }
    const stage = this.requireStage(input.transactionId);
    const consent = {
      termination: 'mutual',
      buyerConsentAt: input.buyerConsentAt,
      sellerConsentAt: input.sellerConsentAt,
      contractEnds: ends,
      contractStart: this.transaction(input.transactionId).createdAt,
    };
    if (stage === 'offer_accepted') {
      return this.advance({
        transactionId: input.transactionId,
        from: 'offer_accepted',
        to: 'cancelled',
        at: input.at,
        evidence: {...consent, escrowDisposition: 'unfunded'},
      });
    }
    if (stage !== 'escrow_funded' && stage !== 'delivery_confirmed') {
      throw new LifecycleError(`cannot terminate from ${stage}`);
    }
    const session = this.sessionFor(input.transactionId);
    const port = this.requireEscrow();
    const result = await port.mutualTerminate(session, {
      buyerConsentAt: input.buyerConsentAt,
      sellerConsentAt: input.sellerConsentAt,
      contractEnds: ends,
      terminatedAt: input.at,
    });
    this.assertEscrowResult(result.simulated, result.mode);
    const chain = await this.chainEvidence(session);
    return this.commitEscrow({
      transactionId: input.transactionId,
      from: stage,
      to: 'refunded',
      at: input.at,
      evidence: {
        ...consent,
        simulated: result.simulated,
        mode: result.mode,
        masumiAction: result.action,
        blockchainIdentifier: result.blockchainIdentifier,
        fault: 'none',
        refunded: true,
        ...chain,
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
    const outcome = projectLifecycleOutcome(
      transactionId, this.history(transactionId), options, this.version,
    );
    this.persist(outcome);
    return outcome;
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

  private requireEscrow(): EscrowPort {
    const port = this.options.escrow;
    if (!port) throw new LifecycleError('an escrow port is required');
    if (port.broadcast && port.simulated) {
      throw new LifecycleError('escrow must stay simulated; live broadcast is disabled');
    }
    if (!port.simulated && !port.broadcast) {
      throw new LifecycleError('escrow must stay simulated; live broadcast is disabled');
    }
    return port;
  }

  private assertEscrowResult(simulated: boolean, mode: string): void {
    const port = this.requireEscrow();
    if (port.simulated) {
      if (!simulated || mode !== 'paper') {
        throw new LifecycleError('escrow must stay simulated; live broadcast is disabled');
      }
      return;
    }
    if (!port.broadcast || simulated || mode !== 'live') {
      throw new LifecycleError('a preprod order must be live and explicitly enabled');
    }
  }

  private async chainEvidence(session: EscrowSession): Promise<Evidence> {
    const status = await this.requireEscrow().status(session);
    const evidence: Evidence = {
      escrowState: status.onChainState ?? session.onChainState,
    };
    if (status.txHash) evidence.txHash = status.txHash;
    if (status.blockTime) evidence.blockTime = status.blockTime;
    if (status.escrowAddress) evidence.escrowAddress = status.escrowAddress;
    return evidence;
  }

  private contractEnds(transactionId: string): string {
    const fromTerms = this.transaction(transactionId).terms.contractEnds;
    if (typeof fromTerms === 'string' && fromTerms !== '') {
      parseTime(fromTerms, 'contractEnds');
      return fromTerms;
    }
    const recorded = this.findStage(transactionId, 'offer_accepted')?.evidence.contractEnds;
    if (typeof recorded === 'string' && recorded !== '') {
      parseTime(recorded, 'contractEnds');
      return recorded;
    }
    throw new LifecycleError('the contract has no end');
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
    return findStage(this.history(transactionId), stage);
  }

  private optionalTier(transactionId: string): DeliveryTier|undefined {
    const delivery = this.findStage(transactionId, 'delivery_confirmed');
    if (!delivery) return undefined;
    return readTier(delivery.evidence.deliveryTier, true);
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
    return disputeRecord(this.history(transactionId));
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
