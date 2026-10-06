/**
 * @fileoverview Seams between the contract engine and the outside world:
 * the clock, the escrow rail, and the store. The engine imports no
 * database and opens no network connection.
 */

import type {MarketplaceTransaction, Outcome, ReliabilityEvent} from '../types';
import type {
  ChainView, Contract, ContractMode, ContractParty, EvidenceRecord,
} from './types';

export interface ContractClock {
  now(): number;
}

// ---- Escrow rail ----

export type EscrowOpKind =
  'create_terms'|'lock_funds'|'submit_result'|'request_refund'|
  'authorize_withdrawal'|'authorize_refund';

export type ScalarRecord = {[key: string]: string|number|boolean|null};

export interface EscrowRequest {
  kind: EscrowOpKind;
  idempotencyKey: string;
  /** Escrow reference for every kind except create_terms. */
  ref: string|null;
  /** Signed escrow terms from create_terms. The live rail needs them to fund and act. */
  terms: ScalarRecord|null;
  payload: {[key: string]: unknown};
}

export interface EscrowResult {
  ref?: string;
  /** Signed escrow terms as the payment service returned them (create_terms). */
  terms?: ScalarRecord;
}

export type EscrowStatus = Omit<ChainView, 'syncedAt'>;

/**
 * Paper and live escrows implement this port. The engine does not know
 * which one it drives.
 */
export interface ContractEscrow {
  readonly mode: ContractMode;
  /** The external write. Throw EscrowRejectedError when the rail refuses for good. */
  execute(request: EscrowRequest): Promise<EscrowResult>;
  /** Called before a retry whose earlier attempt has an unknown result. Never writes. */
  inspect(request: EscrowRequest): Promise<EscrowResult&{status: 'applied'|'not_applied'|'unknown'}>;
  status(ref: string, terms: ScalarRecord|null): Promise<EscrowStatus>;
}

/** The rail refused the operation. The same operation will not succeed later. */
export class EscrowRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EscrowRejectedError';
  }
}

/** A temporary failure: a transaction in flight, a timeout, or the network. */
export class EscrowRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EscrowRetryableError';
  }
}

// ---- Journal of external writes ----

export type OperationStatus = 'pending'|'done'|'failed'|'cancelled';

export interface EscrowOperation {
  id: string;
  contractId: string;
  milestoneId: string;
  trancheId: string;
  kind: EscrowOpKind;
  idempotencyKey: string;
  payload: {[key: string]: unknown};
  status: OperationStatus;
  /** Incremented when a worker claims the operation, before the external write. */
  attempts: number;
  lastError: string|null;
  result: {[key: string]: unknown}|null;
  leaseOwner: string|null;
  leaseUntil: number|null;
  createdAt: number;
  updatedAt: number;
}

export type NewEscrowOperation = Pick<
  EscrowOperation,
  'id'|'contractId'|'milestoneId'|'trancheId'|'kind'|'idempotencyKey'|'payload'|'createdAt'
>;

export interface OperationUpdate {
  id: string;
  status: OperationStatus;
  result?: {[key: string]: unknown}|null;
  lastError?: string|null;
}

// ---- Audit log ----

export interface ContractAuditEntry {
  at: number;
  contractId: string;
  milestoneId: string|null;
  event: string;
  fromState: string|null;
  toState: string|null;
  actor: string;
  mode: ContractMode;
  details: {[key: string]: unknown};
}

export interface ContractAuditRow extends ContractAuditEntry {
  seq: number;
  prevHash: string;
  hash: string;
}

// ---- Reliability outbox ----

/**
 * A reliability update committed with the state change that caused it.
 * The service publishes it to the reliability tables and the event flow.
 */
export interface ReliabilityPublication {
  id: string;
  contractId: string;
  milestoneId: string;
  transaction: MarketplaceTransaction;
  outcome: Outcome;
  /** Extra events, such as a penalty for an ignored ruling. */
  extraEvents: ReliabilityEvent[];
  createdAt: number;
}

// ---- Store ----

/** One processed signed party action. A replay returns the same result. */
export interface ProcessedAction {
  actionId: string;
  contractId: string;
  partyId: string;
  bytesSha256: string;
  processedAt: number;
}

export interface ContractCommit {
  contract: Contract;
  isNew: boolean;
  /** False when every milestone is terminal. */
  open: boolean;
  now: number;
  audits: ContractAuditEntry[];
  newOperations: NewEscrowOperation[];
  operationUpdates: OperationUpdate[];
  evidence: Array<{record: EvidenceRecord; content: Uint8Array}>;
  publications: ReliabilityPublication[];
  action: ProcessedAction|null;
}

/** Thrown when another writer changed the contract first. Reload and retry. */
export class ContractConflictError extends Error {
  constructor(contractId: string) {
    super(`contract ${contractId} changed concurrently; reload and retry`);
    this.name = 'ContractConflictError';
  }
}

export interface ContractStore {
  getContractParty(entityId: string): ContractParty|undefined;
  getContract(id: string): Contract|undefined;
  listContractIds(options: {openOnly: boolean}): string[];
  /** Atomic. Checks `contract.version` and increments it. */
  commitContract(change: ContractCommit): void;
  listOperations(contractId: string): EscrowOperation[];
  listPendingOperations(): EscrowOperation[];
  /**
   * Atomically leases a pending operation and increments `attempts`.
   * Returns the operation as it was before the claim, or undefined when
   * another worker holds an unexpired lease.
   */
  claimOperation(id: string, owner: string, now: number, leaseUntil: number): EscrowOperation|undefined;
  /** Records a retryable error and clears the lease. The operation stays pending. */
  releaseOperation(id: string, error: string, now: number): void;
  getEvidence(id: string): EvidenceRecord|undefined;
  getEvidenceContent(sha256: string): Uint8Array|undefined;
  getProcessedAction(actionId: string): ProcessedAction|undefined;
  listContractAudit(contractId: string): ContractAuditRow[];
}
