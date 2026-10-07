/**
 * @fileoverview Contract lifecycle routes (lane A). Every party action is
 * signed with the party's Ed25519 key. These routes send no live order
 * unless both network gates are on. Read docs/contract-lifecycle.md.
 *
 * Paper mode accepts an optional `at` (ISO time) on POST bodies. It moves
 * paper time forward for demos. Live mode rejects `at`.
 */

import type {AgentStore} from '../../packages/db/src/index';
import type {MediatorRuling} from '../../packages/reliability/src/contract-lifecycle/engine';
import {ContractError} from '../../packages/reliability/src/contract-lifecycle/errors';
import {sha256Hex} from '../../packages/reliability/src/contract-lifecycle/hashing';
import type {NegotiatedOutcome, Remedy} from '../../packages/reliability/src/contract-lifecycle/types';
import {json} from '../lib/http';
import {companyAnchors, contractAnchors} from './anchors';
import {contractServiceFor, type ContractService} from './contract-service';
import {CoworkerTools, type DraftInput, type ToolResult} from './coworker-tools';
import type {ReliabilityRoute} from './route';
import {afterAction, contractRouteError, optionalText, parsePartyAction, readBody, record, STATUS_BY_CODE, text} from './contract-route-helpers';

/** Applies `at` in paper mode. Rejects it in live mode. */
function applyAt(service: ContractService, body: {[key: string]: unknown}): void {
  const at = optionalText(body, 'at');
  if (at === undefined) return;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) throw new ContractError('invalid_input', 'at must be an ISO timestamp');
  service.advancePaperClock(ms);
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
        return contractRouteError(error);
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
        return contractRouteError(error);
      }
    },
  };
}

/**
 * A read route served by the Coworker tools, so the operator UI shows the
 * same engine numbers as the Coworkers. A tool error becomes an HTTP error.
 */
function toolGet(path: string, handle: (tools: CoworkerTools, url: URL) => ToolResult<unknown>): ReliabilityRoute {
  return {
    method: 'GET',
    path,
    handler: (request, url, store) => {
      try {
        const service = serviceFor(store);
        const tools = new CoworkerTools(store ?? null, {config: service.config, templates: service.templates, now: () => service.now()});
        const result = handle(tools, url);
        if (!result.ok) return json({error: result.error.message, code: result.error.code}, STATUS_BY_CODE[result.error.code] ?? 400);
        return json(result.result);
      } catch (error) {
        return contractRouteError(error);
      }
    },
  };
}

/** A read route over the stored settlement anchors. It never reaches the chain. */
function anchorGet(path: string, handle: (store: AgentStore, url: URL) => unknown): ReliabilityRoute {
  return {
    method: 'GET',
    path,
    handler: (request, url, store) => {
      try {
        return json(handle(store, url));
      } catch (error) {
        return contractRouteError(error);
      }
    },
  };
}

/** The Deal Desk draft input, sent as JSON in the `input` query. */
function draftInput(raw: string): DraftInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ContractError('invalid_input', 'input must be JSON');
  }
  return record(parsed, 'input') as unknown as DraftInput;
}

/** A milestone by number (0, 1, ...) or by id. */
function milestoneRef(url: URL): number|string {
  const value = requiredQuery(url, 'milestone');
  return /^\d+$/.test(value) ? Number(value) : value;
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
    const contract = service.createContract({
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
    const request = parsePartyAction(body.action);
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
  // Read views for the operator UI. They use the Coworker tools.
  toolGet('/reliability/contracts/list', (tools, url) => tools.contractSummaries({
    partyId: url.searchParams.get('partyId') ?? undefined,
    disputesOnly: url.searchParams.get('disputes') === '1',
  })),
  toolGet('/reliability/contracts/case', (tools, url) => tools.disputeCase(requiredQuery(url, 'id'), milestoneRef(url))),
  toolGet('/reliability/contracts/ruling-options', (tools, url) => tools.rulingOptions(requiredQuery(url, 'id'), milestoneRef(url))),
  toolGet('/reliability/contracts/ruling-payload', (tools, url) => {
    const winner = requiredQuery(url, 'winner');
    if (winner !== 'buyer' && winner !== 'seller') throw new ContractError('invalid_ruling', 'winner must be buyer or seller');
    return tools.rulingSigningPayload(requiredQuery(url, 'id'), milestoneRef(url), winner, requiredQuery(url, 'reason'));
  }),
  toolGet('/reliability/profile', (tools, url) => tools.reliabilityProfile(requiredQuery(url, 'entityId'), {
    counterpartyId: url.searchParams.get('counterpartyId') ?? undefined,
  })),
  toolGet('/reliability/profile/search', (tools, url) => tools.findEntities(requiredQuery(url, 'q'))),
  // Settlement anchors: fingerprints of final records, each company's chain, and the Cardano transactions.
  anchorGet('/reliability/anchors/contract', (store, url) => contractAnchors(store, requiredQuery(url, 'id'))),
  anchorGet('/reliability/anchors/company', (store, url) => companyAnchors(store, requiredQuery(url, 'entityId'))),
  // Deal Desk views. Templates with their deliverable fields, and a draft that
  // runs createContract in an in-memory sandbox. Both only read, so both are GET.
  toolGet('/reliability/contracts/draft-templates', (tools) => ({ok: true, result: tools.listTemplates()})),
  toolGet('/reliability/contracts/draft', (tools, url) => tools.draftContract(draftInput(requiredQuery(url, 'input')))),
  post('/reliability/contracts/tick', async (service) => {
    const result = await service.tick();
    return {mode: service.mode, now: new Date(service.now()).toISOString(), ...result};
  }),
];
