/**
 * @fileoverview Session-gated app deals. The wallet session supplies the entity.
 * These routes never change the paper clock or expose operator actions.
 */

import type {AgentStore} from '../../packages/db/src/index';
import {ContractError} from '../../packages/reliability/src/contract-lifecycle/errors';
import {sha256Hex} from '../../packages/reliability/src/contract-lifecycle/hashing';
import type {Remedy} from '../../packages/reliability/src/contract-lifecycle/types';
import {json} from '../lib/http';
import {contractAnchors} from './anchors';
import {
  afterAction, contractRouteError, parsePartyAction, readBody, record, text,
} from './contract-route-helpers';
import {contractServiceFor, type ContractService} from './contract-service';
import {CoworkerTools, type ToolResult} from './coworker-tools';
import {DEFAULT_SIGN_IN_DOMAIN} from './wallet-accounts';
import {accountViewOf, sessionEntityOf} from './routes-account';
import type {ReliabilityRoute} from './route';

/** Reject clocks even inside a nested action. No app input can advance paper time. */
function rejectAt(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Object.hasOwn(value, 'at')) throw new ContractError('invalid_input', 'at is not allowed in the app edition');
  for (const child of Object.values(value)) rejectAt(child);
}

function partyContract(service: ContractService, entityId: string, id: string): void {
  const contract = service.lifecycle.getContract(id);
  if (contract.buyerId !== entityId && contract.sellerId !== entityId) {
    throw new ContractError('not_found', 'contract not found');
  }
}

function query(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw new ContractError('invalid_input', `${key} is required`);
  return value;
}

function toolValue<T>(result: ToolResult<T>): T {
  if (!result.ok) throw new ContractError(result.error.code, result.error.message);
  return result.result;
}

interface AppContext {
  store: AgentStore;
  service: ContractService;
  tools: CoworkerTools;
  entityId: string;
  url: URL;
  body: {[key: string]: unknown};
}

function route(method: string, path: string, handle: (context: AppContext) => unknown): ReliabilityRoute {
  return {
    method, path: `/reliability/app/${path}`,
    handler: async (request, url, store) => {
      try {
        // Authenticate before parsing input or checking contract existence.
        const entityId = sessionEntityOf(request, store);
        if (url.searchParams.has('at')) throw new ContractError('invalid_input', 'at is not allowed in the app edition');
        const body = method === 'POST' ? await readBody(request) : {};
        rejectAt(body);
        const service = contractServiceFor(store);
        const tools = new CoworkerTools(store, {config: service.config, templates: service.templates, now: () => service.now()});
        return json(await handle({store, service, tools, entityId, url, body}));
      } catch (error) {
        return contractRouteError(error);
      }
    },
  };
}

function contractRead(path: string, handle: (context: AppContext, id: string) => unknown): ReliabilityRoute {
  return route('GET', `contract${path}`, (context) => {
    const id = query(context.url, 'id');
    partyContract(context.service, context.entityId, id);
    return handle(context, id);
  });
}

export const appRoutes: ReliabilityRoute[] = [
  route('GET', 'me', ({store, service, entityId}) => {
    const account = accountViewOf(store, entityId);
    const party = store.getContractParty(entityId) ?? null;
    const readiness = {
      ...account.readiness, dealKey: party !== null, depositRequired: service.mode === 'live',
      canTrade: account.readiness.canTrade && party !== null && (service.mode === 'paper' || account.readiness.deposit),
      next: [
        ...(!account.readiness.wallet ? ['Connect or create a wallet.'] : []),
        ...(!account.readiness.kyc ? ['Finish mock KYC.'] : []),
        ...(!party ? ['Set up deal signing.'] : []),
        ...(service.mode === 'live' && !account.readiness.deposit ? ['Deposit preprod test funds.'] : []),
      ],
    };
    return {
      entityId, displayName: account.entity.displayName,
      signInDomain: process.env.TALLY_SIGN_IN_DOMAIN?.trim() || DEFAULT_SIGN_IN_DOMAIN,
      party: party ? {publicKeyHex: party.publicKeyHex, cardanoAddress: party.cardanoAddress ?? null} : null,
      mode: service.mode, readiness,
    };
  }),
  route('POST', 'party', ({service, entityId, body}) => {
    const cardanoAddress = text(body, 'cardanoAddress');
    // Enforce ownership even when the demo's wallet gate is off.
    if (!cardanoAddress.startsWith('addr_test1') || !service.gate.ownsAddress(entityId, cardanoAddress)) {
      throw new ContractError('wallet_required', 'Sign in with the wallet that owns this preprod payout address first.');
    }
    return {party: service.registerParty({entityId, publicKeyHex: text(body, 'publicKeyHex'), cardanoAddress})};
  }),
  route('GET', 'contracts', ({tools, entityId}) => toolValue(tools.contractSummaries({partyId: entityId}))),
  contractRead('', ({service}, id) => service.view(id)),
  contractRead('/terms', ({service}, id) => {
    const termsBytes = service.lifecycle.termsBytes(id);
    return {termsSha256: sha256Hex(termsBytes), termsBytes};
  }),
  contractRead('/audit', ({service}, id) => ({rows: service.lifecycle.audit(id), chainIntact: service.auditChainIntact()})),
  contractRead('/case', ({tools, url}, id) => {
    const milestone = query(url, 'milestone');
    return toolValue(tools.disputeCase(id, /^\d+$/.test(milestone) ? Number(milestone) : milestone));
  }),
  contractRead('/anchors', ({store}, id) => contractAnchors(store, id)),
  route('POST', 'contracts', ({service, entityId, body}) => {
    const role = text(body, 'role');
    if (role !== 'buyer' && role !== 'seller') throw new ContractError('invalid_input', 'role must be buyer or seller');
    const templateId = text(body, 'templateId');
    const template = service.templates.get(templateId);
    if (template && (template.judge.type === 'signed_report' ||
        [...template.delivery.requiredEvidence, ...template.dispute.buyerEvidence].some((rule) => rule.signedBy))) {
      throw new ContractError('inspectors_required', 'Inspector templates are not available in the app yet.');
    }
    if (!Array.isArray(body.milestones)) throw new ContractError('invalid_input', 'milestones must be an array');
    const counterpartyId = text(body, 'counterpartyId');
    const contract = service.createContract({
      templateId,
      buyerId: role === 'buyer' ? entityId : counterpartyId,
      sellerId: role === 'seller' ? entityId : counterpartyId,
      milestones: body.milestones.map((item, index) => {
        const entry = record(item, `milestones[${index}]`);
        return {title: text(entry, 'title'), amountAtomic: text(entry, 'amountAtomic'), deliverable: record(entry.deliverable, 'deliverable')};
      }),
      remedy: body.remedy === undefined ? undefined : record(body.remedy, 'remedy') as unknown as Remedy,
    }, entityId);
    return service.view(contract.id);
  }),
  route('POST', 'sign', async ({service, entityId, body}) => {
    const id = text(body, 'contractId');
    partyContract(service, entityId, id);
    service.lifecycle.signTerms(id, entityId, text(body, 'signatureHex'));
    await afterAction(service);
    return service.view(id);
  }),
  route('POST', 'action', async ({service, entityId, body}) => {
    const action = parsePartyAction(body.action);
    if (action.partyId !== entityId) throw new ContractError('forbidden', 'action.partyId must be your signed-in account');
    partyContract(service, entityId, action.contractId);
    service.lifecycle.perform(action, text(body, 'signatureHex'));
    await afterAction(service);
    return service.view(action.contractId);
  }),
];
