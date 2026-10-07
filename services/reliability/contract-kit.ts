/**
 * @fileoverview Demo and test kit for the contract lifecycle: synthetic
 * parties with Ed25519 keys, a manual clock, and helpers that sign party
 * actions. Paper mode only. Nothing here touches a chain.
 */

import {randomUUID, type KeyObject} from 'node:crypto';
import {AgentStore} from '../../packages/db/src/index';
import {
  mediatorRulingBytes, mutualTerminationBytes, outcomeAgreementBytes, partyActionBytes,
  type MediatorRuling, type PartyAction, type PartyActionType,
} from '../../packages/reliability/src/contract-lifecycle/engine';
import {canonicalize} from '../../packages/reliability/src/contract-lifecycle/canonical-json';
import type {ContractClock} from '../../packages/reliability/src/contract-lifecycle/ports';
import {generateEd25519, signBytes, type Ed25519KeyPair} from '../../packages/reliability/src/contract-lifecycle/signatures';
import type {
  Contract, EvidenceInput, Milestone, MilestoneState, NegotiatedOutcome,
} from '../../packages/reliability/src/contract-lifecycle/types';
import type {ApiTransport, CredentialResolver} from '../cardano-agents-ts/types';
import {loadContractConfig} from './contract-config';
import {ContractService} from './contract-service';

/** Time moves only when a test or a demo moves it. */
export class ManualClock implements ContractClock {
  constructor(private current: number) {}

  now(): number {
    return this.current;
  }

  set(ms: number): void {
    if (ms < this.current) throw new Error('the manual clock does not go back');
    this.current = ms;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export interface KitKeys {
  buyer: Ed25519KeyPair;
  seller: Ed25519KeyPair;
  sellerLab: Ed25519KeyPair;
  judge: Ed25519KeyPair;
  mediator: Ed25519KeyPair;
}

export const INSPECTORS = {sellerLab: 'inspector-seller-lab', judge: 'inspector-named-judge'} as const;

/** Paper-mode settings for tests. Shorter paper waits than production; same rules. */
export const KIT_ENV: Record<string, string> = envOf([
  ['CARDANO_MODE', 'simulated'],
  ['CARDANO_ALLOW_NETWORK', 'false'],
  ['CONTRACT_PAPER_CONFIRMATION_MS', '3000'],
  ['CONTRACT_PAPER_AUTO_WITHDRAW_DELAY_MS', '30000'],
  ['CONTRACT_WORKER_ID', 'test-worker'],
]);

/** Builds an environment map from [name, value] pairs, on top of a base map. */
export function envOf(pairs: Array<[string, string]>, base: Record<string, string> = {}): Record<string, string> {
  return {...base, ...Object.fromEntries(pairs)};
}

export interface Kit {
  store: AgentStore;
  service: ContractService;
  clock: ManualClock;
  keys: KitKeys;
  buyerId: string;
  sellerId: string;
  close(): void;
}

export interface KitOptions {
  databasePath?: string;
  clock?: ManualClock;
  keys?: KitKeys;
  env?: Record<string, string>;
  ids?: {buyer: string; seller: string};
  masumiTransport?: ApiTransport;
  resolveCredential?: CredentialResolver;
  /** Reopen an existing database: skip party registration. */
  reuseParties?: boolean;
}

export const KIT_START = Date.UTC(2026, 9, 6, 9, 0, 0);

export function createKit(options: KitOptions = {}): Kit {
  const keys = options.keys ?? {
    buyer: generateEd25519(),
    seller: generateEd25519(),
    sellerLab: generateEd25519(),
    judge: generateEd25519(),
    mediator: generateEd25519(),
  };
  const clock = options.clock ?? new ManualClock(KIT_START);
  const store = AgentStore.open(options.databasePath ?? ':memory:');
  const config = loadContractConfig({
    ...envOf([['CONTRACT_MEDIATOR_PUBLIC_KEY_HEX', keys.mediator.publicKeyHex]], KIT_ENV),
    ...options.env,
  });
  const service = new ContractService(store, {config, clock, masumiTransport: options.masumiTransport, resolveCredential: options.resolveCredential});
  const ids = options.ids ?? {buyer: 'buyer-acme', seller: 'seller-globex'};
  if (!options.reuseParties) {
    // Key registration needs KYC-verified entities. Synthetic parties are
    // verified directly in the store, as the mock KYC flow would record them.
    for (const id of [ids.buyer, ids.seller]) {
      if (store.getEntity(id)) continue;
      store.insertEntity({
        id, displayName: id, wallets: [], roles: ['buyer', 'seller'],
        kycStatus: 'verified', kycTier: 'basic', createdAt: new Date(clock.now()).toISOString(),
      });
    }
    // Synthetic parties. The addresses are placeholders, not wallets.
    service.registerParty({entityId: ids.buyer, publicKeyHex: keys.buyer.publicKeyHex, cardanoAddress: `addr_test1_synthetic_${ids.buyer}`});
    service.registerParty({entityId: ids.seller, publicKeyHex: keys.seller.publicKeyHex, cardanoAddress: `addr_test1_synthetic_${ids.seller}`});
  }
  return {store, service, clock, keys, buyerId: ids.buyer, sellerId: ids.seller, close: () => store.close()};
}

export function inspectorWhitelist(kit: Kit): Array<{id: string; publicKeyHex: string}> {
  return [
    {id: INSPECTORS.sellerLab, publicKeyHex: kit.keys.sellerLab.publicKeyHex},
    {id: INSPECTORS.judge, publicKeyHex: kit.keys.judge.publicKeyHex},
  ];
}

export function sign(key: KeyObject, bytes: string|Uint8Array): string {
  return signBytes(key, bytes);
}

function partyKey(kit: Kit, partyId: string): KeyObject {
  if (partyId === kit.buyerId) return kit.keys.buyer.privateKey;
  if (partyId === kit.sellerId) return kit.keys.seller.privateKey;
  throw new Error(`the kit has no key for ${partyId}`);
}

/** Builds, signs, and performs one party action. */
export function act(
  kit: Kit, contractId: string, partyId: string, action: PartyActionType,
  options: {milestoneId?: string|null; evidence?: EvidenceInput[]; reason?: string; actionId?: string} = {},
): Contract {
  const request: PartyAction = {
    actionId: options.actionId ?? randomUUID(),
    contractId,
    milestoneId: options.milestoneId ?? null,
    partyId,
    action,
    evidence: options.evidence,
    reason: options.reason,
  };
  return kit.service.lifecycle.perform(request, sign(partyKey(kit, partyId), partyActionBytes(request)));
}

/** Submit the terms and collect both signatures. Funding is journaled after this. */
export function acceptTerms(kit: Kit, contractId: string): Contract {
  act(kit, contractId, kit.buyerId, 'submit_for_acceptance');
  const bytes = kit.service.lifecycle.termsBytes(contractId);
  kit.service.lifecycle.signTerms(contractId, kit.buyerId, sign(kit.keys.buyer.privateKey, bytes));
  return kit.service.lifecycle.signTerms(contractId, kit.sellerId, sign(kit.keys.seller.privateKey, bytes));
}

export function milestone(kit: Kit, contractId: string, index = 0): Milestone {
  const found = kit.service.lifecycle.getContract(contractId).milestones[index];
  if (!found) throw new Error(`no milestone ${index}`);
  return found;
}

/** Steps time and ticks until the milestone reaches `state`. */
export async function runUntil(
  kit: Kit, contractId: string, state: MilestoneState, options: {index?: number; stepMs?: number; maxSteps?: number} = {},
): Promise<Milestone> {
  const stepMs = options.stepMs ?? kit.service.config.paperEscrow.confirmationDelayMs + 1;
  const maxSteps = options.maxSteps ?? 60;
  for (let step = 0; step <= maxSteps; step++) {
    const current = milestone(kit, contractId, options.index ?? 0);
    if (current.state === state) return current;
    kit.clock.advance(stepMs);
    await kit.service.tick();
  }
  const stuck = milestone(kit, contractId, options.index ?? 0);
  throw new Error(`milestone did not reach ${state}; it is ${stuck.state}, pending ${stuck.pending?.kind ?? 'none'}`);
}

export async function settleTicks(kit: Kit, count = 3): Promise<void> {
  for (let step = 0; step < count; step++) {
    kit.clock.advance(kit.service.config.paperEscrow.confirmationDelayMs + 1);
    await kit.service.tick();
  }
}

/** Every obligated party carries out the ruling. */
export function complyAll(kit: Kit, contractId: string, index = 0): void {
  const current = milestone(kit, contractId, index);
  for (const obligation of current.dispute.obligations) {
    if (obligation.compliedAt !== null || obligation.forcedAt !== null) continue;
    act(kit, contractId, obligation.party === 'buyer' ? kit.buyerId : kit.sellerId, 'comply_with_ruling', {milestoneId: current.id});
  }
}

export function agreeOutcome(kit: Kit, contractId: string, milestoneId: string, outcome: NegotiatedOutcome): Contract {
  const bytes = outcomeAgreementBytes(contractId, milestoneId, outcome);
  return kit.service.lifecycle.agreeOutcome(contractId, milestoneId, outcome,
    sign(kit.keys.buyer.privateKey, bytes), sign(kit.keys.seller.privateKey, bytes));
}

export function terminate(kit: Kit, contractId: string, milestoneId: string): Contract {
  const bytes = mutualTerminationBytes(contractId, milestoneId);
  return kit.service.lifecycle.mutualTerminate(contractId, milestoneId,
    sign(kit.keys.buyer.privateKey, bytes), sign(kit.keys.seller.privateKey, bytes));
}

export function mediatorRuling(kit: Kit, contractId: string, milestoneId: string, ruling: MediatorRuling): string {
  return sign(kit.keys.mediator.privateKey, mediatorRulingBytes(contractId, milestoneId, ruling));
}

export function signedDocument(
  key: KeyObject, signerId: string, type: string, document: {[key: string]: unknown},
): EvidenceInput {
  const content = canonicalize(document);
  return {type, content, mediaType: 'application/json', signer: {id: signerId, signatureHex: sign(key, content)}};
}

export function labReport(
  kit: Kit, contractId: string, milestoneId: string, verdict: 'PASS'|'FAIL', signer: 'judge'|'sellerLab' = 'judge',
): EvidenceInput {
  const key = signer === 'judge' ? kit.keys.judge : kit.keys.sellerLab;
  const id = signer === 'judge' ? INSPECTORS.judge : INSPECTORS.sellerLab;
  return signedDocument(key.privateKey, id, 'lab_report', {
    schema: 'lab-report.v1',
    contractId,
    milestoneId,
    inspectorId: id,
    verdict,
    findings: verdict === 'PASS' ? 'Moisture 11.8% (spec 12.5% or less). Grade A.' : 'Moisture 15.9% (spec 12.5% or less). Grade C, below the agreed Grade A.',
  });
}

export function physicalDelivery(kit: Kit, contractId: string, milestoneId: string): EvidenceInput[] {
  return [
    signedDocument(kit.keys.sellerLab.privateKey, INSPECTORS.sellerLab, 'inspection_certificate', {
      schema: 'inspection-certificate.v1',
      contractId,
      milestoneId,
      inspectorId: INSPECTORS.sellerLab,
      verdict: 'PASS',
      findings: 'Pre-shipment: moisture 11.9%, Grade A.',
    }),
    {type: 'dispatch_photo', content: 'SYNTHETIC-PHOTO: container MSKU1234565 loaded, 20 bags', mediaType: 'image/jpeg'},
    {type: 'seal_id', content: 'SEAL ML-SG-0042917', mediaType: 'text/plain'},
  ];
}
