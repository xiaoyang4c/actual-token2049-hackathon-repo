/**
 * @fileoverview Contract routes through the control API, in paper mode.
 */

import {describe, expect, test} from 'bun:test';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {partyActionBytes, type PartyAction} from '../../packages/reliability/src/contract-lifecycle/engine';
import {generateEd25519, signBytes} from '../../packages/reliability/src/contract-lifecycle/signatures';
import {start} from '../control-api';
import {envOf} from './contract-kit';

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const FILE = 'id,price\n1,100\n';
const T0 = Date.now() + 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'contract-api-'));
  const previous = {...process.env};
  Object.assign(process.env, envOf([
    ['CARDANO_MODE', 'simulated'],
    ['CARDANO_ALLOW_NETWORK', 'false'],
    ['CONTRACT_PAPER_CONFIRMATION_MS', '1000'],
    ['CONTRACT_PAPER_AUTO_WITHDRAW_DELAY_MS', '1000'],
    ['CONTRACT_MEDIATOR_PUBLIC_KEY_HEX', generateEd25519().publicKeyHex],
  ]));
  const server = start(0, {auditFile: join(directory, 'audit.jsonl'), databasePath: join(directory, 'agent.sqlite')});
  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop(true);
    process.env = previous;
    rmSync(directory, {recursive: true, force: true});
  }
}

async function call(origin: string, path: string, body?: unknown): Promise<{status: number; body: {[key: string]: unknown}}> {
  const response = await fetch(`${origin}${path}`, body === undefined ? {} : {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
  });
  return {status: response.status, body: await response.json() as {[key: string]: unknown}};
}

/** Registers and verifies one party through the mock KYC routes. */
async function onboard(origin: string, id: string): Promise<void> {
  const documentId = `DOC-${id}`;
  const at = (offset: number) => iso(Date.now() - 3_600_000 + offset);
  expect((await call(origin, '/reliability/kyc/entities', {
    id, displayName: id, roles: ['both'], wallets: [`wallet-${id}`], kind: 'person', documentId, at: at(0),
  })).status).toBe(200);
  expect((await call(origin, '/reliability/kyc/checks', {entityId: id, kind: 'person', documentId, at: at(1_000)})).status)
    .toBe(200);
  expect((await call(origin, '/reliability/kyc/resolve', {entityId: id, at: at(2_000)})).status).toBe(200);
}

describe('contract routes', () => {
  test('a signed digital deal from registration to settlement over HTTP', async () => {
    await withServer(async (origin) => {
      const buyer = generateEd25519();
      const seller = generateEd25519();
      const unverified = await call(origin, '/reliability/contracts/parties', {
        entityId: 'buyer-http', publicKeyHex: buyer.publicKeyHex, cardanoAddress: 'addr_test1_synthetic_buyer_http',
      });
      expect(unverified.status).toBe(403);
      expect(unverified.body.code).toBe('kyc_required');
      await onboard(origin, 'buyer-http');
      await onboard(origin, 'seller-http');
      expect((await call(origin, '/reliability/contracts/parties', {entityId: 'buyer-http', publicKeyHex: buyer.publicKeyHex, cardanoAddress: 'addr_test1_synthetic_buyer_http'})).status).toBe(200);
      expect((await call(origin, '/reliability/contracts/parties', {entityId: 'seller-http', publicKeyHex: seller.publicKeyHex, cardanoAddress: 'addr_test1_synthetic_seller_http'})).status).toBe(200);

      const templates = await call(origin, '/reliability/contracts/templates');
      expect((templates.body.templates as Array<{id: string}>).map((item) => item.id)).toContain('digital-machine-checkable');

      const created = await call(origin, '/reliability/contracts', {
        templateId: 'digital-machine-checkable', buyerId: 'buyer-http', sellerId: 'seller-http', createdBy: 'buyer-http', at: iso(T0),
        milestones: [{title: 'file', amountAtomic: '3000000', deliverable: {expectedSha256: sha(FILE)}}],
      });
      expect(created.status).toBe(200);
      const contract = created.body.contract as {id: string; milestones: Array<{id: string}>};
      const contractId = contract.id;
      const milestoneId = contract.milestones[0]!.id;
      expect(created.body.mode).toBe('paper');
      expect(created.body.custodyModel).toBe('platform_custodial_test_only');
      const accepted = (created.body.milestones as Array<{feeCharge: {status: string; currency: string; principalMinor: string}}>)[0]!;
      expect(accepted.feeCharge).toMatchObject({status: 'accepted', currency: 'USDM', principalMinor: '3000000'});

      const signed = (partyId: string, key: typeof buyer, action: Omit<PartyAction, 'actionId'|'contractId'|'partyId'>) => {
        const request: PartyAction = {actionId: randomUUID(), contractId, partyId, ...action};
        const body = {...request, evidence: (request.evidence ?? []).map((item) => ({type: item.type, contentText: String(item.content)}))};
        return {action: body, signatureHex: signBytes(key.privateKey, partyActionBytes(request))};
      };

      const forged = signed('buyer-http', seller, {milestoneId: null, action: 'submit_for_acceptance'});
      expect((await call(origin, '/reliability/contracts/action', forged)).status).toBe(401);
      expect((await call(origin, '/reliability/contracts/action', signed('buyer-http', buyer, {milestoneId: null, action: 'submit_for_acceptance'}))).status).toBe(200);

      const terms = await call(origin, `/reliability/contracts/terms?id=${contractId}`);
      const bytes = String(terms.body.termsBytes);
      await call(origin, '/reliability/contracts/sign', {contractId, partyId: 'buyer-http', signatureHex: signBytes(buyer.privateKey, bytes)});
      await call(origin, '/reliability/contracts/sign', {contractId, partyId: 'seller-http', signatureHex: signBytes(seller.privateKey, bytes)});

      const tickAt = async (ms: number) => call(origin, '/reliability/contracts/tick', {at: iso(ms)});
      let now = T0;
      const advanceUntil = async (state: string) => {
        for (let step = 0; step < 20; step++) {
          const view = await call(origin, `/reliability/contracts?id=${contractId}`);
          if ((view.body.milestones as Array<{state: string}>)[0]!.state === state) return view;
          now += 1_500;
          await tickAt(now);
        }
        throw new Error(`did not reach ${state}`);
      };
      await advanceUntil('funded');

      const delivered = await call(origin, '/reliability/contracts/action', signed('seller-http', seller, {
        milestoneId, action: 'deliver', evidence: [{type: 'content_file', content: FILE}],
      }));
      expect(delivered.status).toBe(200);
      await advanceUntil('in_inspection');
      expect((await call(origin, '/reliability/contracts/action', signed('buyer-http', buyer, {milestoneId, action: 'accept'}))).status).toBe(200);

      const view = await call(origin, `/reliability/contracts?id=${contractId}`);
      const unlock = Date.parse(String((view.body.milestones as Array<{deadlines: {unlockTime: string}}>)[0]!.deadlines.unlockTime));
      now = unlock + 1_000;
      await tickAt(now);
      const settled = await advanceUntil('settled');
      const reliability = (settled.body.milestones as Array<{reliability: {state: string}}>)[0]!.reliability;
      expect(reliability.state).toBe('successful');
      expect((settled.body.milestones as Array<{feeCharge: {status: string}}>)[0]!.feeCharge.status).toBe('collected');
      expect(settled.body.auditChainIntact).toBe(true);

      const audit = await call(origin, `/reliability/contracts/audit?id=${contractId}`);
      expect((audit.body.rows as Array<{mode: string}>).every((row) => row.mode === 'paper')).toBe(true);
    });
  });

  test('errors map to clear statuses', async () => {
    await withServer(async (origin) => {
      expect((await call(origin, '/reliability/contracts?id=missing')).status).toBe(404);
      expect((await call(origin, '/reliability/contracts', {templateId: 'x'})).status).toBe(400);
      expect((await call(origin, '/reliability/contracts/parties', {entityId: 'p', publicKeyHex: 'zz', cardanoAddress: 'addr_test1_x'})).status).toBe(400);
      expect((await call(origin, '/reliability/contracts/tick', {at: iso(Date.now() - 3_600_000)})).status).toBe(400);
    });
  });
});
