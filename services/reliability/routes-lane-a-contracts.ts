/**
 * @fileoverview Contract lifecycle routes (lane A). Every party action is
 * signed with the party's Ed25519 key. These routes send no live order
 * unless both network gates are on. Read docs/contract-lifecycle.md.
 *
 * Paper mode accepts an optional `at` (ISO time) on POST bodies. It moves
 * paper time forward for demos. Live mode rejects `at`.
 */

import type {AgentStore} from '../../packages/db/src/index';
import type {MediatorRuling, PartyAction, PartyActionType} from '../../packages/reliability/src/contract-lifecycle/engine';
import {ContractError} from '../../packages/reliability/src/contract-lifecycle/errors';
import {sha256Hex} from '../../packages/reliability/src/contract-lifecycle/hashing';
import type {EvidenceInput, NegotiatedOutcome, Remedy} from '../../packages/reliability/src/contract-lifecycle/types';
import {json} from '../lib/http';
import {contractServiceFor, type ContractService} from './contract-service';
import type {ReliabilityRoute} from './route';

const STATUS_BY_CODE: {[code: string]: number} = {
  not_found: 404,
  forbidden: 403,
  bad_signature: 401,
  illegal_transition: 409,
  operation_in_flight: 409,
  funding_in_flight: 409,
  action_id_reused: 409,
  party_exists: 409,
  evidence_too_large: 413,
};

const PARTY_ACTIONS: readonly PartyActionType[] = [
  'submit_for_acceptance', 'cancel', 'deliver', 'accept', 'dispute', 'concede_refund', 'escalate',
  'submit_judge_report', 'comply_with_ruling', 'record_return_shipment', 'confirm_return_received',
  'redeliver', 'accept_redo', 'reject_redo',
];

function fail(error: unknown): Response {
  if (error instanceof ContractError) return json({error: error.message, code: error.code}, STATUS_BY_CODE[error.code] ?? 400);
  throw error;
}

function record(value: unknown, label: string): {[key: string]: unknown} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractError('invalid_input', `${label} must be an object`);
  }
  return value as {[key: string]: unknown};
}

function text(body: {[key: string]: unknown}, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') throw new ContractError('invalid_input', `${key} must be a non-empty string`);
  return value;
}

function optionalText(body: {[key: string]: unknown}, key: string): string|undefined {
  return body[key] === undefined || body[key] === null ? undefined : text(body, key);
}

async function readBody(request: Request): Promise<{[key: string]: unknown}> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ContractError('invalid_input', 'the body must be JSON');
  }
  return record(value, 'body');
}

/** Evidence over HTTP: `contentText` or `contentBase64`, plus an optional inspector signature. */
function evidenceList(value: unknown): EvidenceInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ContractError('invalid_input', 'evidence must be an array');
  return value.map((item, index) => {
    const entry = record(item, `evidence[${index}]`);
    let content: Uint8Array|string;
    if (typeof entry.contentText === 'string') content = entry.contentText;
    else if (typeof entry.contentBase64 === 'string') content = new Uint8Array(Buffer.from(entry.contentBase64, 'base64'));
    else throw new ContractError('invalid_input', `evidence[${index}] needs contentText or contentBase64`);
    const signer = entry.signer === undefined ? undefined : record(entry.signer, `evidence[${index}].signer`);
    return {
      type: text(entry, 'type'),
      content,
      mediaType: optionalText(entry, 'mediaType'),
      signer: signer ? {id: text(signer, 'id'), signatureHex: text(signer, 'signatureHex')} : undefined,
    };
  });
}

/** Applies `at` in paper mode. Rejects it in live mode. */
function applyAt(service: ContractService, body: {[key: string]: unknown}): void {
  const at = optionalText(body, 'at');
  if (at === undefined) return;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) throw new ContractError('invalid_input', 'at must be an ISO timestamp');
  service.advancePaperClock(ms);
}

/** In paper mode, run the scheduler after an action so escrow writes proceed. Live mode uses the worker. */
async function afterAction(service: ContractService): Promise<void> {
  if (service.mode === 'paper') await service.tick();
}

function serviceFor(store: AgentStore|undefined): ContractService {
  if (!store) throw new ContractError('invalid_input', 'the control store is required');
  return contractServiceFor(store);
}

function post(
  path: string, handle: (service: ContractService, body: {[key: string]: unknown}) => Promise<unknown>|unknown,
): ReliabilityRoute {
  return {
    method: 'POST',
    path,
    handler: async (request, url, store) => {
      try {
        const service = serviceFor(store);
        const body = await readBody(request);
        applyAt(service, body);
        const result = await handle(service, body);
        return json(result);
      } catch (error) {
        return fail(error);
      }
    },
  };
}

function get(path: string, handle: (service: ContractService, url: URL) => unknown): ReliabilityRoute {
  return {
    method: 'GET',
    path,
    handler: (request, url, store) => {
      try {
        return json(handle(serviceFor(store), url));
      } catch (error) {
        return fail(error);
      }
    },
  };
}

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw new ContractError('invalid_input', `${key} is required`);
  return value;
}

/** Lane A contract routes. Registered with one line in services/reliability/index.ts. */
export const laneAContractRoutes: ReliabilityRoute[] = [
  get('/reliability/contracts/templates', (service) => ({
    mode: service.mode,
    custodyModel: service.config.settings.custodyModel,
    templates: service.templates.list().map((template) => ({
      id: template.id, version: template.version, category: template.category, status: template.status,
      description: template.description, judge: template.judge.type, remedy: template.remedy, windows: template.windows,
    })),
  })),
  get('/reliability/contracts', (service, url) => service.view(requiredQuery(url, 'id'))),
  get('/reliability/contracts/terms', (service, url) => {
    const id = requiredQuery(url, 'id');
    const bytes = service.lifecycle.termsBytes(id);
    return {contractId: id, termsSha256: sha256Hex(bytes), termsBytes: bytes};
  }),
  get('/reliability/contracts/audit', (service, url) => ({
    rows: service.lifecycle.audit(requiredQuery(url, 'id')),
    chainIntact: service.view(requiredQuery(url, 'id')).auditChainIntact,
  })),
  post('/reliability/contracts/parties', (service, body) => ({
    party: service.registerParty({
      entityId: text(body, 'entityId'),
      displayName: optionalText(body, 'displayName'),
      publicKeyHex: text(body, 'publicKeyHex'),
      cardanoAddress: text(body, 'cardanoAddress'),
    }),
  })),
  post('/reliability/contracts', async (service, body) => {
    const milestones = body.milestones;
    if (!Array.isArray(milestones)) throw new ContractError('invalid_input', 'milestones must be an array');
    const contract = service.lifecycle.createContract({
      templateId: text(body, 'templateId'),
      buyerId: text(body, 'buyerId'),
      sellerId: text(body, 'sellerId'),
      milestones: milestones.map((item, index) => {
        const entry = record(item, `milestones[${index}]`);
        return {title: text(entry, 'title'), amountAtomic: text(entry, 'amountAtomic'), deliverable: record(entry.deliverable, 'deliverable')};
      }),
      remedy: body.remedy === undefined ? undefined : record(body.remedy, 'remedy') as unknown as Remedy,
      judgeInspectorId: optionalText(body, 'judgeInspectorId'),
      inspectorWhitelist: body.inspectorWhitelist === undefined ? undefined :
        (Array.isArray(body.inspectorWhitelist) ? body.inspectorWhitelist : []).map((item, index) => {
          const entry = record(item, `inspectorWhitelist[${index}]`);
          return {id: text(entry, 'id'), publicKeyHex: text(entry, 'publicKeyHex')};
        }),
    }, text(body, 'createdBy'));
    return service.view(contract.id);
  }),
  post('/reliability/contracts/sign', async (service, body) => {
    const id = text(body, 'contractId');
    service.lifecycle.signTerms(id, text(body, 'partyId'), text(body, 'signatureHex'));
    await afterAction(service);
    return service.view(id);
  }),
  post('/reliability/contracts/action', async (service, body) => {
    const payload = record(body.action, 'action');
    const action = text(payload, 'action') as PartyActionType;
    if (!PARTY_ACTIONS.includes(action)) throw new ContractError('invalid_action', `unknown action ${action}`);
    const request: PartyAction = {
      actionId: text(payload, 'actionId'),
      contractId: text(payload, 'contractId'),
      milestoneId: optionalText(payload, 'milestoneId') ?? null,
      partyId: text(payload, 'partyId'),
      action,
      evidence: evidenceList(payload.evidence),
      reason: optionalText(payload, 'reason'),
    };
    service.lifecycle.perform(request, text(body, 'signatureHex'));
    await afterAction(service);
    return service.view(request.contractId);
  }),
  post('/reliability/contracts/agree', async (service, body) => {
    const id = text(body, 'contractId');
    const outcome = text(body, 'outcome') as NegotiatedOutcome;
    service.lifecycle.agreeOutcome(id, text(body, 'milestoneId'), outcome, text(body, 'buyerSignatureHex'), text(body, 'sellerSignatureHex'));
    await afterAction(service);
    return service.view(id);
  }),
  post('/reliability/contracts/terminate', async (service, body) => {
    const id = text(body, 'contractId');
    service.lifecycle.mutualTerminate(id, text(body, 'milestoneId'), text(body, 'buyerSignatureHex'), text(body, 'sellerSignatureHex'));
    await afterAction(service);
    return service.view(id);
  }),
  post('/reliability/contracts/ruling', async (service, body) => {
    const id = text(body, 'contractId');
    const ruling = record(body.ruling, 'ruling');
    const winner = text(ruling, 'winner');
    if (winner !== 'buyer' && winner !== 'seller') throw new ContractError('invalid_ruling', 'winner must be buyer or seller');
    const parsed: MediatorRuling = {winner, reason: text(ruling, 'reason')};
    service.lifecycle.submitMediatorRuling(id, text(body, 'milestoneId'), parsed, text(body, 'signatureHex'));
    await afterAction(service);
    return service.view(id);
  }),
  post('/reliability/contracts/tick', async (service) => {
    const result = await service.tick();
    return {mode: service.mode, now: new Date(service.now()).toISOString(), ...result};
  }),
];
