/**
 * @fileoverview Demo routes for mock KYC onboarding.
 */

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../../packages/db/src/index';
import {start} from '../control-api';

const T0 = '2026-10-06T00:00:00.000Z';
const T1 = '2026-10-06T00:01:00.000Z';
const T2 = '2026-10-06T00:02:00.000Z';
const T3 = '2026-10-06T00:03:00.000Z';

async function withServer(
  run: (origin: string, databasePath: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'kyc-api-'));
  const databasePath = join(directory, 'agent.sqlite');
  const server = start(0, {
    auditFile: join(directory, 'audit.jsonl'),
    databasePath,
  });
  try {
    await run(`http://127.0.0.1:${server.port}`, databasePath);
  } finally {
    await server.stop(true);
    rmSync(directory, {recursive: true, force: true});
  }
}

async function post(
  origin: string, path: string, body: unknown,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
}

describe('KYC demo routes', () => {
  test('registers, verifies, expires, and flags a person', async () => {
    await withServer(async (origin, databasePath) => {
      const created = await post(origin, '/reliability/kyc/entities', {
        id: 'route-ada',
        displayName: 'Ada',
        roles: ['both'],
        wallets: ['wallet-route-ada'],
        kind: 'person',
        documentId: 'DOC-100',
        at: T0,
      });
      expect(created.status).toBe(200);
      const registered = await created.json() as {
        status: string; entity: {roles: string[]};
      };
      expect(registered.status).toBe('unverified');
      expect(registered.entity.roles).toEqual(['buyer', 'seller']);

      expect((await post(origin, '/reliability/kyc/checks', {
        entityId: 'route-ada',
        kind: 'person',
        documentId: 'DOC-100',
        addressChecked: true,
        at: T1,
      })).status).toBe(200);
      const resolved = await (await post(origin, '/reliability/kyc/resolve', {
        entityId: 'route-ada',
        at: T2,
      })).json() as {tier: string; badge: string; countsAsVerified: boolean};
      expect(resolved.tier).toBe('enhanced');
      expect(resolved.badge).toBe('verified');
      expect(resolved.countsAsVerified).toBe(true);

      const expired = await (await post(origin, '/reliability/kyc/expire', {
        entityId: 'route-ada',
        at: T3,
        force: true,
      })).json() as {badge: string; status: string; policyInput: {badge: string}};
      expect(expired.badge).toBe('expired');
      expect(expired.status).toBe('unverified');
      expect(expired.policyInput.badge).toBe('expired');

      const view = await (await fetch(
        `${origin}/reliability/kyc?entityId=route-ada`,
      )).json() as {badge: string; history: {how: string}[]};
      expect(view.badge).toBe('expired');
      expect(view.history.map((row) => row.how)).toEqual([
        'registered', 'check_submitted', 'vendor_approved', 'expired',
      ]);

      const flagged = await (await post(origin, '/reliability/kyc/entities', {
        id: 'route-ada-2',
        displayName: 'Ada two',
        roles: ['buyer'],
        wallets: ['wallet-route-ada-2'],
        kind: 'person',
        documentId: 'DOC-100',
        at: T3,
      })).json() as {
        reRegistration: {ofEntityId: string; signal: string; matchedValue: string};
      };
      expect(flagged.reRegistration).toEqual({
        ofEntityId: 'route-ada',
        signal: 'document',
        matchedValue: 'DOC-100',
      });

      const store = AgentStore.open(databasePath);
      try {
        expect(store.getEntity('route-ada')?.kycStatus).toBe('unverified');
        expect(store.getKycProfile('route-ada-2')?.reRegistrationOf).toBe(
          'route-ada',
        );
      } finally {
        store.close();
      }
    });
  });

  test('returns fixture badges and rejects a bad body', async () => {
    await withServer(async (origin) => {
      const fixtures = await (await fetch(`${origin}/reliability/kyc/fixtures`)).json() as {
        provider: string;
        rulesVersion: string;
        cases: {badge: string}[];
      };
      expect(fixtures.provider).toBe('mock-kyc-provider');
      expect(fixtures.rulesVersion).toBe('kyc-tier-rules-v0-undecided');
      expect(new Set(fixtures.cases.map((row) => row.badge))).toEqual(new Set([
        'unverified', 'pending', 'verified', 'rejected', 'expired',
      ]));
      expect((await fetch(`${origin}/reliability/kyc`)).status).toBe(400);
      expect((await fetch(`${origin}/reliability/kyc?entityId=missing`)).status).toBe(404);
      const bad = await post(origin, '/reliability/kyc/entities', {kind: 'ship'});
      expect(bad.status).toBe(400);
      const body = await bad.json() as {code: string};
      expect(body.code).toBe('bad_input');

      for (const raw of ['{bad', '']) {
        const malformed = await fetch(`${origin}/reliability/kyc/entities`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: raw,
        });
        expect(malformed.status).toBe(400);
        expect(await malformed.json()).toEqual({
          error: 'invalid JSON', code: 'bad_input',
        });
      }
    });
  });
});
