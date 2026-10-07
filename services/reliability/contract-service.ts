/**
 * @fileoverview Wires the contract engine to the shared AgentStore, the
 * escrow rail, the clock, and the reliability event flow.
 *
 * Publishing: the engine commits each reliability update to an outbox
 * with the state change that caused it. publish() moves outbox rows into
 * the reliability tables through the cumulative projection that the v1
 * lifecycle service uses (reliability-projection.ts). Event ids are
 * deterministic, so a repeated publish adds nothing.
 */

import type {AgentStore} from '../../packages/db/src/index';
import {ContractLifecycle} from '../../packages/reliability/src/contract-lifecycle/engine';
import {ContractError} from '../../packages/reliability/src/contract-lifecycle/errors';
import type {ContractClock, ContractEscrow} from '../../packages/reliability/src/contract-lifecycle/ports';
import {milestoneTransactionId} from '../../packages/reliability/src/contract-lifecycle/settlement';
import {isPublicKeyHex} from '../../packages/reliability/src/contract-lifecycle/signatures';
import {TemplateRegistry} from '../../packages/reliability/src/contract-lifecycle/templates';
import type {ContractParty} from '../../packages/reliability/src/contract-lifecycle/types';
import type {ApiTransport, CredentialResolver} from '../cardano-agents-ts/types';
import {loadContractConfig, type ContractConfig} from './contract-config';
import {MasumiContractEscrow} from './contract-masumi-escrow';
import {PaperContractEscrow} from './contract-paper-escrow';
import {DEFAULT_RELIABILITY_POLICIES, type ReliabilityPolicies} from './policies';
import {projectOutcome} from './reliability-projection';
import {withRecordedWeights} from './score-ledger';

/** Paper time = system time + a stored offset. Raising the offset fast-forwards a demo. */
export class PaperClock implements ContractClock {
  constructor(private readonly store: AgentStore) {}

  now(): number {
    return Date.now() + this.store.getPaperClockOffset();
  }

  advanceTo(targetMs: number): void {
    this.store.raisePaperClockOffset(targetMs - Date.now());
  }
}

class SystemClock implements ContractClock {
  now(): number {
    return Date.now();
  }
}

export interface ContractServiceOptions {
  config?: ContractConfig;
  clock?: ContractClock;
  escrow?: ContractEscrow;
  templates?: TemplateRegistry;
  /** A Masumi transport. A fixture transport keeps every contract labelled paper. */
  masumiTransport?: ApiTransport;
  resolveCredential?: CredentialResolver;
  /** Scoring, decay, and fee policies. Defaults to the shared composition in policies.ts. */
  policies?: ReliabilityPolicies;
}

export class ContractService {
  readonly config: ContractConfig;
  readonly lifecycle: ContractLifecycle;
  readonly escrow: ContractEscrow;
  readonly clock: ContractClock;
  readonly templates: TemplateRegistry;
  private readonly paperClock: PaperClock|null;
  private readonly policies: ReliabilityPolicies;

  constructor(private readonly store: AgentStore, options: ContractServiceOptions = {}) {
    const config = options.config ?? loadContractConfig();
    const paperClock = options.clock ? null : new PaperClock(store);
    let clock: ContractClock = options.clock ?? (config.settings.mode === 'live' ? new SystemClock() : paperClock ?? new SystemClock());
    let escrow = options.escrow;
    if (!escrow && (config.settings.mode === 'live' || options.masumiTransport)) {
      escrow = new MasumiContractEscrow(config.payment, config.masumi, options.masumiTransport, options.resolveCredential);
    }
    if (!escrow) escrow = new PaperContractEscrow(store, clock, config.paperEscrow);
    if (escrow.mode === 'live' && clock instanceof PaperClock) clock = new SystemClock();
    this.config = {...config, settings: {...config.settings, mode: escrow.mode}};
    this.escrow = escrow;
    this.clock = clock;
    this.paperClock = clock instanceof PaperClock ? clock : null;
    this.templates = options.templates ?? TemplateRegistry.fromDirectory();
    this.policies = withRecordedWeights(store, options.policies ?? DEFAULT_RELIABILITY_POLICIES);
    this.lifecycle = new ContractLifecycle({
      store,
      escrow,
      clock,
      templates: this.templates,
      settings: this.config.settings,
    });
  }

  get mode(): 'paper'|'live' {
    return this.escrow.mode;
  }

  now(): number {
    return this.clock.now();
  }

  /** Paper mode only: move paper time forward to `atMs`. Live time is real time. */
  advancePaperClock(atMs: number): void {
    if (!this.paperClock) throw new ContractError('live_time', 'only paper mode accepts `at`; live mode uses real time');
    if (atMs < this.paperClock.now() - 1_000) {
      throw new ContractError('time_backwards', 'paper time only moves forward');
    }
    this.paperClock.advanceTo(atMs);
  }

  /** Links a signing key and a preprod address to a reliability entity. Creates the entity if needed. */
  registerParty(input: {entityId: string; displayName?: string; publicKeyHex: string; cardanoAddress: string}): ContractParty {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.entityId)) {
      throw new ContractError('invalid_party', 'entityId must be 1 to 128 letters, digits, dots, colons, dashes, or underscores');
    }
    if (!isPublicKeyHex(input.publicKeyHex)) throw new ContractError('invalid_key', 'publicKeyHex must be a raw Ed25519 key (64 hex characters)');
    if (!input.cardanoAddress.startsWith('addr_test1')) {
      throw new ContractError('invalid_address', 'cardanoAddress must be a preprod address (addr_test1...)');
    }
    const party: ContractParty = {id: input.entityId, publicKeyHex: input.publicKeyHex, cardanoAddress: input.cardanoAddress};
    const existing = this.store.getContractParty(input.entityId);
    if (existing) {
      if (existing.publicKeyHex === party.publicKeyHex && existing.cardanoAddress === party.cardanoAddress) return existing;
      throw new ContractError('party_exists', `${input.entityId} already has a different contract key or address`);
    }
    const at = new Date(this.now()).toISOString();
    this.store.transaction(() => {
      const entity = this.store.getEntity(input.entityId);
      if (!entity) {
        this.store.insertEntity({
          id: input.entityId,
          displayName: input.displayName ?? input.entityId,
          wallets: [],
          kycStatus: 'unverified',
          kycTier: 'none',
          roles: ['buyer', 'seller'],
          createdAt: at,
        });
      }
      if (!entity?.wallets.includes(input.cardanoAddress)) this.store.addWallet(input.entityId, input.cardanoAddress, at);
      this.store.insertContractParty(party, at);
    });
    return party;
  }

  /** One scheduler pass, then publishes reliability updates. */
  async tick(): Promise<{published: number}> {
    await this.lifecycle.tick();
    return {published: this.publish()};
  }

  /** Moves outbox rows into the reliability tables. Safe to repeat. */
  publish(): number {
    let published = 0;
    for (const publication of this.store.listPendingContractPublications()) {
      this.store.transaction(() => {
        const transaction = publication.transaction;
        if (!this.store.getTransaction(transaction.id)) this.store.insertTransaction(transaction);
        this.store.saveOutcome(publication.outcome);
        const terminal = ['successful', 'failed', 'cancelled'].includes(publication.outcome.state);
        if (terminal && !this.store.getTransaction(transaction.id)?.completedAt) {
          this.store.setTransactionCompletedAt(transaction.id, publication.outcome.decidedAt);
        }
        projectOutcome(this.store, this.policies, transaction, publication.outcome, publication.outcome.decidedAt, publication.extraEvents);
        this.store.markContractPublicationPublished(publication.id, this.now());
      });
      published++;
    }
    return published;
  }

  /** Read model for routes and the operator UI. */
  view(contractId: string): {[key: string]: unknown} {
    const contract = this.lifecycle.getContract(contractId);
    const iso = (value: number|null|undefined) => (value === null || value === undefined ? null : new Date(value).toISOString());
    return {
      mode: contract.mode,
      custodyModel: contract.terms.custodyModel,
      now: iso(this.now()),
      contract,
      milestones: contract.milestones.map((milestone) => ({
        id: milestone.id,
        index: milestone.index,
        state: milestone.state,
        outcome: milestone.outcome,
        pending: milestone.pending?.kind ?? null,
        deadlines: milestone.deadlines ? {
          payByTime: iso(milestone.deadlines.payByTime),
          submitResultTime: iso(milestone.deadlines.submitResultTime),
          unlockTime: iso(milestone.deadlines.unlockTime),
          externalDisputeUnlockTime: iso(milestone.deadlines.externalDisputeUnlockTime),
        } : null,
        inspectionCutoffAt: iso(milestone.inspectionCutoffAt),
        tierDeadline: iso(milestone.dispute.tierDeadline),
        obligations: milestone.dispute.obligations.map((obligation) => ({...obligation, dueAt: iso(obligation.dueAt)})),
        escrows: milestone.tranches.map((tranche) => ({
          role: tranche.role, amountAtomic: tranche.amountAtomic, ref: tranche.escrowRef, onChainState: tranche.chain.onChainState,
          confirmed: tranche.chain.confirmed, settlementTxHash: tranche.chain.settlementTxHash,
        })),
        reliability: this.store.getOutcome(milestoneTransactionId(contract, milestone)) ?? null,
      })),
      operations: this.lifecycle.operations(contractId),
      auditChainIntact: this.store.verifyContractAuditChain() === null,
    };
  }
}

const services = new WeakMap<AgentStore, ContractService>();

/** One service per store, built from the process environment. */
export function contractServiceFor(store: AgentStore): ContractService {
  const existing = services.get(store);
  if (existing) return existing;
  const created = new ContractService(store);
  services.set(store, created);
  return created;
}
