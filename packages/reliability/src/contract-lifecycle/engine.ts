/**
 * @fileoverview Contract lifecycle engine.
 *
 * Rules:
 * - Every state change goes through the transition table and writes an
 *   audit entry.
 * - The engine commits state, audit entries, journaled escrow operations,
 *   and reliability publications in one transaction. External writes
 *   happen only later, in processOperations().
 * - A worker leases an operation and records the attempt before the
 *   external write. A retry after an unknown result inspects the rail
 *   first. A timeout or a crash never sends the same write twice.
 * - Funded, delivered, disputed, and every money outcome need confirmed
 *   escrow status. A queued request is not a state change.
 * - Every party action carries an Ed25519 signature. A replayed action id
 *   returns the earlier result.
 * - The platform does not move disputed funds on its own. A ruling
 *   creates obligations for the parties. Read docs/contract-lifecycle.md.
 */

import {randomUUID} from 'node:crypto';
import {canonicalize} from './canonical-json';
import {
  assertDisputeBudget, computeDeadlines, effectiveWindows, inspectionCutoff, validateDeadlines,
} from './deadlines';
import {ContractError} from './errors';
import {disputeFee} from './fees';
import {mip004InputHash, mip004ResultHash, newIdentifierFromPurchaser, sha256Hex} from './hashing';
import {
  ContractConflictError, EscrowRejectedError, type ContractAuditEntry, type ContractAuditRow,
  type ContractClock, type ContractEscrow, type ContractStore, type EscrowOperation,
  type EscrowOpKind, type EscrowRequest, type EscrowStatus, type NewEscrowOperation,
  type OperationUpdate, type ProcessedAction, type ReliabilityPublication,
} from './ports';
import {decisionsFor, decisionsForOutcome, trancheLayout, validateRemedy, winnerOfOutcome} from './remedies';
import {milestoneOutcome, milestoneTransaction, rulingComplianceEvents} from './settlement';
import {isPublicKeyHex, verifyBytes} from './signatures';
import {deliverableProblems, type TemplateRegistry} from './templates';
import {canTransition, IllegalTransitionError, nextState} from './transitions';
import {
  PAID_OUT_STATES, TERMINAL_STATES, type ChainView, type Contract, type ContractMode,
  type ContractParty, type ContractTerms, type CustodyModel, type EvidenceInput,
  type EvidencePhase, type EvidenceRecord, type EvidenceRule, type Inspector, type Milestone,
  type MilestoneEvent, type NegotiatedOutcome, type OnChainState, type Remedy, type Ruling,
  type RulingObligation, type SettlementOutcome, type Side, type Tranche, type WindowSet,
  type Winner,
} from './types';

/** Settings from the service config. The engine has no defaults of its own. */
export interface ContractSettings {
  mode: ContractMode;
  custodyModel: CustodyModel;
  assetUnit: string;
  assetDecimals: number;
  maxTranchesPerMilestone: number;
  /** A dispute must confirm on-chain before unlockTime. Stop taking disputes this early. */
  disputeSubmitSafetyMarginMs: number;
  windowOverrides: Partial<WindowSet>;
  mediator: {id: string; publicKeyHex: string}|null;
  /** Longer than the rail request timeout, so a slow call keeps its lease. */
  operationLeaseMs: number;
  maxEvidenceBytes: number;
  workerId: string;
}

export interface CreateContractInput {
  templateId: string;
  buyerId: string;
  sellerId: string;
  milestones: Array<{title: string; amountAtomic: string; deliverable: {[key: string]: unknown}}>;
  remedy?: Remedy;
  judgeInspectorId?: string;
  inspectorWhitelist?: Inspector[];
}

export type PartyActionType =
  'submit_for_acceptance'|'cancel'|'deliver'|'accept'|'dispute'|'concede_refund'|
  'escalate'|'submit_judge_report'|'comply_with_ruling'|'record_return_shipment'|
  'confirm_return_received'|'redeliver'|'accept_redo'|'reject_redo';

/** One signed instruction from a party. The client chooses `actionId` (a UUID). */
export interface PartyAction {
  actionId: string;
  contractId: string;
  milestoneId: string|null;
  partyId: string;
  action: PartyActionType;
  evidence?: EvidenceInput[];
  reason?: string;
}

/** The mediator names a winner. The remedy fixed at creation decides the money. */
export interface MediatorRuling {
  winner: 'buyer'|'seller';
  reason: string;
}

/** Evidence type the buyer uses to prove that a return was shipped. */
export const RETURN_TRACKING_EVIDENCE = 'return_tracking';

const SYSTEM = 'system';
// evaluate() runs again after each change, so chained transitions (delivered then
// in_inspection, or disputed then tier 2 then resolved) finish in one tick.
// The bound only stops a bug from looping.
const MAX_EVALUATION_PASSES = 12;
// A commit that loses an optimistic-version race is retried from fresh state.
const MAX_CONFLICT_RETRIES = 3;

interface Ctx {
  contract: Contract;
  now: number;
  audits: ContractAuditEntry[];
  newOperations: NewEscrowOperation[];
  operationUpdates: OperationUpdate[];
  evidence: Array<{record: EvidenceRecord; content: Uint8Array}>;
  publications: ReliabilityPublication[];
  action: ProcessedAction|null;
}

const emptyChain = (): ChainView => ({
  onChainState: null,
  confirmed: true,
  lastTxHash: null,
  resultHash: null,
  paidToSellerAtomic: null,
  paidToBuyerAtomic: null,
  settlementTxHash: null,
  syncedAt: null,
});

/** Bytes a party signs for one action. Evidence is bound by its SHA-256. */
export function partyActionBytes(action: PartyAction): string {
  return canonicalize({
    schema: 'contract-party-action.v1',
    actionId: action.actionId,
    contractId: action.contractId,
    milestoneId: action.milestoneId,
    partyId: action.partyId,
    action: action.action,
    reason: action.reason ?? null,
    evidence: (action.evidence ?? []).map((item) => ({
      type: item.type,
      mediaType: item.mediaType ?? 'application/octet-stream',
      sha256: sha256Hex(item.content),
      signerId: item.signer?.id ?? null,
      signerSignatureHex: item.signer?.signatureHex ?? null,
    })),
  });
}

export function outcomeAgreementBytes(contractId: string, milestoneId: string, outcome: NegotiatedOutcome): string {
  return canonicalize({schema: 'contract-outcome-agreement.v1', contractId, milestoneId, outcome});
}

export function mutualTerminationBytes(contractId: string, milestoneId: string): string {
  return canonicalize({schema: 'contract-mutual-termination.v1', contractId, milestoneId});
}

export function mediatorRulingBytes(contractId: string, milestoneId: string, ruling: MediatorRuling): string {
  return canonicalize({schema: 'contract-mediator-ruling.v1', contractId, milestoneId, winner: ruling.winner, reason: ruling.reason});
}

export class ContractLifecycle {
  private readonly store: ContractStore;
  private readonly escrow: ContractEscrow;
  private readonly clock: ContractClock;
  private readonly templates: TemplateRegistry;
  private readonly settings: ContractSettings;
  private runningTick: Promise<void>|null = null;

  constructor(options: {
    store: ContractStore;
    escrow: ContractEscrow;
    clock: ContractClock;
    templates: TemplateRegistry;
    settings: ContractSettings;
  }) {
    if (options.escrow.mode !== options.settings.mode) {
      throw new Error(`escrow mode ${options.escrow.mode} does not match the configured mode ${options.settings.mode}`);
    }
    this.store = options.store;
    this.escrow = options.escrow;
    this.clock = options.clock;
    this.templates = options.templates;
    this.settings = options.settings;
  }

  get mode(): ContractMode {
    return this.settings.mode;
  }

  // ===========================================================================
  // Reads
  // ===========================================================================

  getContract(id: string): Contract {
    const contract = this.store.getContract(id);
    if (!contract) throw new ContractError('not_found', `unknown contract ${id}`);
    return contract;
  }

  audit(contractId: string): ContractAuditRow[] {
    return this.store.listContractAudit(contractId);
  }

  operations(contractId: string): EscrowOperation[] {
    return this.store.listOperations(contractId);
  }

  /** Exact bytes both parties sign to accept the terms. */
  termsBytes(contractId: string): string {
    const contract = this.getContract(contractId);
    if (!contract.termsSha256) {
      throw new ContractError('terms_not_frozen', 'submit the contract for acceptance to freeze the terms');
    }
    return canonicalize(contract.terms);
  }

  // ===========================================================================
  // Creation and acceptance
  // ===========================================================================

  createContract(input: CreateContractInput, actorId: string): Contract {
    const now = this.clock.now();
    const template = this.templates.get(input.templateId);
    if (!template) throw new ContractError('not_found', `unknown template ${input.templateId}`);
    if (template.status !== 'enabled') throw new ContractError('template_not_enabled', `template ${template.id} is ${template.status}`);
    const buyer = this.party(input.buyerId);
    const seller = this.party(input.sellerId);
    if (buyer.id === seller.id) throw new ContractError('invalid_parties', 'the buyer and the seller must be different entities');
    if (buyer.cardanoAddress === seller.cardanoAddress) {
      throw new ContractError('invalid_parties', 'the buyer and the seller must use different addresses');
    }
    if (actorId !== buyer.id && actorId !== seller.id) throw new ContractError('forbidden', 'only a party can create the contract');
    if (input.milestones.length < 1 || input.milestones.length > template.milestones.maxMilestones) {
      throw new ContractError('invalid_milestones', `the template allows 1 to ${template.milestones.maxMilestones} milestones`);
    }

    const remedy = input.remedy ?? template.remedy.default;
    if (!template.remedy.allowed.includes(remedy.type)) {
      throw new ContractError('remedy_not_allowed', `template ${template.id} does not allow ${remedy.type}`);
    }
    validateRemedy(remedy);

    const whitelist = input.inspectorWhitelist ?? [];
    for (const inspector of whitelist) {
      if (!isPublicKeyHex(inspector.publicKeyHex)) throw new ContractError('invalid_key', `inspector ${inspector.id} has an invalid key`);
    }
    const signedEvidence = [...template.delivery.requiredEvidence, ...template.dispute.buyerEvidence].some((rule) => rule.signedBy);
    if ((signedEvidence || template.judge.type === 'signed_report') && whitelist.length === 0) {
      throw new ContractError('inspectors_required', `template ${template.id} needs a pre-agreed inspector whitelist`);
    }
    let judgeInspectorId: string|null = null;
    if (template.judge.type === 'signed_report') {
      judgeInspectorId = input.judgeInspectorId ?? null;
      if (!judgeInspectorId || !whitelist.some((inspector) => inspector.id === judgeInspectorId)) {
        throw new ContractError('judge_required', 'name the judging inspector (judgeInspectorId) from the whitelist');
      }
    }
    if (template.dispute.tiers.includes(3) && !this.settings.mediator) {
      throw new ContractError('mediator_required', 'the template uses Tier 3, but no platform mediator key is configured');
    }

    const windows = effectiveWindows(template.windows, this.settings.windowOverrides);
    assertDisputeBudget(windows, remedy, template.dispute.tiers);

    const contractId = randomUUID();
    const milestones = input.milestones.map((item, index): Milestone => {
      if (!/^[1-9][0-9]*$/.test(item.amountAtomic)) {
        throw new ContractError('invalid_amount', `milestone ${index}: amountAtomic must be a positive integer string`);
      }
      const problems = deliverableProblems(item.deliverable, template.deliverableSpecSchema);
      if (problems.length > 0) throw new ContractError('invalid_deliverable', `milestone ${index}: ${problems.join('; ')}`);
      const layout = trancheLayout(BigInt(item.amountAtomic), remedy);
      if (layout.length > this.settings.maxTranchesPerMilestone) {
        throw new ContractError(
          'too_many_tranches',
          `${remedy.type} needs ${layout.length} escrows for each milestone; the limit is ${this.settings.maxTranchesPerMilestone}`,
        );
      }
      return {
        id: randomUUID(),
        index,
        title: item.title,
        amountAtomic: item.amountAtomic,
        deliverable: item.deliverable,
        state: 'draft',
        history: [{at: now, event: 'created', from: null, to: 'draft', actor: actorId}],
        tranches: layout.map((slot): Tranche => ({
          id: randomUUID(),
          role: slot.role,
          amountAtomic: slot.amountAtomic,
          identifierFromPurchaser: null,
          inputHash: null,
          escrowRef: null,
          escrowTerms: null,
          resultHash: null,
          chain: emptyChain(),
        })),
        deadlines: null,
        createdAt: now,
        fundingRequestedAt: null,
        fundedAt: null,
        evidenceSubmittedAt: null,
        deliveredAt: null,
        inspectionCutoffAt: null,
        buyerAcceptedAt: null,
        disputedAt: null,
        resolvedAt: null,
        settledAt: null,
        pending: null,
        deliveryEvidenceIds: [],
        disputeEvidenceIds: [],
        resultManifest: null,
        dispute: {
          tierReached: 0,
          tierDeadline: null,
          ruling: null,
          redoUsed: false,
          returnOrdered: false,
          returnShipmentEvidenceId: null,
          followUpDeadline: null,
          obligations: [],
          executedBy: null,
        },
        outcome: null,
        fee: null,
        closedReason: null,
      };
    });

    const terms: ContractTerms = {
      schema: 'contract-terms.v1',
      contractId,
      mode: this.settings.mode,
      custodyModel: this.settings.custodyModel,
      network: 'Preprod',
      assetUnit: this.settings.assetUnit,
      assetDecimals: this.settings.assetDecimals,
      template: {id: template.id, version: template.version, category: template.category, transactionType: template.transactionType},
      judge: template.judge,
      judgeInspectorId,
      inspectorWhitelist: whitelist,
      mediator: this.settings.mediator,
      windows,
      remedy,
      fees: template.fees,
      delivery: template.delivery,
      dispute: template.dispute,
      fundingSchedule: template.milestones.fundingSchedule,
      buyer,
      seller,
      milestones: milestones.map((milestone) => ({
        id: milestone.id,
        index: milestone.index,
        title: milestone.title,
        amountAtomic: milestone.amountAtomic,
        deliverable: milestone.deliverable,
        tranches: milestone.tranches.map((tranche) => ({id: tranche.id, role: tranche.role, amountAtomic: tranche.amountAtomic})),
      })),
    };

    const contract: Contract = {
      id: contractId,
      version: 0,
      mode: this.settings.mode,
      templateId: template.id,
      category: template.category,
      buyerId: buyer.id,
      sellerId: seller.id,
      createdAt: now,
      createdBy: actorId,
      terms,
      termsSha256: null,
      signatures: {},
      milestones,
    };
    const ctx = this.newCtx(contract, now);
    this.note(ctx, null, 'contract_created', actorId, {templateId: template.id, remedy, windows, milestones: milestones.length});
    for (const milestone of milestones) {
      this.note(ctx, milestone, 'milestone_created', actorId, {
        amountAtomic: milestone.amountAtomic,
        tranches: milestone.tranches.map((tranche) => ({id: tranche.id, role: tranche.role, amountAtomic: tranche.amountAtomic})),
      }, null, 'draft');
    }
    this.commit(ctx, true);
    return contract;
  }

  /** A party signs the frozen terms. The signature is over termsBytes(). */
  signTerms(contractId: string, partyId: string, signatureHex: string): Contract {
    return this.mutate(contractId, (ctx) => {
      const contract = ctx.contract;
      const side = this.sideOf(contract, partyId);
      for (const milestone of contract.milestones) this.assertCan(milestone, 'all_parties_signed');
      if (contract.signatures[partyId] === signatureHex) return; // repeated call
      const party = side === 'buyer' ? contract.terms.buyer : contract.terms.seller;
      if (!verifyBytes(party.publicKeyHex, canonicalize(contract.terms), signatureHex)) {
        throw new ContractError('bad_signature', `the signature of ${partyId} does not match the frozen terms`);
      }
      contract.signatures[partyId] = signatureHex;
      this.note(ctx, null, 'terms_signed', partyId, {side, termsSha256: contract.termsSha256});
      if (!contract.signatures[contract.buyerId] || !contract.signatures[contract.sellerId]) return;
      for (const milestone of contract.milestones) {
        this.transition(ctx, milestone, 'all_parties_signed', partyId, {});
        this.publish(ctx, milestone);
      }
      const toFund = contract.terms.fundingSchedule === 'upfront' ? contract.milestones : [contract.milestones[0]];
      for (const milestone of toFund) if (milestone) this.requestFunding(ctx, milestone);
    });
  }

  /** Signed party action. A replayed `actionId` with the same bytes returns the current contract. */
  perform(action: PartyAction, signatureHex: string): Contract {
    const bytes = partyActionBytes(action);
    const bytesSha256 = sha256Hex(bytes);
    const processed = this.store.getProcessedAction(action.actionId);
    if (processed) {
      if (processed.bytesSha256 !== bytesSha256 || processed.contractId !== action.contractId) {
        throw new ContractError('action_id_reused', `action id ${action.actionId} was used for a different action`);
      }
      return this.getContract(action.contractId);
    }
    if (!/^[0-9a-f-]{16,64}$/i.test(action.actionId)) throw new ContractError('invalid_action', 'actionId must be a UUID');
    for (const item of action.evidence ?? []) {
      const size = typeof item.content === 'string' ? Buffer.byteLength(item.content, 'utf8') : item.content.byteLength;
      if (size > this.settings.maxEvidenceBytes) {
        throw new ContractError('evidence_too_large', `${item.type} is ${size} bytes; the limit is ${this.settings.maxEvidenceBytes}`);
      }
    }
    return this.mutate(action.contractId, (ctx) => {
      const contract = ctx.contract;
      const side = this.sideOf(contract, action.partyId);
      const party = side === 'buyer' ? contract.terms.buyer : contract.terms.seller;
      if (!verifyBytes(party.publicKeyHex, bytes, signatureHex)) {
        throw new ContractError('bad_signature', `the signature of ${action.partyId} does not match the action`);
      }
      ctx.action = {actionId: action.actionId, contractId: contract.id, partyId: action.partyId, bytesSha256, processedAt: ctx.now};
      this.dispatch(ctx, action, side);
    });
  }

  private dispatch(ctx: Ctx, action: PartyAction, side: Side): void {
    const contract = ctx.contract;
    const actor = action.partyId;
    if (action.action === 'submit_for_acceptance') return this.submitForAcceptance(ctx, actor);
    if (action.action === 'cancel') return this.cancel(ctx, actor, action.reason ?? 'cancelled by a party');
    const milestone = this.milestone(contract, action.milestoneId);
    const evidence = action.evidence ?? [];
    switch (action.action) {
      case 'deliver':
        this.requireSide(side, 'seller');
        return this.deliver(ctx, milestone, actor, evidence);
      case 'accept':
        this.requireSide(side, 'buyer');
        return this.accept(ctx, milestone, actor);
      case 'dispute':
        this.requireSide(side, 'buyer');
        return this.dispute(ctx, milestone, actor, evidence);
      case 'concede_refund':
        this.requireSide(side, 'seller');
        return this.concedeRefund(ctx, milestone, actor);
      case 'escalate':
        return this.escalate(ctx, milestone, actor);
      case 'submit_judge_report':
        return this.submitJudgeReport(ctx, milestone, actor, evidence);
      case 'comply_with_ruling':
        return this.complyWithRuling(ctx, milestone, actor, side);
      case 'record_return_shipment':
        this.requireSide(side, 'buyer');
        return this.recordReturnShipment(ctx, milestone, actor, evidence);
      case 'confirm_return_received':
        this.requireSide(side, 'seller');
        return this.confirmReturnReceived(ctx, milestone, actor);
      case 'redeliver':
        this.requireSide(side, 'seller');
        return this.redeliver(ctx, milestone, actor, evidence);
      case 'accept_redo':
        this.requireSide(side, 'buyer');
        return this.acceptRedo(ctx, milestone, actor);
      case 'reject_redo':
        this.requireSide(side, 'buyer');
        return this.rejectRedo(ctx, milestone, actor);
      default:
        throw new ContractError('invalid_action', `unknown action ${String(action.action)}`);
    }
  }

  private submitForAcceptance(ctx: Ctx, actor: string): void {
    for (const milestone of ctx.contract.milestones) this.assertCan(milestone, 'submit_for_acceptance');
    ctx.contract.termsSha256 = sha256Hex(canonicalize(ctx.contract.terms));
    for (const milestone of ctx.contract.milestones) {
      this.transition(ctx, milestone, 'submit_for_acceptance', actor, {termsSha256: ctx.contract.termsSha256});
    }
  }

  private cancel(ctx: Ctx, actor: string, reason: string): void {
    const contract = ctx.contract;
    for (const milestone of contract.milestones) this.assertCan(milestone, 'cancel');
    const operations = this.store.listOperations(contract.id);
    if (operations.some((operation) => operation.kind === 'lock_funds' && (operation.attempts > 0 || operation.status === 'done'))) {
      throw new ContractError(
        'funding_in_flight',
        'a funding transaction was sent; the milestone will fund or expire, so it cannot be cancelled now',
      );
    }
    for (const operation of operations) {
      if (operation.status === 'pending') {
        ctx.operationUpdates.push({id: operation.id, status: 'cancelled', lastError: 'contract cancelled before funding'});
      }
    }
    for (const milestone of contract.milestones) {
      if (TERMINAL_STATES.has(milestone.state)) continue; // a sequential cascade closed it already
      milestone.closedReason = 'cancelled_by_party';
      this.settle(ctx, milestone, 'cancel', 'CANCELLED', actor, {reason});
    }
  }

  // ===========================================================================
  // Delivery, inspection, dispute
  // ===========================================================================

  private deliver(ctx: Ctx, milestone: Milestone, actor: string, items: EvidenceInput[]): void {
    this.assertCan(milestone, 'delivery_confirmed');
    this.assertNoPending(milestone);
    if (ctx.now >= this.deadlines(milestone).submitResultTime) {
      throw new ContractError('deadline_passed', 'the delivery deadline (submitResultTime) has passed');
    }
    const records = this.storeEvidence(ctx, milestone, actor, items, ctx.contract.terms.delivery.requiredEvidence, 'delivery');
    milestone.deliveryEvidenceIds = records.map((record) => record.id);
    this.postResult(ctx, milestone, records, 'delivery-manifest.v1', 'delivery', actor);
  }

  private accept(ctx: Ctx, milestone: Milestone, actor: string): void {
    this.assertCan(milestone, 'buyer_accepted');
    this.assertNoPending(milestone);
    if (ctx.now >= (milestone.inspectionCutoffAt ?? 0)) {
      throw new ContractError('inspection_closed', 'the inspection window has closed');
    }
    milestone.buyerAcceptedAt = ctx.now;
    this.transition(ctx, milestone, 'buyer_accepted', actor, {
      note: 'acceptance is off-chain; the escrow releases at unlockTime',
      unlockTime: this.deadlines(milestone).unlockTime,
    });
  }

  private dispute(ctx: Ctx, milestone: Milestone, actor: string, items: EvidenceInput[]): void {
    this.assertCan(milestone, 'dispute_confirmed');
    this.assertNoPending(milestone);
    if (ctx.now >= (milestone.inspectionCutoffAt ?? 0)) {
      throw new ContractError('inspection_closed', 'the inspection window has closed');
    }
    if (items.length === 0) throw new ContractError('evidence_required', 'a dispute needs counter-evidence');
    const records = this.storeEvidence(ctx, milestone, actor, items, ctx.contract.terms.dispute.buyerEvidence, 'dispute');
    milestone.disputeEvidenceIds.push(...records.map((record) => record.id));
    for (const tranche of milestone.tranches) this.enqueue(ctx, milestone, tranche, 'request_refund', {});
    milestone.pending = {kind: 'dispute', since: ctx.now};
    this.note(ctx, milestone, 'dispute_requested', actor, {
      evidence: records.map((record) => ({id: record.id, type: record.type, sha256: record.sha256})),
    });
  }

  /** The seller refunds outside a dispute. The outcome is REFUNDED after the refund confirms. */
  private concedeRefund(ctx: Ctx, milestone: Milestone, actor: string): void {
    this.assertCan(milestone, 'refund_confirmed');
    this.assertNoPending(milestone);
    this.assertRefundWindow(ctx, milestone);
    milestone.pending = {kind: 'concession', since: ctx.now};
    this.driveRefunds(ctx, milestone);
    this.note(ctx, milestone, 'refund_conceded', actor, {});
  }

  /** Both parties end a funded milestone. The seller's consent authorizes the refund. */
  mutualTerminate(contractId: string, milestoneId: string, buyerSignatureHex: string, sellerSignatureHex: string): Contract {
    return this.mutate(contractId, (ctx) => {
      const contract = ctx.contract;
      const milestone = this.milestone(contract, milestoneId);
      this.assertCan(milestone, 'mutual_termination_confirmed');
      this.assertNoPending(milestone);
      this.assertRefundWindow(ctx, milestone);
      const bytes = mutualTerminationBytes(contract.id, milestone.id);
      if (!verifyBytes(contract.terms.buyer.publicKeyHex, bytes, buyerSignatureHex)) {
        throw new ContractError('bad_signature', 'the buyer signature does not match the termination');
      }
      if (!verifyBytes(contract.terms.seller.publicKeyHex, bytes, sellerSignatureHex)) {
        throw new ContractError('bad_signature', 'the seller signature does not match the termination');
      }
      milestone.pending = {kind: 'termination', since: ctx.now};
      this.driveRefunds(ctx, milestone);
      this.note(ctx, milestone, 'mutual_termination_requested', 'parties', {buyerSignatureHex, sellerSignatureHex});
    });
  }

  private assertRefundWindow(ctx: Ctx, milestone: Milestone): void {
    if (ctx.now >= this.deadlines(milestone).unlockTime && milestone.tranches.some((tranche) =>
      tranche.chain.onChainState === 'FundsLocked' || tranche.chain.onChainState === 'ResultSubmitted')) {
      throw new ContractError('deadline_passed', 'the refund request must reach the escrow before unlockTime');
    }
  }

  /** The buyer requests a refund. The seller authorizes it after confirmation. */
  private driveRefunds(ctx: Ctx, milestone: Milestone): void {
    for (const tranche of milestone.tranches) {
      if (!tranche.chain.confirmed) continue;
      const state = tranche.chain.onChainState;
      if ((state === 'FundsLocked' || state === 'ResultSubmitted') && ctx.now < this.deadlines(milestone).unlockTime) {
        this.enqueue(ctx, milestone, tranche, 'request_refund', {});
      } else if (state === 'RefundRequested' || state === 'Disputed') {
        this.enqueue(ctx, milestone, tranche, 'authorize_refund', {});
      }
    }
  }

  // ===========================================================================
  // Dispute tiers
  // ===========================================================================

  private escalate(ctx: Ctx, milestone: Milestone, actor: string): void {
    if (milestone.state !== 'tier_1_negotiation') {
      throw new ContractError(
        'escalation_not_allowed',
        `a party can leave tier_1_negotiation only (current state: ${milestone.state}); later tiers escalate at their deadline`,
      );
    }
    this.assertBeforeDeadline(ctx, milestone.dispute.tierDeadline, 'Tier 1');
    this.escalateFrom(ctx, milestone, 1, actor, 'party_escalated');
  }

  /** Tier 1: both parties sign one fixed outcome. Both signatures also carry out the payout. */
  agreeOutcome(
    contractId: string, milestoneId: string, outcome: NegotiatedOutcome,
    buyerSignatureHex: string, sellerSignatureHex: string,
  ): Contract {
    return this.mutate(contractId, (ctx) => {
      const contract = ctx.contract;
      const milestone = this.milestone(contract, milestoneId);
      if (milestone.state !== 'tier_1_negotiation') throw new IllegalTransitionError(milestone.state, 'ruling_issued');
      this.assertBeforeDeadline(ctx, milestone.dispute.tierDeadline, 'Tier 1');
      const decisions = decisionsForOutcome(outcome, milestone.tranches);
      const bytes = outcomeAgreementBytes(contract.id, milestone.id, outcome);
      if (!verifyBytes(contract.terms.buyer.publicKeyHex, bytes, buyerSignatureHex)) {
        throw new ContractError('bad_signature', 'the buyer signature does not match the outcome');
      }
      if (!verifyBytes(contract.terms.seller.publicKeyHex, bytes, sellerSignatureHex)) {
        throw new ContractError('bad_signature', 'the seller signature does not match the outcome');
      }
      this.applyRuling(ctx, milestone, {
        tier: 1,
        winner: winnerOfOutcome(outcome),
        decidedBy: 'parties',
        reason: `negotiated outcome ${outcome}, signed by both parties`,
        final: true,
        trancheDecisions: decisions,
        at: ctx.now,
      }, 'ruling_issued', 'parties', ['buyer', 'seller']);
    });
  }

  private submitJudgeReport(ctx: Ctx, milestone: Milestone, actor: string, items: EvidenceInput[]): void {
    if (milestone.state !== 'tier_2_evidence_rule') throw new IllegalTransitionError(milestone.state, 'judge report');
    this.assertBeforeDeadline(ctx, milestone.dispute.tierDeadline, 'Tier 2');
    const judge = ctx.contract.terms.judge;
    if (judge.type !== 'signed_report') throw new ContractError('wrong_judge', `the judge of this contract is ${judge.type}`);
    const rule: EvidenceRule = {type: judge.reportEvidenceType, min: 1, max: 1, signedBy: 'named_inspector'};
    const records = this.storeEvidence(ctx, milestone, actor, items, [rule], 'tier_2_report');
    milestone.disputeEvidenceIds.push(...records.map((record) => record.id));
    this.runTier2(ctx, milestone);
  }

  submitMediatorRuling(contractId: string, milestoneId: string, ruling: MediatorRuling, signatureHex: string): Contract {
    return this.mutate(contractId, (ctx) => {
      const contract = ctx.contract;
      const milestone = this.milestone(contract, milestoneId);
      if (milestone.state !== 'tier_3_mediation') throw new IllegalTransitionError(milestone.state, 'ruling_issued');
      this.assertBeforeDeadline(ctx, milestone.dispute.tierDeadline, 'Tier 3');
      const mediator = contract.terms.mediator;
      if (!mediator) throw new ContractError('mediator_required', 'this contract has no mediator');
      if (ruling.winner !== 'buyer' && ruling.winner !== 'seller') {
        throw new ContractError('invalid_ruling', 'the mediator names a winner: buyer or seller');
      }
      if (!verifyBytes(mediator.publicKeyHex, mediatorRulingBytes(contract.id, milestone.id, ruling), signatureHex)) {
        throw new ContractError('bad_signature', 'the mediator signature does not match the ruling');
      }
      this.applyRuling(ctx, milestone, {
        tier: 3,
        winner: ruling.winner,
        decidedBy: `mediator:${mediator.id}`,
        reason: ruling.reason,
        final: false,
        trancheDecisions: null,
        at: ctx.now,
      });
    });
  }

  private recordReturnShipment(ctx: Ctx, milestone: Milestone, actor: string, items: EvidenceInput[]): void {
    if (milestone.state !== 'return_pending') throw new IllegalTransitionError(milestone.state, 'return shipment');
    this.assertBeforeDeadline(ctx, milestone.dispute.followUpDeadline, 'return');
    const [record] = this.storeEvidence(ctx, milestone, actor, items, [{type: RETURN_TRACKING_EVIDENCE, min: 1, max: 1}], 'return');
    if (!record) throw new ContractError('evidence_required', 'send the return tracking evidence');
    milestone.dispute.returnShipmentEvidenceId = record.id;
    this.note(ctx, milestone, 'return_shipped', actor, {evidenceId: record.id, sha256: record.sha256});
  }

  private confirmReturnReceived(ctx: Ctx, milestone: Milestone, actor: string): void {
    this.assertCan(milestone, 'return_receipt_confirmed');
    this.assertBeforeDeadline(ctx, milestone.dispute.followUpDeadline, 'return');
    // Confirming receipt is the seller's instruction to refund.
    this.applyRuling(ctx, milestone, this.ruling(ctx, milestone, 'buyer', 'seller', 'the seller confirmed receipt of the returned goods', true),
      'return_receipt_confirmed', actor, ['seller']);
  }

  private redeliver(ctx: Ctx, milestone: Milestone, actor: string, items: EvidenceInput[]): void {
    this.assertCan(milestone, 'redelivery_confirmed');
    this.assertNoPending(milestone);
    if (ctx.now >= (milestone.dispute.followUpDeadline ?? 0)) throw new ContractError('deadline_passed', 'the redo deadline has passed');
    const records = this.storeEvidence(ctx, milestone, actor, items, ctx.contract.terms.delivery.requiredEvidence, 'redelivery');
    milestone.deliveryEvidenceIds = records.map((record) => record.id);
    this.postResult(ctx, milestone, records, 'redelivery-manifest.v1', 'redelivery', actor);
  }

  private acceptRedo(ctx: Ctx, milestone: Milestone, actor: string): void {
    this.assertCan(milestone, 'redo_accepted');
    this.assertBeforeDeadline(ctx, milestone.dispute.followUpDeadline, 'redo inspection');
    milestone.buyerAcceptedAt = ctx.now;
    // Accepting the redo is the buyer's instruction to release.
    this.applyRuling(ctx, milestone, this.ruling(ctx, milestone, 'seller', 'buyer', 'the buyer accepted the redelivery', true),
      'redo_accepted', actor, ['buyer']);
  }

  private rejectRedo(ctx: Ctx, milestone: Milestone, actor: string): void {
    this.assertCan(milestone, 'redo_rejected');
    this.assertBeforeDeadline(ctx, milestone.dispute.followUpDeadline, 'redo inspection');
    this.applyRuling(ctx, milestone,
      this.ruling(ctx, milestone, 'buyer', 'buyer', 'the buyer rejected the redelivery; the one retry is used', true),
      'redo_rejected', actor);
  }

  /**
   * The obligated party carries out the ruling: the buyer authorizes the
   * release of `release` tranches, the seller authorizes the refund of
   * `refund` tranches. A late action counts as a missed deadline.
   */
  private complyWithRuling(ctx: Ctx, milestone: Milestone, actor: string, side: Side): void {
    if (milestone.state !== 'resolved') throw new IllegalTransitionError(milestone.state, 'ruling compliance');
    const obligation = milestone.dispute.obligations.find(
      (item) => item.party === side && item.compliedAt === null && item.forcedAt === null,
    );
    if (!obligation) throw new ContractError('nothing_to_comply', `the ${side} has no open obligation under this ruling`);
    this.executeObligation(ctx, milestone, obligation, 'complied', actor);
  }

  // ===========================================================================
  // Engine: external writes, chain sync, deadlines
  // ===========================================================================

  /**
   * One scheduler pass. Safe after a restart. Calls in the same process
   * share the pass in flight, so one operation is never sent twice in
   * parallel. Leases protect against a second process.
   */
  tick(): Promise<void> {
    if (!this.runningTick) {
      this.runningTick = (async () => {
        try {
          await this.processOperations();
          for (const id of this.store.listContractIds({openOnly: true})) await this.sync(id);
          await this.processOperations();
        } finally {
          this.runningTick = null;
        }
      })();
    }
    return this.runningTick;
  }

  async processOperations(): Promise<void> {
    const blocked = new Set<string>();
    for (const listed of this.store.listPendingOperations()) {
      if (blocked.has(listed.trancheId)) continue; // keep the order of writes on one escrow
      const contract = this.store.getContract(listed.contractId);
      const tranche = contract?.milestones.find((item) => item.id === listed.milestoneId)
        ?.tranches.find((item) => item.id === listed.trancheId);
      if (!contract || !tranche || contract.mode !== this.escrow.mode) {
        blocked.add(listed.trancheId);
        continue;
      }
      const now = this.clock.now();
      const operation = this.store.claimOperation(listed.id, this.settings.workerId, now, now + this.settings.operationLeaseMs);
      if (!operation) {
        blocked.add(listed.trancheId); // another worker holds the lease
        continue;
      }
      const request: EscrowRequest = {
        kind: operation.kind,
        idempotencyKey: operation.idempotencyKey,
        ref: operation.kind === 'create_terms' ? null : tranche.escrowRef,
        terms: operation.kind === 'create_terms' ? null : tranche.escrowTerms,
        payload: operation.payload,
      };
      if (operation.attempts > 0) {
        // The earlier attempt has an unknown result. Inspect first; never retry blindly.
        let found;
        try {
          found = await this.escrow.inspect(request);
        } catch (error) {
          this.store.releaseOperation(operation.id, `inspect failed: ${message(error)}`, this.clock.now());
          blocked.add(operation.trancheId);
          continue;
        }
        if (found.status === 'applied') {
          this.completeOperation(operation, found.ref ?? request.ref, found.terms ?? null, 'recovered: applied before a restart or timeout');
          continue;
        }
        if (found.status === 'unknown') {
          this.store.releaseOperation(operation.id, 'inspection was inconclusive; no retry until the rail answers', this.clock.now());
          blocked.add(operation.trancheId);
          continue;
        }
      }
      try {
        const result = await this.escrow.execute(request);
        this.completeOperation(operation, result.ref ?? request.ref, result.terms ?? null, null);
      } catch (error) {
        if (error instanceof EscrowRejectedError) {
          this.failOperation(operation, error.message);
        } else {
          this.store.releaseOperation(operation.id, message(error), this.clock.now());
          blocked.add(operation.trancheId);
        }
      }
    }
  }

  private completeOperation(
    operation: EscrowOperation, ref: string|null, terms: {[key: string]: string|number|boolean|null}|null, note: string|null,
  ): void {
    this.mutate(operation.contractId, (ctx) => {
      const milestone = this.milestone(ctx.contract, operation.milestoneId);
      const tranche = this.tranche(milestone, operation.trancheId);
      if (operation.kind === 'create_terms') {
        if (!ref) throw new Error('create_terms finished without an escrow reference');
        tranche.escrowRef = ref;
        tranche.escrowTerms = terms;
        this.enqueue(ctx, milestone, tranche, 'lock_funds', {});
      }
      ctx.operationUpdates.push({id: operation.id, status: 'done', result: {ref}});
      this.note(ctx, milestone, 'escrow_operation_sent', SYSTEM, {
        kind: operation.kind, trancheId: tranche.id, ref, note, attempts: operation.attempts + 1,
      });
    });
  }

  private failOperation(operation: EscrowOperation, reason: string): void {
    this.mutate(operation.contractId, (ctx) => {
      const milestone = this.milestone(ctx.contract, operation.milestoneId);
      ctx.operationUpdates.push({id: operation.id, status: 'failed', lastError: reason});
      const needsOperator = operation.kind === 'authorize_refund' || operation.kind === 'authorize_withdrawal';
      this.note(ctx, milestone, 'escrow_operation_rejected', SYSTEM, {kind: operation.kind, trancheId: operation.trancheId, reason, needsOperator});
      if (operation.kind === 'lock_funds') milestone.closedReason = 'funding_rejected_by_rail';
      // A rejected result lets the seller try again while time remains.
      if (operation.kind === 'submit_result' && (milestone.pending?.kind === 'delivery' || milestone.pending?.kind === 'redelivery')) {
        milestone.pending = null;
      }
    });
  }

  private async sync(contractId: string): Promise<void> {
    const contract = this.getContract(contractId);
    if (contract.mode !== this.escrow.mode) return; // never touch the other rail's contracts
    const statuses = new Map<string, EscrowStatus>();
    for (const milestone of contract.milestones) {
      if (TERMINAL_STATES.has(milestone.state)) continue;
      for (const tranche of milestone.tranches) {
        if (!tranche.escrowRef) continue;
        try {
          statuses.set(tranche.id, await this.escrow.status(tranche.escrowRef, tranche.escrowTerms));
        } catch {
          // Keep the last known view. The next tick tries again.
        }
      }
    }
    this.mutate(contractId, (ctx) => {
      for (const milestone of ctx.contract.milestones) {
        if (TERMINAL_STATES.has(milestone.state)) continue;
        for (const tranche of milestone.tranches) {
          const status = statuses.get(tranche.id);
          if (status && !sameChain(tranche.chain, status)) tranche.chain = {...status, syncedAt: ctx.now};
        }
        for (let pass = 0; pass < MAX_EVALUATION_PASSES && this.evaluate(ctx, milestone); pass++) {
          // evaluate() applies one change per pass.
        }
      }
    }, true);
  }

  /** Applies confirmed chain facts and deadlines. Returns true when the state changed. */
  private evaluate(ctx: Ctx, milestone: Milestone): boolean {
    if (TERMINAL_STATES.has(milestone.state)) return false;
    const terms = ctx.contract.terms;
    const windows = terms.windows;
    const now = ctx.now;
    const tranches = milestone.tranches;
    const allIn = (state: OnChainState) =>
      tranches.every((tranche) => tranche.chain.confirmed && tranche.chain.onChainState === state);
    const allPaidOut = tranches.every((tranche) =>
      tranche.chain.confirmed && tranche.chain.onChainState !== null && PAID_OUT_STATES.has(tranche.chain.onChainState));

    if (['concession', 'termination', 'expiry_unwind'].includes(milestone.pending?.kind ?? '')) {
      this.driveRefunds(ctx, milestone);
    }

    // Backstop: the Masumi admins settled a disputed escrow. Chain facts win.
    if (allPaidOut && tranches.some((tranche) => tranche.chain.onChainState === 'DisputedWithdrawn') &&
        canTransition(milestone.state, 'admin_settlement_confirmed')) {
      const toSeller = tranches.reduce((total, tranche) => total + BigInt(tranche.chain.paidToSellerAtomic ?? '0'), 0n);
      const toBuyer = tranches.reduce((total, tranche) => total + BigInt(tranche.chain.paidToBuyerAtomic ?? '0'), 0n);
      const winner: Winner = toSeller === 0n ? 'buyer' : toBuyer === 0n ? 'seller' : 'split';
      milestone.dispute.ruling = {
        tier: milestone.dispute.tierReached, winner, decidedBy: 'masumi_admins',
        reason: 'WithdrawDisputed observed on-chain', final: true, trancheDecisions: null, at: now,
      };
      milestone.dispute.executedBy = 'masumi_admins';
      milestone.fee = disputeFee(terms.fees, milestone.dispute.tierReached, winner);
      this.settle(ctx, milestone, 'admin_settlement_confirmed', 'RESOLVED', SYSTEM, {toSeller: toSeller.toString(), toBuyer: toBuyer.toString()});
      return true;
    }

    // A mutual termination ends when every escrow is refunded. A release that won the race wins.
    if (milestone.pending?.kind === 'termination' && allIn('RefundWithdrawn')) {
      milestone.closedReason = 'mutual_termination';
      this.settle(ctx, milestone, 'mutual_termination_confirmed', 'CANCELLED', SYSTEM, {});
      return true;
    }

    if (allPaidOut && (milestone.pending?.kind === 'concession' || milestone.pending?.kind === 'termination')) {
      const termination = milestone.pending.kind === 'termination';
      if (!allIn('Withdrawn')) {
        milestone.closedReason = allIn('RefundWithdrawn') ? 'seller_conceded' : 'refund_partially_executed';
        this.settle(ctx, milestone, termination ? 'mutual_termination_confirmed' : 'refund_confirmed',
          termination ? 'CANCELLED' : 'REFUNDED', SYSTEM, {reason: milestone.closedReason});
        return true;
      }
      milestone.closedReason = 'refund_lost_to_release';
      milestone.pending = null;
      this.note(ctx, milestone, 'refund_lost_to_release', SYSTEM, {termination});
      if (milestone.state === 'in_inspection') {
        this.transition(ctx, milestone, 'inspection_window_expired', SYSTEM, {reason: milestone.closedReason});
        return true;
      }
    }

    switch (milestone.state) {
      case 'awaiting_funding': {
        const deadlines = milestone.deadlines;
        if (!deadlines) return false; // a sequential milestone that is not funded yet
        if (allIn('FundsLocked')) {
          milestone.fundedAt = confirmedTime(tranches, ['FundsLocked']) ?? now;
          milestone.pending = null;
          this.transition(ctx, milestone, 'funding_confirmed', SYSTEM, {lockTxHashes: tranches.map((tranche) => tranche.chain.lastTxHash)});
          return true;
        }
        if (now < deadlines.payByTime) return false;
        const locked = tranches.filter((tranche) => tranche.chain.onChainState !== null);
        if (locked.length === 0) {
          if (this.hasPendingOperation(ctx, milestone, 'lock_funds')) return false;
          milestone.closedReason ??= 'not_funded_by_pay_by_time';
          this.settle(ctx, milestone, 'funding_deadline_passed', 'EXPIRED', SYSTEM, {reason: milestone.closedReason});
          return true;
        }
        // Some escrows locked and some did not: refund the locked ones, then expire.
        if (milestone.pending?.kind !== 'expiry_unwind') {
          milestone.pending = {kind: 'expiry_unwind', since: now};
          this.driveRefunds(ctx, milestone);
          this.note(ctx, milestone, 'partial_funding_unwind', SYSTEM, {locked: locked.map((tranche) => tranche.id)});
          return false;
        }
        if (locked.every((tranche) => tranche.chain.confirmed && tranche.chain.onChainState === 'RefundWithdrawn')) {
          milestone.closedReason = 'partially_funded_unwound';
          this.settle(ctx, milestone, 'funding_deadline_passed', 'EXPIRED', SYSTEM, {reason: milestone.closedReason});
          return true;
        }
        return false;
      }

      case 'funded': {
        if (milestone.pending?.kind === 'delivery' && tranches.every((tranche) =>
          tranche.chain.confirmed && ['ResultSubmitted', 'WithdrawAuthorized', 'Withdrawn'].includes(tranche.chain.onChainState ?? '') &&
          (tranche.chain.resultHash === tranche.resultHash || tranche.chain.history?.some((entry) =>
            entry.to === 'ResultSubmitted' && entry.resultHash === tranche.resultHash)))) {
          milestone.deliveredAt = confirmedTime(tranches, ['ResultSubmitted'], true) ?? now;
          milestone.pending = null;
          this.transition(ctx, milestone, 'delivery_confirmed', SYSTEM, {resultHashes: tranches.map((tranche) => tranche.resultHash)});
          const deadlines = this.deadlines(milestone);
          milestone.inspectionCutoffAt = inspectionCutoff(milestone.deliveredAt, windows, deadlines, this.settings.disputeSubmitSafetyMarginMs);
          this.transition(ctx, milestone, 'inspection_opened', SYSTEM, {inspectionCutoffAt: milestone.inspectionCutoffAt, unlockTime: deadlines.unlockTime});
          return true;
        }
        if (allIn('RefundWithdrawn')) {
          if (milestone.pending?.kind === 'concession') {
            milestone.closedReason = 'seller_conceded';
            this.settle(ctx, milestone, 'refund_confirmed', 'REFUNDED', SYSTEM, {});
          } else {
            milestone.closedReason = 'seller_missed_delivery_deadline';
            this.settle(ctx, milestone, 'delivery_deadline_refund_confirmed', 'EXPIRED', SYSTEM, {reason: milestone.closedReason});
          }
          return true;
        }
        return false;
      }

      case 'in_inspection': {
        if (milestone.pending?.kind === 'dispute' && tranches.every((tranche) => tranche.chain.confirmed) &&
            !this.hasPendingOperation(ctx, milestone, 'request_refund') &&
            tranches.some((tranche) => tranche.chain.onChainState === 'Disputed')) {
          milestone.disputedAt = now;
          milestone.pending = null;
          this.transition(ctx, milestone, 'dispute_confirmed', SYSTEM, {
            escrows: tranches.map((tranche) => ({id: tranche.id, state: tranche.chain.onChainState})),
            partial: !allIn('Disputed'),
          });
          const firstTier = terms.dispute.tiers[0];
          if (firstTier === undefined) throw new Error('the template lists no dispute tier');
          this.openTier(ctx, milestone, firstTier, SYSTEM);
          this.publish(ctx, milestone);
          return true;
        }
        if (milestone.pending?.kind === 'concession' && allIn('RefundWithdrawn')) {
          milestone.closedReason = 'seller_conceded';
          this.settle(ctx, milestone, 'refund_confirmed', 'REFUNDED', SYSTEM, {});
          return true;
        }
        if (now < (milestone.inspectionCutoffAt ?? Number.POSITIVE_INFINITY)) return false;
        if (milestone.pending === null) {
          this.transition(ctx, milestone, 'inspection_window_expired', SYSTEM, {
            inspectionCutoffAt: milestone.inspectionCutoffAt, unlockTime: this.deadlines(milestone).unlockTime,
          });
          return true;
        }
        // The dispute did not confirm before unlockTime. The chain is on the release path.
        if (milestone.pending.kind === 'dispute' && now >= this.deadlines(milestone).unlockTime &&
            !this.hasPendingOperation(ctx, milestone, 'request_refund') &&
            tranches.every((tranche) => tranche.chain.confirmed && tranche.chain.onChainState !== 'Disputed')) {
          milestone.pending = null;
          this.note(ctx, milestone, 'dispute_not_confirmed_before_unlock', SYSTEM, {});
          this.transition(ctx, milestone, 'inspection_window_expired', SYSTEM, {inspectionCutoffAt: milestone.inspectionCutoffAt});
          return true;
        }
        return false;
      }

      case 'accepted_pending_release':
      case 'auto_released': {
        if (allIn('Withdrawn')) {
          const outcome: SettlementOutcome = milestone.state === 'accepted_pending_release' ? 'ACCEPTED' : 'AUTO_RELEASED';
          if (milestone.pending?.kind === 'termination') this.note(ctx, milestone, 'termination_lost_to_release', SYSTEM, {});
          milestone.pending = null;
          this.settle(ctx, milestone, 'release_confirmed', outcome, SYSTEM, {});
          return true;
        }
        if (milestone.pending?.kind === 'concession' && allIn('RefundWithdrawn')) {
          milestone.closedReason = 'seller_conceded';
          this.settle(ctx, milestone, 'refund_confirmed', 'REFUNDED', SYSTEM, {});
          return true;
        }
        return false;
      }

      case 'tier_1_negotiation':
        if (now < (milestone.dispute.tierDeadline ?? Number.POSITIVE_INFINITY)) return false;
        this.escalateFrom(ctx, milestone, 1, SYSTEM, 'tier_1_deadline_passed');
        return true;

      case 'tier_2_evidence_rule':
        if (now < (milestone.dispute.tierDeadline ?? Number.POSITIVE_INFINITY)) return false;
        this.escalateFrom(ctx, milestone, 2, SYSTEM, 'tier_2_deadline_passed');
        return true;

      case 'tier_3_mediation':
        if (now < (milestone.dispute.tierDeadline ?? Number.POSITIVE_INFINITY)) return false;
        this.applyRuling(ctx, milestone, this.ruling(ctx, milestone, terms.dispute.tier3TimeoutWinner, 'mediator_timeout_default',
          'the mediator did not rule before the Tier 3 deadline; the template default applies', false));
        return true;

      case 'return_pending':
        if (now < (milestone.dispute.followUpDeadline ?? Number.POSITIVE_INFINITY)) return false;
        if (milestone.dispute.returnShipmentEvidenceId) {
          // The buyer shipped and the seller did not confirm: the mediator decides on the tracking evidence.
          milestone.dispute.tierReached = 3;
          milestone.dispute.tierDeadline = now + windows.tier3WindowMs;
          milestone.dispute.followUpDeadline = null;
          this.transition(ctx, milestone, 'return_unconfirmed', SYSTEM, {tierDeadline: milestone.dispute.tierDeadline});
        } else {
          this.applyRuling(ctx, milestone, this.ruling(ctx, milestone, 'seller', 'return_deadline_default',
            'the buyer did not ship the return before the deadline', true), 'return_not_shipped');
        }
        return true;

      case 'redo_pending':
        if (milestone.pending?.kind === 'redelivery' && tranches.every((tranche) =>
          tranche.chain.confirmed && tranche.chain.onChainState === 'Disputed' && tranche.chain.resultHash === tranche.resultHash)) {
          milestone.pending = null;
          milestone.deliveredAt = now;
          milestone.dispute.followUpDeadline = Math.min(
            now + windows.redoInspectionWindowMs,
            this.deadlines(milestone).externalDisputeUnlockTime - this.settings.disputeSubmitSafetyMarginMs,
          );
          this.transition(ctx, milestone, 'redelivery_confirmed', SYSTEM, {inspectionDeadline: milestone.dispute.followUpDeadline});
          return true;
        }
        if (milestone.pending === null && now >= (milestone.dispute.followUpDeadline ?? Number.POSITIVE_INFINITY)) {
          this.applyRuling(ctx, milestone, this.ruling(ctx, milestone, 'buyer', 'redo_deadline_default',
            'the seller did not redeliver before the redo deadline', true), 'redo_deadline_passed');
          return true;
        }
        return false;

      case 'redo_inspection':
        if (now < (milestone.dispute.followUpDeadline ?? Number.POSITIVE_INFINITY)) return false;
        this.applyRuling(ctx, milestone, this.ruling(ctx, milestone, 'seller', 'redo_inspection_default',
          'the buyer did not reject the redelivery in time', true), 'redo_inspection_expired');
        return true;

      case 'resolved': {
        if (allPaidOut) {
          milestone.dispute.executedBy = milestone.dispute.obligations.some((item) => item.forcedAt !== null) ?
            'platform_custodial_fallback' : 'parties';
          this.settle(ctx, milestone, 'settlement_confirmed', 'RESOLVED', SYSTEM, {executedBy: milestone.dispute.executedBy});
          return true;
        }
        // A party that misses the compliance deadline ignored the ruling. Record it for the
        // rating, then execute the ruling so funds never stay locked. This fallback exists
        // only because the test wallets are custodial. Production: winner plus arbiter (2-of-3).
        for (const obligation of milestone.dispute.obligations) {
          if (obligation.compliedAt !== null || obligation.forcedAt !== null || now < obligation.dueAt) continue;
          obligation.ignoredAt = now;
          this.note(ctx, milestone, 'ruling_ignored', SYSTEM, {party: obligation.party, action: obligation.action, dueAt: obligation.dueAt});
          this.executeObligation(ctx, milestone, obligation, 'forced', SYSTEM);
        }
        return false;
      }

      default:
        return false;
    }
  }

  // ===========================================================================
  // Tiers, rulings, settlement
  // ===========================================================================

  private openTier(ctx: Ctx, milestone: Milestone, tier: 1|2|3, actor: string): void {
    const windows = ctx.contract.terms.windows;
    const windowMs = tier === 1 ? windows.tier1WindowMs : tier === 2 ? windows.tier2WindowMs : windows.tier3WindowMs;
    milestone.dispute.tierReached = Math.max(milestone.dispute.tierReached, tier) as 0|1|2|3;
    milestone.dispute.tierDeadline = ctx.now + windowMs;
    const event: MilestoneEvent = tier === 1 ? 'open_tier_1' : tier === 2 ? 'open_tier_2' : 'open_tier_3';
    this.transition(ctx, milestone, event, actor, {tierDeadline: milestone.dispute.tierDeadline});
    if (tier === 2) this.runTier2(ctx, milestone);
  }

  private escalateFrom(ctx: Ctx, milestone: Milestone, fromTier: 1|2, actor: string, reason: string): void {
    const next = ctx.contract.terms.dispute.tiers.find((tier) => tier > fromTier);
    this.note(ctx, milestone, 'escalated', actor, {fromTier, toTier: next ?? null, reason});
    if (next) {
      this.openTier(ctx, milestone, next, actor);
      return;
    }
    this.applyRuling(ctx, milestone, this.ruling(ctx, milestone, ctx.contract.terms.dispute.tier3TimeoutWinner,
      'no_further_tier_default', `${reason}; no further tier is configured`, false));
  }

  /** Tier 2: the pre-agreed judge decides without the platform. */
  private runTier2(ctx: Ctx, milestone: Milestone): void {
    const terms = ctx.contract.terms;
    const judge = terms.judge;
    if (judge.type === 'code') {
      const expected = String(milestone.deliverable.expectedSha256 ?? '');
      const files = milestone.deliveryEvidenceIds.map((id) => this.evidenceById(ctx, id))
        .filter((record): record is EvidenceRecord => record?.type === 'content_file');
      const matches = files.length > 0 && files.every((record) => record.sha256 === expected);
      this.applyRuling(ctx, milestone, this.ruling(ctx, milestone, matches ? 'seller' : 'buyer', 'code:content_hash_match',
        matches ? 'the delivered file matches the agreed hash' : 'the delivered file does not match the agreed hash', false));
      return;
    }
    if (judge.type !== 'signed_report') return;
    // Only reports signed by the named judge and bound to this contract and milestone count.
    const verdicts = new Set<string>();
    for (const id of milestone.disputeEvidenceIds) {
      const record = this.evidenceById(ctx, id);
      if (!record || record.type !== judge.reportEvidenceType || record.signer?.id !== terms.judgeInspectorId) continue;
      try {
        const report = JSON.parse(Buffer.from(this.evidenceContent(ctx, record.sha256)).toString('utf8')) as {[key: string]: unknown};
        if (report.contractId !== ctx.contract.id || report.milestoneId !== milestone.id) continue;
        if (report.verdict === 'PASS' || report.verdict === 'FAIL') verdicts.add(report.verdict);
      } catch {
        this.note(ctx, milestone, 'judge_report_unreadable', SYSTEM, {evidenceId: id});
      }
    }
    if (verdicts.size === 0) return; // wait for a report until the Tier 2 deadline
    if (verdicts.size > 1) {
      this.note(ctx, milestone, 'judge_reports_conflict', SYSTEM, {});
      this.escalateFrom(ctx, milestone, 2, SYSTEM, 'conflicting_judge_reports');
      return;
    }
    const fail = verdicts.has('FAIL');
    this.applyRuling(ctx, milestone, this.ruling(ctx, milestone, fail ? 'buyer' : 'seller', `inspector:${terms.judgeInspectorId}`,
      `the named inspector's signed report says ${fail ? 'FAIL' : 'PASS'}`, false));
  }

  private ruling(ctx: Ctx, milestone: Milestone, winner: Winner, decidedBy: string, reason: string, final: boolean): Ruling {
    return {tier: milestone.dispute.tierReached, winner, decidedBy, reason, final, trancheDecisions: null, at: ctx.now};
  }

  /**
   * Applies a ruling under the remedy fixed at creation. A buyer win can
   * first order a return or one redo. Otherwise the milestone resolves
   * and the parties get obligations to carry out the payout. `instructed`
   * lists parties whose own action produced the ruling.
   */
  private applyRuling(
    ctx: Ctx, milestone: Milestone, ruling: Ruling, event: MilestoneEvent = 'ruling_issued',
    actor = ruling.decidedBy, instructed: Side[] = [],
  ): void {
    const terms = ctx.contract.terms;
    const windows = terms.windows;
    const remedy = terms.remedy;
    if (!ruling.final && ruling.winner === 'buyer') {
      if (remedy.type === 'full_refund_with_return' && !milestone.dispute.returnOrdered) {
        milestone.dispute.ruling = ruling;
        milestone.dispute.returnOrdered = true;
        milestone.dispute.tierDeadline = null;
        milestone.dispute.followUpDeadline = ctx.now + windows.returnWindowMs;
        this.transition(ctx, milestone, 'return_ordered', actor, {ruling, returnDeadline: milestone.dispute.followUpDeadline});
        return;
      }
      if (remedy.type === 'redo_or_replace' && !milestone.dispute.redoUsed) {
        milestone.dispute.ruling = ruling;
        milestone.dispute.redoUsed = true;
        milestone.dispute.tierDeadline = null;
        milestone.dispute.followUpDeadline = Math.min(
          ctx.now + windows.redoWindowMs,
          this.deadlines(milestone).externalDisputeUnlockTime - this.settings.disputeSubmitSafetyMarginMs,
        );
        this.transition(ctx, milestone, 'redo_ordered', actor, {ruling, redoDeadline: milestone.dispute.followUpDeadline});
        return;
      }
    }
    if (ruling.winner === 'split' && !ruling.trancheDecisions) throw new Error('a split ruling needs tranche decisions');
    const decisions = ruling.trancheDecisions ?? decisionsFor(remedy, ruling.winner === 'seller' ? 'seller' : 'buyer', milestone.tranches);
    const finalRuling: Ruling = {...ruling, trancheDecisions: decisions};
    milestone.dispute.ruling = finalRuling;
    milestone.dispute.tierDeadline = null;
    milestone.dispute.followUpDeadline = null;
    milestone.resolvedAt = ctx.now;
    milestone.fee = disputeFee(terms.fees, milestone.dispute.tierReached, finalRuling.winner);

    // The platform does not move funds on its own. Each payout is one party's action.
    const dueAt = Math.min(
      ctx.now + windows.rulingComplianceWindowMs,
      this.deadlines(milestone).externalDisputeUnlockTime - this.settings.disputeSubmitSafetyMarginMs,
    );
    const release = milestone.tranches.filter((tranche) =>
      decisions[tranche.id] === 'release' && tranche.chain.onChainState === 'Disputed').map((tranche) => tranche.id);
    const refund = milestone.tranches.filter((tranche) =>
      decisions[tranche.id] === 'refund' && ['RefundRequested', 'Disputed'].includes(tranche.chain.onChainState ?? '')).map((tranche) => tranche.id);
    const obligations: RulingObligation[] = [];
    if (release.length > 0) {
      obligations.push({party: 'buyer', action: 'authorize_withdrawal', trancheIds: release, dueAt, compliedAt: null, ignoredAt: null, forcedAt: null});
    }
    if (refund.length > 0) {
      obligations.push({party: 'seller', action: 'authorize_refund', trancheIds: refund, dueAt, compliedAt: null, ignoredAt: null, forcedAt: null});
    }
    milestone.dispute.obligations = obligations;
    this.transition(ctx, milestone, event, actor, {ruling: finalRuling, remedy, fee: milestone.fee, obligations});
    for (const obligation of obligations) {
      if (instructed.includes(obligation.party)) {
        const partyId = obligation.party === 'buyer' ? ctx.contract.buyerId : ctx.contract.sellerId;
        this.executeObligation(ctx, milestone, obligation, 'complied', partyId);
      }
    }
  }

  /** Journals the escrow writes for one obligation. `forced` = the custodial fallback after the deadline. */
  private executeObligation(
    ctx: Ctx, milestone: Milestone, obligation: RulingObligation, how: 'complied'|'forced', actor: string,
  ): void {
    if (how === 'complied') {
      obligation.compliedAt = ctx.now;
      if (ctx.now >= obligation.dueAt && obligation.ignoredAt === null) obligation.ignoredAt = obligation.dueAt;
    } else {
      obligation.forcedAt = ctx.now;
    }
    for (const id of obligation.trancheIds) this.enqueue(ctx, milestone, this.tranche(milestone, id), obligation.action, {});
    if (how === 'complied') {
      this.note(ctx, milestone, 'ruling_complied', actor, {
        party: obligation.party, action: obligation.action, trancheIds: obligation.trancheIds, late: ctx.now >= obligation.dueAt,
      });
      return;
    }
    this.note(ctx, milestone, 'ruling_executed_by_custodian', SYSTEM, {
      party: obligation.party,
      action: obligation.action,
      trancheIds: obligation.trancheIds,
      custodyModel: ctx.contract.terms.custodyModel,
      note: 'custodial test wallets only; in the production 2-of-3 escrow the winner and the arbiter sign',
    });
  }

  private settle(
    ctx: Ctx, milestone: Milestone, event: MilestoneEvent, outcome: SettlementOutcome, actor: string,
    details: {[key: string]: unknown},
  ): void {
    this.transition(ctx, milestone, event, actor, details);
    milestone.outcome = outcome;
    milestone.settledAt = confirmedTime(milestone.tranches, [...PAID_OUT_STATES]) ?? ctx.now;
    milestone.pending = null;
    if (outcome === 'RESOLVED' && milestone.dispute.ruling?.trancheDecisions) {
      const decisions = milestone.dispute.ruling.trancheDecisions;
      const shortfalls = milestone.tranches.filter((tranche) => {
        const amount = decisions[tranche.id] === 'refund' ? tranche.chain.paidToBuyerAtomic : tranche.chain.paidToSellerAtomic;
        return amount !== tranche.amountAtomic;
      });
      if (shortfalls.length > 0) {
        milestone.closedReason = 'ruling_partially_executed';
        this.note(ctx, milestone, 'settlement_shortfall', SYSTEM, {
          escrows: shortfalls.map((tranche) => ({id: tranche.id, decision: decisions[tranche.id],
            paidToBuyerAtomic: tranche.chain.paidToBuyerAtomic, paidToSellerAtomic: tranche.chain.paidToSellerAtomic})),
        });
      }
    }
    this.publish(ctx, milestone);
    this.afterTerminal(ctx, milestone);
  }

  /** Sequential milestones: fund the next one after a good outcome, else cancel the rest. */
  private afterTerminal(ctx: Ctx, milestone: Milestone): void {
    const contract = ctx.contract;
    if (contract.terms.fundingSchedule !== 'sequential') return;
    const next = contract.milestones.find((item) => item.state === 'awaiting_funding' && item.deadlines === null);
    if (!next) return;
    const good = milestone.outcome === 'ACCEPTED' || milestone.outcome === 'AUTO_RELEASED' ||
      (milestone.outcome === 'RESOLVED' && milestone.dispute.ruling?.winner !== 'buyer');
    if (good) {
      this.requestFunding(ctx, next);
      return;
    }
    next.closedReason = 'prior_milestone_failed';
    this.settle(ctx, next, 'cancel', 'CANCELLED', SYSTEM, {reason: next.closedReason, priorMilestoneId: milestone.id, priorOutcome: milestone.outcome});
  }

  private requestFunding(ctx: Ctx, milestone: Milestone): void {
    const contract = ctx.contract;
    const terms = contract.terms;
    const deadlines = computeDeadlines(ctx.now, terms.windows);
    validateDeadlines(deadlines, ctx.now, contract.mode);
    milestone.deadlines = deadlines;
    milestone.fundingRequestedAt = ctx.now;
    milestone.pending = {kind: 'funding', since: ctx.now};
    for (const tranche of milestone.tranches) {
      tranche.identifierFromPurchaser = newIdentifierFromPurchaser();
      tranche.inputHash = mip004InputHash(tranche.identifierFromPurchaser, {
        schema: 'contract-escrow-input.v1',
        termsSha256: contract.termsSha256,
        contractId: contract.id,
        milestoneId: milestone.id,
        trancheId: tranche.id,
        amountAtomic: tranche.amountAtomic,
        assetUnit: terms.assetUnit,
      });
      this.enqueue(ctx, milestone, tranche, 'create_terms', {
        amountAtomic: tranche.amountAtomic,
        assetUnit: terms.assetUnit,
        deadlines,
        inputHash: tranche.inputHash,
        identifierFromPurchaser: tranche.identifierFromPurchaser,
        buyerAddress: terms.buyer.cardanoAddress,
        sellerAddress: terms.seller.cardanoAddress,
        metadata: `contract ${contract.id} milestone ${milestone.index} tranche ${tranche.role}`,
      });
    }
    this.note(ctx, milestone, 'funding_requested', SYSTEM, {deadlines});
  }

  /** Builds the result manifest (exact bytes kept), the MIP-004 result hash per escrow, and journals SubmitResult. */
  private postResult(
    ctx: Ctx, milestone: Milestone, records: EvidenceRecord[], schema: string, kind: 'delivery'|'redelivery', actor: string,
  ): void {
    const manifest = canonicalize({
      schema,
      contractId: ctx.contract.id,
      milestoneId: milestone.id,
      termsSha256: ctx.contract.termsSha256,
      items: records.map((record) => ({
        type: record.type,
        sha256: record.sha256,
        mediaType: record.mediaType,
        signerId: record.signer?.id ?? null,
        signatureHex: record.signer?.signatureHex ?? null,
      })),
    });
    milestone.resultManifest = manifest;
    milestone.evidenceSubmittedAt = ctx.now;
    for (const tranche of milestone.tranches) {
      tranche.resultHash = mip004ResultHash(this.purchaserId(tranche), manifest);
      this.enqueue(ctx, milestone, tranche, 'submit_result', {resultHash: tranche.resultHash}, true);
    }
    milestone.pending = {kind, since: ctx.now};
    this.note(ctx, milestone, kind === 'delivery' ? 'delivery_submitted' : 'redelivery_submitted', actor, {
      manifestSha256: sha256Hex(manifest),
      resultHashes: Object.fromEntries(milestone.tranches.map((tranche) => [tranche.id, tranche.resultHash])),
      evidence: records.map((record) => ({id: record.id, type: record.type, sha256: record.sha256})),
    });
  }

  private storeEvidence(
    ctx: Ctx, milestone: Milestone, submitterId: string, items: EvidenceInput[], rules: EvidenceRule[], phase: EvidencePhase,
  ): EvidenceRecord[] {
    const terms = ctx.contract.terms;
    const byType = new Map(rules.map((rule) => [rule.type, rule]));
    for (const item of items) {
      if (!byType.has(item.type)) {
        throw new ContractError('evidence_type_not_allowed', `${item.type} is not accepted here. Allowed: ${rules.map((rule) => rule.type).join(', ')}`);
      }
    }
    for (const rule of rules) {
      const count = items.filter((item) => item.type === rule.type).length;
      if (count < rule.min || (rule.max !== undefined && count > rule.max)) {
        throw new ContractError('evidence_count', `${rule.type}: need ${rule.min}${rule.max !== undefined ? ` to ${rule.max}` : ' or more'}, got ${count}`);
      }
    }
    return items.map((item) => {
      const rule = byType.get(item.type);
      let signer: EvidenceRecord['signer'] = null;
      if (rule?.signedBy || item.signer) {
        if (!item.signer) throw new ContractError('signature_required', `${item.type} must be signed by an inspector`);
        const inspector = terms.inspectorWhitelist.find((candidate) => candidate.id === item.signer?.id);
        if (!inspector) throw new ContractError('signer_not_whitelisted', `${item.signer.id} is not on the inspector whitelist of this contract`);
        if (rule?.signedBy === 'named_inspector' && inspector.id !== terms.judgeInspectorId) {
          throw new ContractError('not_the_named_judge', `${item.type} must be signed by the named judge ${terms.judgeInspectorId}`);
        }
        if (!verifyBytes(inspector.publicKeyHex, item.content, item.signer.signatureHex)) {
          throw new ContractError('bad_signature', `the ${item.type} signature of ${inspector.id} does not match the document`);
        }
        signer = {id: inspector.id, publicKeyHex: inspector.publicKeyHex, signatureHex: item.signer.signatureHex};
      }
      const content = typeof item.content === 'string' ? new Uint8Array(Buffer.from(item.content, 'utf8')) : item.content;
      const record: EvidenceRecord = {
        id: randomUUID(),
        contractId: ctx.contract.id,
        milestoneId: milestone.id,
        type: item.type,
        submitterId,
        sha256: sha256Hex(content),
        mediaType: item.mediaType ?? 'application/octet-stream',
        signer,
        submittedAt: ctx.now,
        mode: ctx.contract.mode,
        phase,
      };
      ctx.evidence.push({record, content});
      return record;
    });
  }

  private evidenceById(ctx: Ctx, id: string): EvidenceRecord|undefined {
    return ctx.evidence.find((item) => item.record.id === id)?.record ?? this.store.getEvidence(id);
  }

  private evidenceContent(ctx: Ctx, sha256: string): Uint8Array {
    const content = ctx.evidence.find((item) => item.record.sha256 === sha256)?.content ?? this.store.getEvidenceContent(sha256);
    if (!content) throw new Error(`evidence content ${sha256} is missing`);
    return content;
  }

  /** Queues the reliability update for this milestone in the same commit. */
  private publish(ctx: Ctx, milestone: Milestone): void {
    ctx.publications.push({
      id: randomUUID(),
      contractId: ctx.contract.id,
      milestoneId: milestone.id,
      transaction: milestoneTransaction(ctx.contract, milestone),
      outcome: milestoneOutcome(ctx.contract, milestone, ctx.now),
      extraEvents: TERMINAL_STATES.has(milestone.state) ? rulingComplianceEvents(ctx.contract, milestone) : [],
      createdAt: ctx.now,
    });
    if (TERMINAL_STATES.has(milestone.state)) {
      this.note(ctx, milestone, 'settlement_published', SYSTEM, {outcome: milestone.outcome, closedReason: milestone.closedReason});
    }
  }

  // ===========================================================================
  // Plumbing
  // ===========================================================================

  private newCtx(contract: Contract, now = this.clock.now()): Ctx {
    return {contract, now, audits: [], newOperations: [], operationUpdates: [], evidence: [], publications: [], action: null};
  }

  private mutate(contractId: string, work: (ctx: Ctx) => void, skipIfUnchanged = false): Contract {
    for (let attempt = 0; ; attempt++) {
      const contract = this.getContract(contractId);
      const before = skipIfUnchanged ? JSON.stringify(contract) : '';
      const ctx = this.newCtx(contract);
      // A ContractError is a rejected request. Any other error is a bug and stays a 500.
      work(ctx);
      const unchanged = skipIfUnchanged && JSON.stringify(contract) === before && ctx.audits.length === 0 &&
        ctx.newOperations.length === 0 && ctx.operationUpdates.length === 0;
      if (unchanged) return contract;
      try {
        this.commit(ctx, false);
        return contract;
      } catch (error) {
        if (!(error instanceof ContractConflictError) || attempt >= MAX_CONFLICT_RETRIES) throw error;
      }
    }
  }

  private commit(ctx: Ctx, isNew: boolean): void {
    this.store.commitContract({
      contract: ctx.contract,
      isNew,
      open: ctx.contract.milestones.some((milestone) => !TERMINAL_STATES.has(milestone.state)),
      now: ctx.now,
      audits: ctx.audits,
      newOperations: ctx.newOperations,
      operationUpdates: ctx.operationUpdates,
      evidence: ctx.evidence,
      publications: ctx.publications,
      action: ctx.action,
    });
  }

  private transition(ctx: Ctx, milestone: Milestone, event: MilestoneEvent, actor: string, details: {[key: string]: unknown}): void {
    const from = milestone.state;
    const to = nextState(from, event);
    milestone.state = to;
    milestone.history.push({at: ctx.now, event, from, to, actor});
    ctx.audits.push({at: ctx.now, contractId: ctx.contract.id, milestoneId: milestone.id, event, fromState: from, toState: to, actor, mode: ctx.contract.mode, details});
  }

  private note(
    ctx: Ctx, milestone: Milestone|null, event: string, actor: string, details: {[key: string]: unknown},
    fromState: string|null = milestone?.state ?? null, toState: string|null = milestone?.state ?? null,
  ): void {
    ctx.audits.push({at: ctx.now, contractId: ctx.contract.id, milestoneId: milestone?.id ?? null, event, fromState, toState, actor, mode: ctx.contract.mode, details});
  }

  private enqueue(
    ctx: Ctx, milestone: Milestone, tranche: Tranche, kind: EscrowOpKind,
    payload: {[key: string]: unknown}, retryFailed = false,
  ): void {
    // One operation of each kind per escrow, except result posts: a redo posts a new hash.
    const idempotencyKey = `${kind}:${tranche.id}${kind === 'submit_result' ? `:${String(payload.resultHash)}` : ''}`;
    if (ctx.newOperations.some((operation) => operation.idempotencyKey === idempotencyKey)) return;
    const existing = this.store.listOperations(ctx.contract.id).find((operation) => operation.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.status === 'failed' && retryFailed) {
        ctx.operationUpdates.push({id: existing.id, status: 'pending', lastError: null});
        this.note(ctx, milestone, 'escrow_operation_retry_requested', SYSTEM, {kind, operationId: existing.id, attempts: existing.attempts});
      }
      return;
    }
    ctx.newOperations.push({
      id: randomUUID(), contractId: ctx.contract.id, milestoneId: milestone.id, trancheId: tranche.id,
      kind, idempotencyKey, payload, createdAt: ctx.now,
    });
  }

  private hasPendingOperation(ctx: Ctx, milestone: Milestone, kind: EscrowOpKind): boolean {
    return ctx.newOperations.some((item) => item.milestoneId === milestone.id && item.kind === kind) ||
      this.store.listOperations(ctx.contract.id).some((item) => item.milestoneId === milestone.id && item.kind === kind && item.status === 'pending');
  }

  private assertBeforeDeadline(ctx: Ctx, deadline: number|null, label: string): void {
    if (deadline === null || ctx.now >= deadline) {
      throw new ContractError('deadline_passed', `the ${label} deadline has passed`);
    }
  }

  private assertCan(milestone: Milestone, event: MilestoneEvent): void {
    if (!canTransition(milestone.state, event)) throw new IllegalTransitionError(milestone.state, event);
  }

  private assertNoPending(milestone: Milestone): void {
    if (milestone.pending) {
      throw new ContractError('operation_in_flight', `milestone ${milestone.index} waits for ${milestone.pending.kind} to confirm on-chain`);
    }
  }

  private party(entityId: string): ContractParty {
    const party = this.store.getContractParty(entityId);
    if (!party) throw new ContractError('not_found', `${entityId} has no registered contract key`);
    return party;
  }

  private sideOf(contract: Contract, partyId: string): Side {
    if (partyId === contract.buyerId) return 'buyer';
    if (partyId === contract.sellerId) return 'seller';
    throw new ContractError('forbidden', `${partyId} is not a party to contract ${contract.id}`);
  }

  private requireSide(actual: Side, expected: Side): void {
    if (actual !== expected) throw new ContractError('forbidden', `only the ${expected} can do this`);
  }

  private milestone(contract: Contract, milestoneId: string|null): Milestone {
    const milestone = contract.milestones.find((item) => item.id === milestoneId);
    if (!milestone) throw new ContractError('not_found', `unknown milestone ${String(milestoneId)}`);
    return milestone;
  }

  private tranche(milestone: Milestone, trancheId: string): Tranche {
    const tranche = milestone.tranches.find((item) => item.id === trancheId);
    if (!tranche) throw new Error(`unknown tranche ${trancheId}`);
    return tranche;
  }

  private deadlines(milestone: Milestone): NonNullable<Milestone['deadlines']> {
    if (!milestone.deadlines) throw new Error(`milestone ${milestone.index} has no deadlines yet`);
    return milestone.deadlines;
  }

  private purchaserId(tranche: Tranche): string {
    if (!tranche.identifierFromPurchaser) throw new Error(`tranche ${tranche.id} has no purchaser id`);
    return tranche.identifierFromPurchaser;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameChain(view: ChainView, status: EscrowStatus): boolean {
  return view.onChainState === status.onChainState && view.confirmed === status.confirmed &&
    view.lastTxHash === status.lastTxHash && view.resultHash === status.resultHash &&
    view.paidToSellerAtomic === status.paidToSellerAtomic && view.paidToBuyerAtomic === status.paidToBuyerAtomic &&
    view.settlementTxHash === status.settlementTxHash &&
    JSON.stringify(view.history ?? []) === JSON.stringify(status.history ?? []);
}

/** Latest confirmation across the escrows. Missing history keeps the observation time. */
function confirmedTime(tranches: readonly Tranche[], states: readonly OnChainState[], matchResult = false): number|null {
  const times = tranches.map((tranche) => {
    const entries = (tranche.chain.history ?? []).filter((entry) => states.includes(entry.to) &&
      (!matchResult || (entry.resultHash ?? tranche.chain.resultHash) === tranche.resultHash));
    return entries.length > 0 ? Math.max(...entries.map((entry) => entry.at)) : null;
  });
  return times.every((time): time is number => time !== null) ? Math.max(...times) : null;
}
