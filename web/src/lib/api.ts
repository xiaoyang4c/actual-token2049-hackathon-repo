/*
 * Read client for the control API (/reliability/*) and the Coworker ask
 * server (/coworkers/ask). Every control API call is a GET; the Deal Desk
 * draft runs the engine in an in-memory sandbox and writes nothing. The only
 * POST is Ask a Coworker, a free preview that pays and stores nothing.
 */

export interface Moment { ms: number; utc: string; singapore: string }
export interface Money { atomic: string; display: string }
export interface Span { ms: number; display: string }
export type Role = 'buyer' | 'seller'

export interface Party { id: string; displayName: string }

export interface MilestoneSummary {
  id: string
  index: number
  title: string
  amount: Money
  state: string
  terminal: boolean
  inDispute: boolean
  tierReached: number
  outcome: string | null
  closedReason: string | null
  next: {actor: string; action: string; dueAt: Moment | null} | null
}

export interface ContractSummary {
  id: string
  label: string
  mode: 'paper' | 'live'
  templateId: string
  title: string
  buyer: Party
  seller: Party
  total: Money
  createdAt: Moment
  remedy: string
  milestones: MilestoneSummary[]
}

export interface Escrow {
  role: string
  amountAtomic: string
  ref: string | null
  onChainState: string | null
  confirmed: boolean
  settlementTxHash: string | null
}

export interface Obligation {
  party: Role
  action: string
  dueAt: string
  compliedAt: number | null
  ignoredAt: number | null
  forcedAt: number | null
}

export interface ContractView {
  mode: string
  custodyModel: string
  now: string
  contract: {
    id: string
    templateId: string
    category: string
    buyerId: string
    sellerId: string
    createdAt: number
    termsSha256: string
    signatures: Record<string, string>
    terms: {
      network: string
      assetUnit: string
      judge: {type: string; [key: string]: unknown}
      judgeInspectorId?: string
      inspectorWhitelist: Array<{id: string; publicKeyHex: string}>
      windows: Record<string, number>
      remedy: {type: string; sellerShareBps?: number; [key: string]: unknown}
      fees: Record<string, unknown>
      buyer: {entityId: string; displayName?: string; cardanoAddress?: string}
      seller: {entityId: string; displayName?: string; cardanoAddress?: string}
      milestones: Array<{title: string; amountAtomic: string; deliverable: Record<string, unknown>}>
      [key: string]: unknown
    }
  }
  milestones: Array<{
    id: string
    index: number
    state: string
    outcome: string | null
    pending: unknown
    deadlines: {payByTime?: string; submitResultTime?: string; unlockTime?: string; externalDisputeUnlockTime?: string}
    inspectionCutoffAt: string | null
    tierDeadline: string | null
    obligations: Obligation[]
    escrows: Escrow[]
    reliability: {transactionId: string; state: string; fault?: string; evidence: Record<string, unknown>; verificationConfidence?: number} | null
  }>
  auditChainIntact: boolean
}

export interface AuditRow {
  seq: number
  at: number
  milestoneId: string | null
  event: string
  fromState: string | null
  toState: string | null
  actor: string
  mode: string
  prevHash: string
  hash: string
  details: Record<string, unknown>
}

export interface Evidence {
  id: string
  phase: 'delivery' | 'dispute' | string
  type: string
  submittedBy: string
  submittedByRole: Role
  submittedAt: Moment
  sha256: string
  mediaType: string
  signer: {id: string; whitelisted: boolean; namedJudge: boolean} | null
  quotedContent: {text: string; truncated: boolean} | null
}

export interface DisputeCase {
  label: string
  now: Moment
  contract: {id: string; buyerId: string; sellerId: string; judge: string; remedy: string; tier3TimeoutWinner: string; inspectorWhitelist: Array<{id: string}>}
  milestone: {
    id: string
    index: number
    title: string
    amount: Money
    deliverable: Record<string, unknown>
    state: string
    escrows: Array<{role: string; amount: Money; onChainState: string}>
    deadlines: Record<string, Moment>
    deliveredOnTime: boolean | null
    dispute: {tierReached: number; tierDeadline: Moment | null; timeLeftInTier: Span | null} | null
  }
  canRuleNow: boolean
  nextStep: string
  deliveryEvidenceCheck: Array<{rule: string; found: number; met: boolean}>
  evidence: Evidence[]
  history: Array<{at: Moment; event: string; from: string | null; to: string; actor: string}>
}

export interface RulingOption {
  winner: Role
  stateAfterRuling: string
  payout: {toSeller: Money; toBuyer: Money}
  escrowDecisions: Array<{role: string; amount: Money; decision: string}>
  fee: {amount: Money; paidBy: Role} | null
  obligations: Array<{party: Role; action: string; dueAt: Moment}>
  followUp: unknown
  reliabilityIfSettled: {state: string; fault: string; verificationConfidence: number}
}

export interface RulingOptions {
  milestoneId: string
  tierDeadline: Moment
  defaultIfNoRuling: {winner: Role; appliesAt: Moment}
  options: RulingOption[]
}

export interface RulingPayload {
  bytes: string
  bytesSha256: string
  endpoint: string
  request: Record<string, unknown>
}

export interface EntityHit { id: string; displayName: string; kycStatus: string; kycTier: string; createdAt: string }

export interface RecordCounts { milestones: number; open: number; disputed: number; disputesLost: number; rulingsIgnored: number; lateDeliveries: number; atFault: number }

export interface Profile {
  entity: EntityHit
  scoringPolicy: {version: string; provisional: boolean}
  scores: Array<{category: string; role: Role; score: number; lowerBound: number; confidence: number; events: {success?: number; failure?: number; [key: string]: unknown}; updatedAt: string}>
  termsDecisions: Array<{category: string; buyerFeeBps: number; sellerFeeBps: number; reasonCode: string; policyVersion: string; decidedAt: string; terms: Record<string, unknown>}>
  contractSummary: {live: RecordCounts; simulated: RecordCounts}
  deals: Array<{
    contractId: string
    milestoneIndex: number
    label: string
    role: Role
    counterpartyId: string
    templateId: string
    amount: Money
    state: string
    terminal: boolean
    settlementOutcome: string | null
    disputed: boolean
    disputeTierReached: number
    disputeWinner: Role | null
    onTime: boolean | null
    reliabilityOutcome: {state: string; fault: string} | null
  }>
}

export interface TemplateInfo {
  id: string
  version: number
  status: 'enabled' | 'design_only'
  transactionType: string
  description: string
  judge: string
  deliverableFields: {required: string[]; optional: string[]}
  deliveryEvidence: string[]
  buyerDisputeEvidence: string[]
  disputeTiers: number[]
  tier3TimeoutWinner: string
  windows: Record<string, Span>
  remedies: {default: string; allowed: string[]}
  fees: {rule: string; tier1?: Money; tier2?: Money; tier3?: Money}
  maxMilestones: number
  notes: Record<string, string>
}

export interface DraftInput {
  templateId: string
  milestones: Array<{title: string; amount: string; deliverable?: Record<string, unknown>}>
  remedy?: {type: string; sellerSharePercent?: string}
  inspectors?: string[]
  judgeInspector?: string
}

export interface Payout { toSeller: Money; toBuyer: Money }

export interface DraftResult {
  sandbox: true
  mode: 'paper' | 'live'
  template: {id: string; version: number; judge: string; transactionType: string}
  remedy: {type: string; sellerSharePercent: string | null}
  defaultsApplied: string[]
  placeholders: Array<{milestoneIndex: number | null; field: string}>
  milestones: Array<{
    index: number
    title: string
    amount: Money
    escrows: Array<{role: string; amount: Money}>
    sellerWins: Payout
    buyerWins: Payout
    buyerWinsFollowUp: string
    tier1Options: Array<{outcome: string; payout: Payout}>
  }>
  evidence: {delivery: string[]; buyerDispute: string[]}
  judge: {type: string; inspector: string | null; inspectors: string[]}
  firstMilestoneTimeline: Record<string, Moment>
  maxLock: {perMilestone: Span; wholeContractWorstCase: Span; fundingSchedule: string}
  disputes: {tiers: number[]; tierWindows: Record<string, Span>; tier3TimeoutWinner: string; budget: Span; window: Span; budgetFits: boolean}
  fees: {rule: string; perTier: Record<string, Money>; ifDisputeReachesLastTier: {buyerWins: {amount: Money; paidBy: Role | null}; sellerWins: {amount: Money; paidBy: Role | null}}; note: string}
  liveDeadlineCheck: {ok: boolean; problems: string[]}
  createRequest: Record<string, unknown>
}

export type CoworkerSlug = 'deal-desk' | 'mediator' | 'trust-check'

export interface AskJob {
  id: string
  coworker: CoworkerSlug
  status: 'queued' | 'running' | 'done' | 'failed'
  position: number
  answer: string | null
  mode: 'model' | 'fill-in' | 'needs-input' | null
  error: string | null
}

export interface LedgerTransaction {
  id: string
  type: 'goods' | 'service' | 'invoice' | string
  participants: Array<{entityId: string; role: Role}>
  terms: Record<string, unknown>
  value: number
  createdAt: string
  completedAt: string | null
}

export interface Receipt {
  transaction: LedgerTransaction
  outcome: {state: string; fault?: string; evidence: Record<string, unknown>; verificationMethod: string; verificationConfidence: number; decidedAt: string} | null
  events: Array<{id: string; entityId: string; category: string; role: Role; outcome: string; value: number; createdAt: string}>
  termsDecision: {entityId: string; category: string; buyerFeeBps: number; sellerFeeBps: number; reasonCode: string; policyVersion: string} | null
}

export interface Entity {
  id: string
  displayName: string
  wallets: string[]
  kycStatus: string
  kycTier: string
  roles: Role[]
  createdAt: string
}

export interface ScoreRow { entityId: string; category: string; role: Role; value: number; lowerBound: number; confidence: number; eventCount: number }

export interface Listing {
  id: string
  sellerId: string
  transactionType: string
  title: string
  price: number | null
  pricingMethod: string
  requiredTerms: Record<string, unknown>
  minSellerReliability: number
  createdAt: string
}

export interface AnchorView {
  status: 'waiting' | 'sending' | 'confirmed'
  txHashes: string[]
  explorerUrls: string[]
  blockHeight: number | null
  anchoredAt: string | null
}

export interface ContractAnchors {
  contractId: string
  records: Array<{
    publicationId: string
    milestoneId: string
    outcome: string | null
    recordHash: string
    recordUnchanged: boolean
    entries: Array<{entityId: string; seq: number; entryHash: string}>
    anchor: AnchorView
  }>
}

export interface CompanyAnchors {
  entityId: string
  chain: {intact: boolean; problems: string[]; length: number; anchored: number; head: string | null}
  entries: Array<{seq: number; entryHash: string; recordHash: string; contractId: string; milestoneId: string; anchor: AnchorView}>
}

export class ApiError extends Error {}

async function read<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError((body as {error?: string}).error ?? `${response.status} ${response.statusText}`)
  return body as T
}

const q = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()

export const api = {
  contracts: (filter: {partyId?: string; disputes?: boolean} = {}) =>
    read<ContractSummary[]>(`/reliability/contracts/list?${q({partyId: filter.partyId, disputes: filter.disputes ? 1 : undefined})}`),
  contract: (id: string) => read<ContractView>(`/reliability/contracts?${q({id})}`),
  audit: (id: string) => read<{rows: AuditRow[]; chainIntact: boolean}>(`/reliability/contracts/audit?${q({id})}`),
  disputeCase: (id: string, milestone: number) => read<DisputeCase>(`/reliability/contracts/case?${q({id, milestone})}`),
  rulingOptions: (id: string, milestone: number) => read<RulingOptions>(`/reliability/contracts/ruling-options?${q({id, milestone})}`),
  rulingPayload: (id: string, milestone: number, winner: Role, reason: string) =>
    read<RulingPayload>(`/reliability/contracts/ruling-payload?${q({id, milestone, winner, reason})}`),
  search: (text: string) => read<EntityHit[]>(`/reliability/profile/search?${q({q: text})}`),
  profile: (entityId: string) => read<Profile>(`/reliability/profile?${q({entityId})}`),
  templates: () => read<TemplateInfo[]>('/reliability/contracts/draft-templates'),
  // The draft is a sandbox read: createContract runs in memory and nothing is stored.
  draft: (input: DraftInput) => read<DraftResult>(`/reliability/contracts/draft?${q({input: JSON.stringify(input)})}`),

  // Ask a Coworker: a free preview answered by the Coworker worker.
  ask: (coworker: CoworkerSlug, text: string) =>
    read<{job: AskJob}>('/coworkers/ask', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({coworker, text})}),
  askStatus: (id: string) => read<{job: AskJob}>(`/coworkers/ask?${q({id})}`, {cache: 'no-store'}),

  // Settlement anchors: fingerprints of final records on Cardano preprod.
  contractAnchors: (id: string) => read<ContractAnchors>(`/reliability/anchors/contract?${q({id})}`),
  companyAnchors: (entityId: string) => read<CompanyAnchors>(`/reliability/anchors/company?${q({entityId})}`),

  // Operator: the v1 marketplace ledger.
  transactions: () => read<LedgerTransaction[]>('/reliability/transactions'),
  receipt: (transactionId: string) => read<Receipt>(`/reliability/receipts?${q({transactionId})}`),
  entities: () => read<Entity[]>('/reliability/entities'),
  scores: () => read<ScoreRow[]>('/reliability/scores'),
  listings: () => read<Listing[]>('/reliability/listings'),
}
