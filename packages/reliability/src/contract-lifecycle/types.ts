/**
 * @fileoverview Domain types for the contract lifecycle.
 *
 * A contract has one or more milestones. Each milestone runs the state
 * machine in transitions.ts and owns one or more Masumi V2 escrows
 * (tranches). Read docs/contract-lifecycle.md for the state mapping.
 */

/** `paper` = simulated escrow. `live` = Cardano preprod through Masumi. */
export type ContractMode = 'paper'|'live';

/**
 * Who holds the escrow keys. Only the custodial test setup exists:
 * platform-managed preprod wallets. The production path is a
 * non-custodial 2-of-3 escrow. It is not built.
 */
export type CustodyModel = 'platform_custodial_test_only';

export const MILESTONE_STATES = [
  'draft',
  'pending_acceptance',
  'awaiting_funding',
  'funded',
  'delivered',
  'in_inspection',
  'accepted_pending_release',
  'auto_released',
  'disputed',
  'tier_1_negotiation',
  'tier_2_evidence_rule',
  'tier_3_mediation',
  'return_pending',
  'redo_pending',
  'redo_inspection',
  'resolved',
  'settled',
  'cancelled',
  'expired',
  'refunded',
] as const;

export type MilestoneState = typeof MILESTONE_STATES[number];

export const TERMINAL_STATES: ReadonlySet<MilestoneState> = new Set([
  'settled', 'cancelled', 'expired', 'refunded',
]);

export const MILESTONE_EVENTS = [
  'submit_for_acceptance',
  'all_parties_signed',
  'cancel',
  'funding_confirmed',
  'funding_deadline_passed',
  'delivery_confirmed',
  'inspection_opened',
  'buyer_accepted',
  'inspection_window_expired',
  'dispute_confirmed',
  'release_confirmed',
  'refund_confirmed',
  'delivery_deadline_refund_confirmed',
  'mutual_termination_confirmed',
  'open_tier_1',
  'open_tier_2',
  'open_tier_3',
  'ruling_issued',
  'return_ordered',
  'return_receipt_confirmed',
  'return_not_shipped',
  'return_unconfirmed',
  'redo_ordered',
  'redelivery_confirmed',
  'redo_deadline_passed',
  'redo_accepted',
  'redo_rejected',
  'redo_inspection_expired',
  'settlement_confirmed',
  'admin_settlement_confirmed',
] as const;

export type MilestoneEvent = typeof MILESTONE_EVENTS[number];

/** Transaction category of a template. Same names as the brief. */
export type ContractCategory =
  'digital_machine_checkable'|'digital_subjective'|'physical_objective_spec'|
  'physical_subjective'|'ongoing_service';

export type RemedyType =
  'partial_release'|'full_refund_with_return'|'full_refund_no_return'|
  'redo_or_replace';

export interface Remedy {
  type: RemedyType;
  /** Seller share of the amount when the buyer wins, in basis points. */
  sellerShareBps?: number;
}

/** Fixed outcomes the parties can sign in Tier 1. No free percentages. */
export type NegotiatedOutcome = 'full_release'|'core_only'|'full_refund';

export type SettlementOutcome =
  'ACCEPTED'|'AUTO_RELEASED'|'REFUNDED'|'EXPIRED'|'CANCELLED'|'RESOLVED';

export type Side = 'buyer'|'seller';
export type Winner = 'buyer'|'seller'|'split';
export type TrancheDecision = 'release'|'refund';
export type TrancheRole = 'full'|'core'|'holdback';

/** Masumi V2 on-chain states as MPS reports them. */
export type OnChainState =
  'FundsLocked'|'FundsOrDatumInvalid'|'ResultSubmitted'|'RefundRequested'|
  'Disputed'|'WithdrawAuthorized'|'RefundAuthorized'|'Withdrawn'|
  'RefundWithdrawn'|'DisputedWithdrawn';

export const PAID_OUT_STATES: ReadonlySet<OnChainState> = new Set([
  'Withdrawn', 'RefundWithdrawn', 'DisputedWithdrawn',
]);

/** Durations in milliseconds. Templates set them. Demo config can shorten them. */
export interface WindowSet {
  fundingWindowMs: number;
  deliveryWindowMs: number;
  inspectionWindowMs: number;
  disputeResolutionWindowMs: number;
  tier1WindowMs: number;
  tier2WindowMs: number;
  tier3WindowMs: number;
  returnWindowMs: number;
  redoWindowMs: number;
  redoInspectionWindowMs: number;
  rulingComplianceWindowMs: number;
}

/** Absolute Masumi deadlines in Unix milliseconds. Each escrow signs them. */
export interface Deadlines {
  payByTime: number;
  submitResultTime: number;
  unlockTime: number;
  externalDisputeUnlockTime: number;
}

/** A contract party. The id is a reliability entity id. */
export interface ContractParty {
  id: string;
  /** Raw Ed25519 public key, hex. Verifies every signed party action. */
  publicKeyHex: string;
  /** The party's own preprod address. Identity only in the custodial setup. */
  cardanoAddress: string;
}

export interface Inspector {
  id: string;
  publicKeyHex: string;
}

/** One confirmed escrow transaction. */
export interface ConfirmedEscrowTransition {
  at: number;
  from: OnChainState|null;
  to: OnChainState;
  resultHash?: string|null;
}

/** Last escrow status the adapter reported. `confirmed` = no tx in flight. */
export interface ChainView {
  onChainState: OnChainState|null;
  confirmed: boolean;
  lastTxHash: string|null;
  resultHash: string|null;
  paidToSellerAtomic: string|null;
  paidToBuyerAtomic: string|null;
  settlementTxHash: string|null;
  /** Confirmed transactions. Optional for records written before history support. */
  history?: ConfirmedEscrowTransition[];
  syncedAt: number|null;
}

export interface Tranche {
  id: string;
  role: TrancheRole;
  amountAtomic: string;
  /** MIP-004 `identifierFromPurchaser` (buyer nonce). Set at funding. */
  identifierFromPurchaser: string|null;
  inputHash: string|null;
  /** MPS blockchainIdentifier, or a `paper-` reference. */
  escrowRef: string|null;
  /** Signed escrow terms exactly as the payment service returned them. */
  escrowTerms: {[key: string]: string|number|boolean|null}|null;
  /** The result hash we last asked the escrow to record. */
  resultHash: string|null;
  chain: ChainView;
}

export interface Ruling {
  tier: 0|1|2|3;
  winner: Winner;
  decidedBy: string;
  reason: string;
  /** A final ruling skips the return and redo follow-ups. */
  final: boolean;
  trancheDecisions: {[trancheId: string]: TrancheDecision}|null;
  at: number;
}

/**
 * After a ruling, each payout needs one party's on-chain action.
 * Masumi V2: release from Disputed is the buyer's AuthorizeWithdrawal.
 * A refund is the seller's AuthorizeRefund.
 */
export interface RulingObligation {
  party: Side;
  action: 'authorize_withdrawal'|'authorize_refund';
  trancheIds: string[];
  dueAt: number;
  compliedAt: number|null;
  ignoredAt: number|null;
  forcedAt: number|null;
}

export type RulingExecutedBy =
  'parties'|'platform_custodial_fallback'|'masumi_admins';

export type PendingKind =
  'funding'|'delivery'|'dispute'|'concession'|'expiry_unwind'|
  'redelivery'|'termination';

export interface HistoryEntry {
  at: number;
  event: string;
  from: MilestoneState|null;
  to: MilestoneState;
  actor: string;
}

export interface MilestoneDispute {
  tierReached: 0|1|2|3;
  tierDeadline: number|null;
  ruling: Ruling|null;
  redoUsed: boolean;
  returnOrdered: boolean;
  returnShipmentEvidenceId: string|null;
  followUpDeadline: number|null;
  obligations: RulingObligation[];
  executedBy: RulingExecutedBy|null;
}

export interface Milestone {
  id: string;
  index: number;
  title: string;
  amountAtomic: string;
  deliverable: {[key: string]: unknown};
  state: MilestoneState;
  history: HistoryEntry[];
  tranches: Tranche[];
  deadlines: Deadlines|null;
  createdAt: number;
  fundingRequestedAt: number|null;
  fundedAt: number|null;
  evidenceSubmittedAt: number|null;
  deliveredAt: number|null;
  inspectionCutoffAt: number|null;
  buyerAcceptedAt: number|null;
  disputedAt: number|null;
  resolvedAt: number|null;
  settledAt: number|null;
  pending: {kind: PendingKind; since: number}|null;
  deliveryEvidenceIds: string[];
  disputeEvidenceIds: string[];
  /** Exact UTF-8 `output` string hashed into the result hash (MIP-004). */
  resultManifest: string|null;
  dispute: MilestoneDispute;
  outcome: SettlementOutcome|null;
  fee: {amountAtomic: string; paidBy: Winner|null}|null;
  closedReason: string|null;
}

// ---- Templates ----

export type EvidenceSigner = 'whitelisted_inspector'|'named_inspector';

export interface EvidenceRule {
  type: string;
  min: number;
  max?: number;
  signedBy?: EvidenceSigner;
}

export type JudgeSpec =
  {type: 'code'; rule: 'content_hash_match'}|
  {type: 'signed_report'; signer: 'named_inspector'; reportEvidenceType: string}|
  {type: 'buyer_then_mediator'}|
  {type: 'monitoring'; signer: 'named_monitor'; reportEvidenceType: string};

export interface DeliveryRules {
  requiredEvidence: EvidenceRule[];
}

export interface DisputeRules {
  buyerEvidence: EvidenceRule[];
  tiers: Array<1|2|3>;
  /** Winner when the Tier 3 mediator misses its deadline. Funds never stay locked. */
  tier3TimeoutWinner: Side;
}

export interface FeeRules {
  rule: 'loser_pays'|'buyer_pays'|'seller_pays';
  /** Fee per tier reached, atomic units of the settlement asset. */
  perTierAtomic: {tier1: string; tier2: string; tier3: string};
}

export interface ContractTemplate {
  id: string;
  version: number;
  category: ContractCategory;
  /** Reliability transaction type. It selects the rating category. */
  transactionType: 'goods'|'service';
  /** `enabled` templates can create contracts. `design_only` is a draft. */
  status: 'enabled'|'design_only';
  description: string;
  deliverableSpecSchema: {[key: string]: unknown};
  delivery: DeliveryRules;
  dispute: DisputeRules;
  judge: JudgeSpec;
  windows: WindowSet;
  remedy: {default: Remedy; allowed: RemedyType[]};
  fees: FeeRules;
  milestones: {fundingSchedule: 'sequential'|'upfront'; maxMilestones: number};
  notes?: {[key: string]: string};
}

// ---- Terms and contract ----

export interface ContractTerms {
  schema: 'contract-terms.v1';
  contractId: string;
  mode: ContractMode;
  /** Both parties sign this value, so custody is disclosed in the terms. */
  custodyModel: CustodyModel;
  network: 'Preprod';
  assetUnit: string;
  assetDecimals: number;
  template: {id: string; version: number; category: ContractCategory; transactionType: 'goods'|'service'};
  judge: JudgeSpec;
  judgeInspectorId: string|null;
  inspectorWhitelist: Inspector[];
  mediator: {id: string; publicKeyHex: string}|null;
  windows: WindowSet;
  remedy: Remedy;
  fees: FeeRules;
  delivery: DeliveryRules;
  dispute: DisputeRules;
  fundingSchedule: 'sequential'|'upfront';
  buyer: ContractParty;
  seller: ContractParty;
  milestones: Array<{
    id: string;
    index: number;
    title: string;
    amountAtomic: string;
    deliverable: {[key: string]: unknown};
    tranches: Array<{id: string; role: TrancheRole; amountAtomic: string}>;
  }>;
}

export interface Contract {
  id: string;
  version: number;
  mode: ContractMode;
  templateId: string;
  category: ContractCategory;
  buyerId: string;
  sellerId: string;
  createdAt: number;
  createdBy: string;
  terms: ContractTerms;
  termsSha256: string|null;
  signatures: {[partyId: string]: string};
  milestones: Milestone[];
}

// ---- Evidence ----

export type EvidencePhase =
  'delivery'|'dispute'|'tier_2_report'|'return'|'redelivery';

export interface EvidenceRecord {
  id: string;
  contractId: string;
  milestoneId: string;
  type: string;
  submitterId: string;
  sha256: string;
  mediaType: string;
  signer: {id: string; publicKeyHex: string; signatureHex: string}|null;
  submittedAt: number;
  mode: ContractMode;
  phase: EvidencePhase;
}

/** Evidence as a caller submits it. `content` is the raw document bytes. */
export interface EvidenceInput {
  type: string;
  content: Uint8Array|string;
  mediaType?: string;
  /** Signed evidence: the signer id and an Ed25519 signature over `content`. */
  signer?: {id: string; signatureHex: string};
}
