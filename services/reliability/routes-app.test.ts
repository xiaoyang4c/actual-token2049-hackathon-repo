/** App route authentication, isolation, and signed paper settlement over HTTP. */

import {describe, expect, test} from 'bun:test';
import * as cardano from '@emurgo/cardano-serialization-lib-nodejs';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../../packages/db/src/index';
import {partyActionBytes, type PartyAction} from '../../packages/reliability/src/contract-lifecycle/engine';
import {generateEd25519, signBytes} from '../../packages/reliability/src/contract-lifecycle/signatures';
import type {Contract} from '../../packages/reliability/src/contract-lifecycle/types';
import {startMarketplace} from '../control-api';
import {CborMap, encodeCbor} from './cbor';
import {ContractService} from './contract-service';
import {appRoutes} from './routes-app';

const harden = (n: number) => 0x80000000 + n;

function wallet(seed: number) {
  const account = cardano.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(32).fill(seed), new Uint8Array())
    .derive(harden(1852)).derive(harden(1815)).derive(harden(0));
  const payment = account.derive(0).derive(0).to_raw_key();
  const stake = account.derive(2).derive(0).to_raw_key();
  const credential = (key: cardano.PrivateKey) => cardano.Credential.from_keyhash(key.to_public().hash());
  return {
    stake,
    base: cardano.BaseAddress.new(0, credential(payment), credential(stake)).to_address().to_bech32('addr_test'),
    reward: cardano.RewardAddress.new(0, credential(stake)).to_address().to_bech32('stake_test'),
  };
}

function signData(key: cardano.PrivateKey, address: string, message: string) {
  const protectedBytes = encodeCbor(new CborMap([[1, -8], ['address', cardano.Address.from_bech32(address).to_bytes()]]));
  const payload = new TextEncoder().encode(message);
  const signature = key.sign(encodeCbor(['Signature1', protectedBytes, new Uint8Array(), payload])).to_bytes();
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
  return {
    signature: hex(encodeCbor([protectedBytes, new CborMap([['hashed', false]]), payload, signature])),
    key: hex(encodeCbor(new CborMap([[1, 1], [3, -8], [-1, 6], [-2, key.to_public().as_bytes()]]))),
  };
}

async function withServer(run: (origin: string, store: AgentStore, worker: ContractService) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'app-api-'));
  const previous = {...process.env};
  Object.assign(process.env, Object.fromEntries([
    ['CARDANO_MODE', 'simulated'], ['CARDANO_ALLOW_NETWORK', 'false'], ['MARKETPLACE_REQUIRE_WALLET', 'on'],
    ['TALLY_EDITION', 'app'], ['CONTRACT_MEDIATOR_PUBLIC_KEY_HEX', generateEd25519().publicKeyHex],
    ['CONTRACT_PAPER_CONFIRMATION_MS', '0'], ['CONTRACT_PAPER_AUTO_WITHDRAW_DELAY_MS', '0'],
  ]));
  const store = AgentStore.open(join(directory, 'agent.sqlite'));
  const server = startMarketplace(0, {store, auditFile: join(directory, 'audit.jsonl')});
  const worker = new ContractService(store);
  try {
    await run(`http://127.0.0.1:${server.port}`, store, worker);
  } finally {
    await server.stop(true);
    store.close();
    process.env = previous;
    rmSync(directory, {recursive: true, force: true});
  }
}

async function call(origin: string, path: string, token?: string, body?: unknown, method?: string) {
  const response = await fetch(`${origin}/reliability${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {...(token ? {authorization: `Bearer ${token}`} : {}), 'content-type': 'application/json', 'x-tally-visitor': 'app-route-tests'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  return {status: response.status, body: await response.json()};
}

async function onboard(origin: string, seed: number) {
  const address = wallet(seed);
  const challenge = await call(origin, '/wallets/challenge', undefined, {address: address.reward});
  const signed = signData(address.stake, address.reward, challenge.body.message);
  const verified = await call(origin, '/wallets/verify', undefined, {
    challengeId: challenge.body.challengeId, address: address.reward, ...signed, source: 'cip30', displayName: `User ${seed}`, kind: 'person',
  });
  expect(verified.status).toBe(200);
  const token: string = verified.body.session;
  const entityId: string = verified.body.account.entity.id;
  expect((await call(origin, '/account/kyc', token, {kind: 'person', documentId: `DOC-${seed}`, addressChecked: true})).status).toBe(200);
  const keys = generateEd25519();
  const registration = await call(origin, '/app/party', token, {publicKeyHex: keys.publicKeyHex, cardanoAddress: address.base, entityId: 'spoofed-entity'});
  expect(registration.status).toBe(200);
  expect(registration.body.party.id).toBe(entityId);
  return {token, entityId, keys, address};
}

const FILE = 'The agreed file.\n';
const milestones = [{title: 'Export', amountAtomic: '3000000', deliverable: {expectedSha256: createHash('sha256').update(FILE).digest('hex')}}];
const actionBody = (contract: Contract, user: Awaited<ReturnType<typeof onboard>>, action: PartyAction['action'], evidence = false): {action: object; signatureHex: string} => {
  const input: PartyAction = {
    actionId: randomUUID(), contractId: contract.id, partyId: user.entityId,
    milestoneId: ['submit_for_acceptance', 'cancel'].includes(action) ? null : contract.milestones[0]!.id,
    action, ...(evidence ? {evidence: [{type: 'content_file', content: FILE}]} : {}),
  };
  return {
    action: {...input, evidence: input.evidence?.map((item) => ({type: item.type, contentText: item.content}))},
    signatureHex: signBytes(user.keys.privateKey, partyActionBytes(input)),
  };
};

function workerAudit(store: AgentStore, id: string) {
  return new ContractService(store).lifecycle.audit(id);
}

async function create(origin: string, buyer: Awaited<ReturnType<typeof onboard>>, seller: Awaited<ReturnType<typeof onboard>>) {
  const result = await call(origin, '/app/contracts', buyer.token, {
    templateId: 'digital-machine-checkable', role: 'buyer', counterpartyId: seller.entityId, milestones,
    buyerId: 'spoofed-buyer', sellerId: 'spoofed-seller', createdBy: 'spoofed-creator',
  });
  expect(result).toMatchObject({status: 200});
  const contract = result.body.contract as Contract;
  expect([contract.buyerId, contract.sellerId]).toEqual([buyer.entityId, seller.entityId]);
  return contract;
}

describe('app routes', () => {
  test('every route requires a live session, before input validation', async () => {
    await withServer(async (origin, store) => {
      for (const route of appRoutes) {
        const path = route.path.replace('/reliability', '');
        for (const token of [undefined, 'x'.repeat(43)]) {
          const result = await call(origin, `${path}?id=missing&milestone=0`, token, route.method === 'POST' ? {} : undefined);
          expect(result.status).toBe(401);
          expect(result.body.code).toBe('unauthorized');
        }
      }
      const user = await onboard(origin, 31);
      const expired = 'expired-session-'.repeat(3);
      store.insertSession({
        tokenHash: createHash('sha256').update(expired).digest('hex'), entityId: user.entityId,
        address: user.address.reward, createdAt: Date.now() - 86_400_000, expiresAt: Date.now() - 1,
      });
      await call(origin, '/account/sign-out', user.token, {});
      for (const route of appRoutes) {
        for (const token of [expired, user.token]) {
          const path = route.path.replace('/reliability', '');
          expect((await call(origin, `${path}?id=missing&milestone=0`, token, route.method === 'POST' ? {} : undefined)).status).toBe(401);
        }
      }
    });
  });

  test('reads, signatures, and actions cannot cross account boundaries; the clock never comes from app input', async () => {
    await withServer(async (origin, store) => {
      const buyer = await onboard(origin, 32);
      const seller = await onboard(origin, 33);
      const outsider = await onboard(origin, 34);
      const contract = await create(origin, buyer, seller);
      expect((await call(origin, '/app/action', buyer.token, actionBody(contract, buyer, 'submit_for_acceptance'))).status).toBe(200);
      const me = await call(origin, '/app/me?entityId=spoofed', buyer.token);
      expect(me.body).toMatchObject({entityId: buyer.entityId, mode: 'paper', readiness: {dealKey: true, depositRequired: false, canTrade: true}});
      expect((await call(origin, '/app/contracts?partyId=' + buyer.entityId, outsider.token)).body).toEqual([]);
      for (const suffix of ['', '/terms', '/audit', '/case', '/anchors']) {
        expect((await call(origin, `/app/contract${suffix}?id=${contract.id}&milestone=0`, outsider.token)).status).toBe(404);
        expect((await call(origin, `/app/contract${suffix}?id=${contract.id}&milestone=0`, buyer.token)).status).toBe(200);
      }
      expect((await call(origin, '/app/sign', outsider.token, {contractId: contract.id, signatureHex: '00'})).status).toBe(404);
      expect((await call(origin, '/app/action', outsider.token, actionBody(contract, outsider, 'submit_for_acceptance'))).status).toBe(404);
      const spoofed = await call(origin, '/app/action', outsider.token, actionBody(contract, buyer, 'submit_for_acceptance'));
      expect([spoofed.status, spoofed.body.code]).toEqual([403, 'forbidden']);
      const offset = store.getPaperClockOffset();
      for (const path of ['/app/party', '/app/contracts', '/app/sign', '/app/action']) {
        const refused = await call(origin, path, buyer.token, {at: new Date(Date.now() + 1_000_000).toISOString()});
        expect(refused.status).toBe(400);
      }
      expect((await call(origin, '/app/action', buyer.token, {action: {at: 'tomorrow'}})).status).toBe(400);
      expect((await call(origin, '/app/me?at=tomorrow', buyer.token)).status).toBe(400);
      expect(store.getPaperClockOffset()).toBe(offset);
      expect((await call(origin, '/app/party', buyer.token, {publicKeyHex: buyer.keys.publicKeyHex, cardanoAddress: seller.address.base})).status).toBe(403);
      expect((await call(origin, '/app/party', buyer.token, {publicKeyHex: buyer.keys.publicKeyHex, cardanoAddress: buyer.address.base})).status).toBe(200);
      expect((await call(origin, '/app/party', buyer.token, {publicKeyHex: generateEd25519().publicKeyHex, cardanoAddress: buyer.address.base})).body.code).toBe('party_exists');
      expect((await call(origin, '/app/contracts', buyer.token, {templateId: 'physical-objective-spec', role: 'buyer', counterpartyId: seller.entityId, milestones})).body.code).toBe('inspectors_required');
      expect((await call(origin, '/app/contracts', buyer.token, {templateId: 'ongoing-service', role: 'buyer', counterpartyId: seller.entityId, milestones})).body.code).toBe('inspectors_required');
      const audit = workerAudit(store, contract.id);
      expect(audit[0]?.actor).toBe(buyer.entityId);
    });
  });

  test('two signed-in users create, sign, deliver, accept, and settle a paper deal', async () => {
    await withServer(async (origin, store, worker) => {
      const buyer = await onboard(origin, 35);
      const seller = await onboard(origin, 36);
      const contract = await create(origin, buyer, seller);
      expect((await call(origin, '/app/action', buyer.token, actionBody(contract, buyer, 'submit_for_acceptance'))).status).toBe(200);
      const terms = await call(origin, `/app/contract/terms?id=${contract.id}`, buyer.token);
      for (const user of [buyer, seller]) {
        expect((await call(origin, '/app/sign', user.token, {contractId: contract.id, signatureHex: signBytes(user.keys.privateKey, terms.body.termsBytes)})).status).toBe(200);
      }
      // Scheduler time comes from the server, never from an app request.
      for (let i = 0; i < 4; i++) await worker.tick();
      expect(store.getContract(contract.id)?.milestones[0]?.state).toBe('funded');
      expect((await call(origin, '/app/action', seller.token, actionBody(contract, seller, 'deliver', true))).status).toBe(200);
      for (let i = 0; i < 4; i++) await worker.tick();
      expect(store.getContract(contract.id)?.milestones[0]?.state).toBe('in_inspection');
      expect((await call(origin, '/app/action', buyer.token, actionBody(contract, buyer, 'accept'))).status).toBe(200);
      const unlock = store.getContract(contract.id)!.milestones[0]!.deadlines!.unlockTime;
      worker.advancePaperClock(unlock + 1000);
      for (let i = 0; i < 6; i++) await worker.tick();
      const view = await call(origin, `/app/contract?id=${contract.id}`, buyer.token);
      expect(view.body).toMatchObject({mode: 'paper', auditChainIntact: true, milestones: [{state: 'settled', reliability: {state: 'successful'}, feeCharge: {status: 'collected'}}]});
      expect((await call(origin, '/app/contracts', seller.token)).body).toHaveLength(1);
    });
  });
});
