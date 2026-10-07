/** Shared contract route validation and error responses. */

import type {PartyAction, PartyActionType} from '../../packages/reliability/src/contract-lifecycle/engine';
import {ContractError} from '../../packages/reliability/src/contract-lifecycle/errors';
import type {EvidenceInput} from '../../packages/reliability/src/contract-lifecycle/types';
import {json} from '../lib/http';
import type {ContractService} from './contract-service';
import {MarketplaceRuleError} from './marketplace-gate';
import {AccountError} from './wallet-accounts';

export const STATUS_BY_CODE: {[code: string]: number} = {
  not_found: 404,
  forbidden: 403,
  bad_signature: 401,
  illegal_transition: 409,
  operation_in_flight: 409,
  funding_in_flight: 409,
  action_id_reused: 409,
  party_exists: 409,
  kyc_required: 403,
  wallet_required: 403,
  evidence_too_large: 413,
  not_in_tier_3: 409,
};

const PARTY_ACTIONS: readonly PartyActionType[] = [
  'submit_for_acceptance', 'cancel', 'deliver', 'accept', 'dispute', 'concede_refund', 'escalate',
  'submit_judge_report', 'comply_with_ruling', 'record_return_shipment', 'confirm_return_received',
  'redeliver', 'accept_redo', 'reject_redo',
];

export function contractRouteError(error: unknown): Response {
  if (error instanceof AccountError) return json({error: error.message, code: error.code}, error.status);
  if (error instanceof MarketplaceRuleError) {
    return json({error: error.message, code: 'deal_not_allowed', violations: error.violations}, 403);
  }
  if (error instanceof ContractError) return json({error: error.message, code: error.code}, STATUS_BY_CODE[error.code] ?? 400);
  throw error;
}

export function record(value: unknown, label: string): {[key: string]: unknown} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractError('invalid_input', `${label} must be an object`);
  }
  return value as {[key: string]: unknown};
}

export function text(body: {[key: string]: unknown}, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') throw new ContractError('invalid_input', `${key} must be a non-empty string`);
  return value;
}

export function optionalText(body: {[key: string]: unknown}, key: string): string|undefined {
  return body[key] === undefined || body[key] === null ? undefined : text(body, key);
}

export async function readBody(request: Request): Promise<{[key: string]: unknown}> {
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

/** Parses the HTTP action once for the demo and app routes. */
export function parsePartyAction(value: unknown): PartyAction {
  const payload = record(value, 'action');
  const action = text(payload, 'action') as PartyActionType;
  if (!PARTY_ACTIONS.includes(action)) throw new ContractError('invalid_action', `unknown action ${action}`);
  return {
    actionId: text(payload, 'actionId'),
    contractId: text(payload, 'contractId'),
    milestoneId: optionalText(payload, 'milestoneId') ?? null,
    partyId: text(payload, 'partyId'),
    action,
    evidence: evidenceList(payload.evidence),
    reason: optionalText(payload, 'reason'),
  };
}

/** Paper escrow progresses after a party action. Live escrow uses the worker. */
export async function afterAction(service: ContractService): Promise<void> {
  if (service.mode === 'paper') await service.tick();
}
