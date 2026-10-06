/**
 * @fileoverview Lane A onboarding and KYC routes.
 * The mock check does not call a live vendor. The operator UI reads
 * GET /reliability/kyc and the fixture list. POST routes exist so a
 * demo can move an entity through each case.
 *
 * The store is process-local. Lane routes do not edit
 * services/control-api.ts, so they cannot share that database.
 * Call MockKycProvider with kycRecordStore(store) when you have
 * the control AgentStore.
 */

import {AgentStore, kycRecordStore} from '../../packages/db/src/index';
import {
  DEMO_KYC_SCRIPTS,
  KYC_FIXTURE_CASES,
  KYC_TIER_RULES,
  KycFlowError,
  MOCK_KYC_PROVIDER_NAME,
  MockKycProvider,
  type KycCheckInput,
  type RegisterEntityInput,
} from '../../packages/reliability/src/index';
import {json, readJson} from '../lib/http';
import type {ReliabilityRoute} from './routes-plumbing';

const provider = new MockKycProvider(new Map(), {
  store: kycRecordStore(AgentStore.open()),
});

function isRecord(value: unknown): value is {[key: string]: unknown} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(error: unknown): Response {
  if (error instanceof KycFlowError) {
    const status = error.code === 'unknown_entity' ? 404 : 400;
    return json({error: error.message, code: error.code}, status);
  }
  throw error;
}

function readBody(value: unknown): {[key: string]: unknown} {
  if (!isRecord(value)) {
    throw new KycFlowError('bad_input', 'body must be an object');
  }
  return value;
}

function optionalString(
  body: {[key: string]: unknown}, key: string,
): string|undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new KycFlowError('bad_input', `${key} must be a string`);
  }
  return value;
}

function requiredString(body: {[key: string]: unknown}, key: string): string {
  const value = optionalString(body, key);
  if (value === undefined) {
    throw new KycFlowError('bad_input', `${key} must be a string`);
  }
  return value;
}

function readStringList(
  body: {[key: string]: unknown}, key: string,
): string[] {
  const value = body[key];
  if (!Array.isArray(value)) {
    throw new KycFlowError('bad_input', `${key} must be a list`);
  }
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new KycFlowError('bad_input', `${key} must be a list of strings`);
    }
    items.push(entry);
  }
  return items;
}

function atOf(body: {[key: string]: unknown}): string {
  return optionalString(body, 'at') ?? new Date().toISOString();
}

function parseRegister(value: unknown): RegisterEntityInput {
  const body = readBody(value);
  const kind = requiredString(body, 'kind');
  const common = {
    id: requiredString(body, 'id'),
    displayName: requiredString(body, 'displayName'),
    roles: readStringList(body, 'roles'),
    wallets: readStringList(body, 'wallets'),
    at: atOf(body),
  };
  if (kind === 'person') {
    return {...common, kind, documentId: optionalString(body, 'documentId')};
  }
  if (kind === 'business') {
    return {
      ...common,
      kind,
      registrationNumber: optionalString(body, 'registrationNumber'),
      beneficialOwnerDocumentId: optionalString(body, 'beneficialOwnerDocumentId'),
    };
  }
  throw new KycFlowError('bad_input', 'kind must be person or business');
}

function parseCheck(value: unknown): KycCheckInput {
  const body = readBody(value);
  const kind = requiredString(body, 'kind');
  const entityId = requiredString(body, 'entityId');
  const at = atOf(body);
  if (kind === 'person') {
    const address = body.addressChecked;
    if (address !== undefined && typeof address !== 'boolean') {
      throw new KycFlowError('bad_input', 'addressChecked must be a boolean');
    }
    return {
      kind,
      entityId,
      at,
      documentId: requiredString(body, 'documentId'),
      addressChecked: address,
    };
  }
  if (kind === 'business') {
    return {
      kind,
      entityId,
      at,
      registrationNumber: requiredString(body, 'registrationNumber'),
      beneficialOwnerDocumentId: optionalString(body, 'beneficialOwnerDocumentId'),
    };
  }
  throw new KycFlowError('bad_input', 'kind must be person or business');
}

function parseEntityId(value: unknown): {entityId: string; at: string} {
  const body = readBody(value);
  return {entityId: requiredString(body, 'entityId'), at: atOf(body)};
}

/** Lane A KYC routes. Register this array with one line. */
export const laneAKycRoutes: ReliabilityRoute[] = [
  {
    method: 'GET',
    path: '/reliability/kyc/fixtures',
    handler: () => json({
      provider: MOCK_KYC_PROVIDER_NAME,
      rulesVersion: KYC_TIER_RULES.version,
      verifiedRule: KYC_TIER_RULES.countsAsVerified,
      scripts: DEMO_KYC_SCRIPTS,
      cases: KYC_FIXTURE_CASES,
    }),
  },
  {
    method: 'GET',
    path: '/reliability/kyc',
    handler: (request, url) => {
      const entityId = url.searchParams.get('entityId');
      if (!entityId) {
        return json({error: 'entityId is required', code: 'bad_input'}, 400);
      }
      try {
        return json(provider.view(entityId));
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    method: 'POST',
    path: '/reliability/kyc/entities',
    handler: async (request) => {
      try {
        const body = parseRegister(await readJson<unknown>(request));
        return json(provider.registerEntity(body));
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    method: 'POST',
    path: '/reliability/kyc/wallets',
    handler: async (request) => {
      try {
        const body = readBody(await readJson<unknown>(request));
        return json(provider.attachWallet(
          requiredString(body, 'entityId'),
          requiredString(body, 'wallet'),
          atOf(body),
        ));
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    method: 'POST',
    path: '/reliability/kyc/checks',
    handler: async (request) => {
      try {
        const body = parseCheck(await readJson<unknown>(request));
        return json(provider.submitCheck(body));
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    method: 'POST',
    path: '/reliability/kyc/resolve',
    handler: async (request) => {
      try {
        const parsed = parseEntityId(await readJson<unknown>(request));
        return json(provider.resolveCheck(parsed.entityId, parsed.at));
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    method: 'POST',
    path: '/reliability/kyc/expire',
    handler: async (request) => {
      try {
        const body = readBody(await readJson<unknown>(request));
        const force = body.force;
        if (force !== undefined && typeof force !== 'boolean') {
          throw new KycFlowError('bad_input', 'force must be a boolean');
        }
        return json(provider.expireVerification(
          requiredString(body, 'entityId'),
          atOf(body),
          force === true,
        ));
      } catch (error) {
        return fail(error);
      }
    },
  },
];
