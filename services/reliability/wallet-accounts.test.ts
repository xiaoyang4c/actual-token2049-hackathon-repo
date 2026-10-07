/**
 * @fileoverview Wallet sign-in, accounts, mock KYC through the account, the
 * live deposit watcher, and the deposit transaction. Keys come from a real
 * CIP-1852 derivation, and signatures use the CIP-8 format that CIP-30
 * wallets return. The chain is a fake.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import * as C from '@emurgo/cardano-serialization-lib-nodejs';
import {AgentStore} from '../../packages/db/src/index';
import type {Contract} from '../../packages/reliability/src/contract-lifecycle/types';
import {CborMap, encodeCbor} from './cbor';
import {MarketplaceGate} from './marketplace-gate';
import {DEFAULT_RELIABILITY_POLICIES} from './policies';
import {TEST_USDM_UNIT} from './contract-config';
import {attachWitnesses, buildDepositTx, type ChainTx, type ChainUtxo, type DepositChain, type TxUtxos} from './deposit-chain';
import {DepositWatcher} from './deposit-watcher';
import type {ProtocolParams} from './anchor-chain';
import {accountRoutes, depositSettingsOrOff, setDepositSettings} from './routes-account';
import {BlockfrostError} from './deposit-chain';
import {WalletDeposits} from './wallet-deposits';
import {RateLimiter} from './rate-limit';
import {AccountError, CHALLENGE_TTL_MS, WalletAccounts} from './wallet-accounts';
import {verifyWalletSignature, WalletProofError} from './wallet-proof';

const harden = (n: number) => 0x80000000 + n;

/** A CIP-1852 wallet: account 0, payment key 0/0, stake key 2/0. */
function wallet(seed: number) {
  const entropy = new Uint8Array(32).fill(seed);
  const account = C.Bip32PrivateKey.from_bip39_entropy(entropy, new Uint8Array()).derive(harden(1852)).derive(harden(1815)).derive(harden(0));
  const payment = account.derive(0).derive(0).to_raw_key();
  const stake = account.derive(2).derive(0).to_raw_key();
  const base = C.BaseAddress.new(0, C.Credential.from_keyhash(payment.to_public().hash()), C.Credential.from_keyhash(stake.to_public().hash())).to_address();
  const reward = C.RewardAddress.new(0, C.Credential.from_keyhash(stake.to_public().hash())).to_address();
  return {payment, stake, base: base.to_bech32('addr_test'), reward: reward.to_bech32('stake_test')};
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** CIP-30 signData output for `message`, signed by `key` for `address`. */
function signData(key: C.PrivateKey, address: string, message: string, options: {hashed?: boolean; signedAddress?: string} = {}) {
  const protectedBytes = encodeCbor(new CborMap([[1, -8], ['address', C.Address.from_bech32(options.signedAddress ?? address).to_bytes()]]));
  const payload = new TextEncoder().encode(message);
  const toSign = encodeCbor(['Signature1', protectedBytes, new Uint8Array(), payload]);
  const signature = key.sign(toSign).to_bytes();
  return {
    signature: hex(encodeCbor([protectedBytes, new CborMap([['hashed', options.hashed ?? false]]), payload, signature])),
    key: hex(encodeCbor(new CborMap([[1, 1], [3, -8], [-1, 6], [-2, key.to_public().as_bytes()]]))),
  };
}

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

function setup() {
  const store = AgentStore.open();
  closers.push(() => store.close());
  let now = Date.UTC(2026, 9, 8, 2, 0, 0);
  let counter = 0;
  const random = (bytes: number) => Buffer.alloc(bytes, ++counter);
  const accounts = new WalletAccounts(store, {now: () => now, random});
  const signIn = (w: ReturnType<typeof wallet>, options: {session?: string; viaBase?: boolean; displayName?: string} = {}) => {
    const address = options.viaBase ? w.base : w.reward;
    const challenge = accounts.challenge(address);
    const signed = signData(options.viaBase ? w.payment : w.stake, address, challenge.message);
    const sessionEntity = options.session ? accounts.sessionEntity(options.session) : undefined;
    return accounts.verify({challengeId: challenge.challengeId, address, ...signed, source: 'cip30', walletName: 'lace', displayName: options.displayName}, sessionEntity);
  };
  return {store, accounts, signIn, advance: (ms: number) => { now += ms; }, now: () => now};
}

describe('wallet signatures (CIP-8)', () => {
  const alice = wallet(1);
  const bob = wallet(2);
  const message = 'Sign in to Tally.\nNonce: 01';

  test('a stake key signature proves the whole wallet; a payment key signature proves one address', () => {
    const stake = verifyWalletSignature({address: alice.reward, signatureHex: signData(alice.stake, alice.reward, message).signature, keyHex: signData(alice.stake, alice.reward, message).key, message});
    expect(stake).toMatchObject({credentialKind: 'stake', credentialHash: alice.stake.to_public().hash().to_hex()});
    const signed = signData(alice.payment, alice.base, message);
    expect(verifyWalletSignature({address: alice.base, signatureHex: signed.signature, keyHex: signed.key, message}))
      .toMatchObject({credentialKind: 'payment', credentialHash: alice.payment.to_public().hash().to_hex()});
  });

  test('a wrong message, key, address, network, hash flag, or signature is refused', () => {
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return (error as WalletProofError).code;
      }
      return 'passed';
    };
    const good = signData(alice.stake, alice.reward, message);
    expect(code(() => verifyWalletSignature({address: alice.reward, signatureHex: good.signature, keyHex: good.key, message: `${message}x`}))).toBe('wrong_message');
    const bobKey = signData(bob.stake, alice.reward, message);
    expect(code(() => verifyWalletSignature({address: alice.reward, signatureHex: bobKey.signature, keyHex: bobKey.key, message}))).toBe('wrong_key');
    const otherAddress = signData(alice.stake, alice.reward, message, {signedAddress: bob.reward});
    expect(code(() => verifyWalletSignature({address: alice.reward, signatureHex: otherAddress.signature, keyHex: otherAddress.key, message}))).toBe('wrong_key');
    const hashed = signData(alice.stake, alice.reward, message, {hashed: true});
    expect(code(() => verifyWalletSignature({address: alice.reward, signatureHex: hashed.signature, keyHex: hashed.key, message}))).toBe('invalid_signature');
    const tampered = good.signature.slice(0, -4) + (good.signature.endsWith('00') ? '0101' : '0000');
    expect(code(() => verifyWalletSignature({address: alice.reward, signatureHex: tampered, keyHex: good.key, message}))).toBe('invalid_signature');
    const mainnet = C.RewardAddress.new(1, C.Credential.from_keyhash(alice.stake.to_public().hash())).to_address().to_bech32('stake');
    expect(code(() => verifyWalletSignature({address: mainnet, signatureHex: good.signature, keyHex: good.key, message}))).toBe('invalid_address');
    expect(code(() => verifyWalletSignature({address: alice.reward, signatureHex: 'zz', keyHex: good.key, message}))).toBe('invalid_signature');
  });
});

describe('wallet accounts', () => {
  test('the first sign-in creates an unverified account; the next one opens the same account', () => {
    const {store, accounts, signIn} = setup();
    const alice = wallet(1);
    const first = signIn(alice, {displayName: '  Kopi   Origin  '});
    expect(first.created).toBe(true);
    expect(store.getEntity(first.entityId)).toMatchObject({displayName: 'Kopi Origin', kycStatus: 'unverified', wallets: [alice.reward]});
    expect(accounts.sessionEntity(first.token)).toBe(first.entityId);
    const again = signIn(alice);
    expect(again).toMatchObject({entityId: first.entityId, created: false});
    expect(accounts.wallets(first.entityId)).toEqual([expect.objectContaining({address: alice.reward, credentialKind: 'stake', source: 'cip30'})]);
  });

  test('a signed-in account can add a second wallet, but not a wallet of another account', () => {
    const {accounts, signIn} = setup();
    const alice = signIn(wallet(1));
    const second = signIn(wallet(3), {session: alice.token, viaBase: true});
    expect(second).toMatchObject({entityId: alice.entityId, created: false});
    expect(accounts.wallets(alice.entityId).map((item) => item.credentialKind)).toEqual(['stake', 'payment']);
    const bob = signIn(wallet(2));
    expect(() => signIn(wallet(2), {session: alice.token})).toThrow(AccountError);
    expect(bob.entityId).not.toBe(alice.entityId);
  });

  test('a challenge works once, for its address, before it expires', () => {
    const {accounts, advance} = setup();
    const alice = wallet(1);
    const challenge = accounts.challenge(alice.reward);
    const signed = signData(alice.stake, alice.reward, challenge.message);
    const input = {challengeId: challenge.challengeId, address: alice.reward, ...signed, source: 'cip30' as const};
    accounts.verify(input);
    expect(() => accounts.verify(input)).toThrow('already used');
    const late = accounts.challenge(alice.reward);
    advance(CHALLENGE_TTL_MS + 1);
    expect(() => accounts.verify({...input, challengeId: late.challengeId, ...signData(alice.stake, alice.reward, late.message)})).toThrow('expired');
    expect(() => accounts.challenge('addr1notpreprod')).toThrow(AccountError);
  });

  test('sessions end on sign-out and after their lifetime', () => {
    const {accounts, signIn, advance} = setup();
    const first = signIn(wallet(1));
    accounts.signOut(first.token);
    expect(() => accounts.sessionEntity(first.token)).toThrow('session ended');
    const second = signIn(wallet(1));
    advance(8 * 24 * 3_600_000);
    expect(() => accounts.sessionEntity(second.token)).toThrow('session ended');
    expect(() => accounts.sessionEntity(null)).toThrow('Sign in');
  });

  test('a base address of a wallet whose stake key is proven signs in to the same account', () => {
    const {signIn, store} = setup();
    const alice = wallet(1);
    const first = signIn(alice);
    const again = signIn(alice, {viaBase: true});
    expect(again).toMatchObject({entityId: first.entityId, created: false});
    expect(store.listWalletProofs(first.entityId).map((proof) => proof.credentialKind).sort()).toEqual(['payment', 'stake']);
    // Another account's session cannot claim it.
    const bob = signIn(wallet(2));
    expect(() => signIn(alice, {viaBase: true, session: bob.token})).toThrow('another Tally account');
  });

  test('mock KYC through the account verifies the person, and readiness follows the gate', () => {
    const {accounts, signIn} = setup();
    const alice = signIn(wallet(1));
    expect(accounts.readiness(alice.entityId, false)).toMatchObject({wallet: true, kyc: false, canTrade: false});
    const view = accounts.submitKyc(alice.entityId, {kind: 'person', documentId: 'P1234567'});
    expect(view).toMatchObject({status: 'verified', tier: 'basic'});
    expect(accounts.readiness(alice.entityId, false)).toMatchObject({wallet: true, kyc: true, canTrade: true, deposit: false});
    const bob = signIn(wallet(2));
    expect(accounts.submitKyc(bob.entityId, {kind: 'person', documentId: 'DOC-REJECT-1'})).toMatchObject({status: 'rejected'});
    expect(() => accounts.submitKyc(bob.entityId, {kind: 'business', registrationNumber: 'R1'})).toThrow(AccountError);
  });
});

class FakeChain implements DepositChain {
  height = 100;
  txs: Array<ChainTx & TxUtxos> = [];
  submitted: string[] = [];
  async tip() { return {height: this.height, slot: 5_000}; }
  async addressTransactions(address: string, count: number) {
    return this.txs.filter((tx) => tx.outputs.some((o) => o.address === address) || tx.inputs.some((i) => i.address === address))
      .slice().reverse().slice(0, count).map(({txHash, blockHeight, blockTime}) => ({txHash, blockHeight, blockTime}));
  }
  async transactionUtxos(txHash: string) {
    const tx = this.txs.find((item) => item.txHash === txHash);
    return tx ? {inputs: tx.inputs, outputs: tx.outputs} : null;
  }
  async transactionBlock(txHash: string) {
    const tx = this.txs.find((item) => item.txHash === txHash);
    return tx ? {txHash, blockHeight: tx.blockHeight, blockTime: tx.blockTime} : null;
  }
  async addressUtxos(): Promise<ChainUtxo[]> { return []; }
  async params(): Promise<ProtocolParams> { return PARAMS; }
  async submit(cborHex: string) { this.submitted.push(cborHex); return C.FixedTransaction.from_hex(cborHex).transaction_hash().to_hex(); }
}

const PARAMS: ProtocolParams = {
  minFeeA: '44', minFeeB: '155381', maxTxSize: 16384, maxValueSize: 5000, coinsPerUtxoByte: '4310', keyDeposit: '2000000', poolDeposit: '500000000',
};

const POOL = C.EnterpriseAddress.new(0, C.Credential.from_keyhash(wallet(9).payment.to_public().hash())).to_address().to_bech32('addr_test');
const ada = (quantity: string) => [{unit: 'lovelace', quantity}];
const txHash = (n: number) => n.toString(16).padStart(64, '0');

describe('live deposit watcher', () => {
  function watching() {
    const kit = setup();
    const chain = new FakeChain();
    const lines: Array<{[key: string]: unknown}> = [];
    const watcher = new DepositWatcher({store: kit.store, chain, depositAddress: POOL, confirmations: 3, now: kit.now, log: (line) => lines.push(line)});
    return {...kit, chain, watcher, lines};
  }

  test('a deposit from a proven wallet is pending, then confirmed after the confirmations', async () => {
    const {store, chain, watcher, signIn} = watching();
    const alice = wallet(1);
    const account = signIn(alice);
    chain.txs.push({txHash: txHash(1), blockHeight: 99, blockTime: 1, inputs: [{address: alice.base, amounts: ada('20000000')}],
      outputs: [{address: POOL, index: 0, amounts: [...ada('5000000'), {unit: TEST_USDM_UNIT, quantity: '25000000'}]}, {address: alice.base, index: 1, amounts: ada('14800000')}]});
    expect(await watcher.runOnce()).toMatchObject({pending: 1});
    expect(store.confirmedDepositTotals(account.entityId)).toEqual([]);
    chain.height = 101;
    expect(await watcher.runOnce()).toMatchObject({confirmed: 1});
    expect(store.confirmedDepositTotals(account.entityId).sort((a, b) => a.unit.localeCompare(b.unit))).toEqual([
      {unit: TEST_USDM_UNIT, quantity: '25000000'}, {unit: 'lovelace', quantity: '5000000'},
    ].sort((a, b) => a.unit.localeCompare(b.unit)));
    // A confirmed deposit is final: the next pass skips it.
    expect(await watcher.runOnce()).toMatchObject({seen: 0});
  });

  test('a payment key proof covers only its own key; unknown and mixed senders stay unattributed', async () => {
    const {store, chain, watcher, signIn} = watching();
    const alice = wallet(1);
    const bob = wallet(2);
    const aliceAccount = signIn(alice, {viaBase: true});
    signIn(bob);
    chain.height = 200;
    chain.txs.push(
      {txHash: txHash(1), blockHeight: 150, blockTime: 1, inputs: [{address: alice.base, amounts: ada('9000000')}], outputs: [{address: POOL, index: 0, amounts: ada('3000000')}]},
      {txHash: txHash(2), blockHeight: 151, blockTime: 2, inputs: [{address: wallet(4).base, amounts: ada('9000000')}], outputs: [{address: POOL, index: 0, amounts: ada('3000000')}]},
      {txHash: txHash(3), blockHeight: 152, blockTime: 3, inputs: [{address: alice.base, amounts: ada('1')}, {address: bob.base, amounts: ada('1')}], outputs: [{address: POOL, index: 0, amounts: ada('3000000')}]},
      // Tally's own transfer out of the deposit address is not a deposit.
      {txHash: txHash(4), blockHeight: 153, blockTime: 4, inputs: [{address: POOL, amounts: ada('9')}], outputs: [{address: POOL, index: 0, amounts: ada('3')}]},
    );
    expect(await watcher.runOnce()).toMatchObject({confirmed: 1, unattributed: 2});
    expect(store.confirmedDepositTotals(aliceAccount.entityId)).toEqual([{unit: 'lovelace', quantity: '3000000'}]);
    expect(store.listLiveDeposits({status: 'unattributed'}).map((row) => row.note).sort()).toEqual([
      'inputs come from more than one account', 'no input comes from a proven wallet',
    ]);
  });

  test('an unattributed deposit is credited once its sender proves the wallet', async () => {
    const {store, chain, watcher, signIn} = watching();
    const carol = wallet(5);
    chain.txs.push({txHash: txHash(7), blockHeight: 90, blockTime: 1, inputs: [{address: carol.base, amounts: ada('9000000')}], outputs: [{address: POOL, index: 0, amounts: ada('4000000')}]});
    expect(await watcher.runOnce()).toMatchObject({unattributed: 1});
    const account = signIn(carol);
    expect(await watcher.runOnce()).toMatchObject({confirmed: 1});
    expect(store.confirmedDepositTotals(account.entityId)).toEqual([{unit: 'lovelace', quantity: '4000000'}]);
  });

  test('a pending deposit that leaves the chain is rolled back', async () => {
    const {store, chain, watcher, signIn} = watching();
    const alice = wallet(1);
    signIn(alice);
    chain.txs.push({txHash: txHash(8), blockHeight: 100, blockTime: 1, inputs: [{address: alice.base, amounts: ada('9000000')}], outputs: [{address: POOL, index: 0, amounts: ada('4000000')}]});
    await watcher.runOnce();
    chain.txs = [];
    expect(await watcher.runOnce()).toMatchObject({rolledBack: 1});
    expect(store.listLiveDeposits()).toEqual([expect.objectContaining({status: 'rolled_back'})]);
  });

  test('a rolled-back deposit that comes back on the chain is credited', async () => {
    const {store, chain, watcher, signIn} = watching();
    const alice = wallet(1);
    const account = signIn(alice);
    const deposit = {txHash: txHash(9), blockHeight: 100, blockTime: 1, inputs: [{address: alice.base, amounts: ada('9000000')}], outputs: [{address: POOL, index: 0, amounts: ada('4000000')}]};
    chain.txs.push(deposit);
    await watcher.runOnce();
    chain.txs = [];
    expect(await watcher.runOnce()).toMatchObject({rolledBack: 1});
    // The same transaction is included again in a later block.
    chain.txs.push({...deposit, blockHeight: 104});
    chain.height = 110;
    expect(await watcher.runOnce()).toMatchObject({confirmed: 1});
    expect(store.confirmedDepositTotals(account.entityId)).toEqual([{unit: 'lovelace', quantity: '4000000'}]);
  });

  test('a steady pass makes two chain calls', async () => {
    const {chain, watcher, signIn} = watching();
    const alice = wallet(1);
    signIn(alice);
    const calls: string[] = [];
    for (const name of ['tip', 'addressTransactions', 'transactionUtxos', 'transactionBlock'] as const) {
      const original = chain[name].bind(chain) as (...args: unknown[]) => Promise<unknown>;
      (chain as unknown as {[key: string]: unknown})[name] = (...args: unknown[]) => {
        calls.push(name);
        return original(...args);
      };
    }
    chain.height = 200;
    chain.txs.push(
      // Tally's own transfer, an unattributed deposit, and a pending deposit.
      {txHash: txHash(10), blockHeight: 150, blockTime: 1, inputs: [{address: POOL, amounts: ada('9')}], outputs: [{address: POOL, index: 0, amounts: ada('3')}]},
      {txHash: txHash(11), blockHeight: 151, blockTime: 2, inputs: [{address: wallet(6).base, amounts: ada('9000000')}], outputs: [{address: POOL, index: 0, amounts: ada('3000000')}]},
      {txHash: txHash(12), blockHeight: 199, blockTime: 3, inputs: [{address: alice.base, amounts: ada('9000000')}], outputs: [{address: POOL, index: 0, amounts: ada('3000000')}]},
    );
    await watcher.runOnce();
    expect(calls.filter((name) => name === 'transactionUtxos')).toHaveLength(3);
    calls.length = 0;
    expect(await watcher.runOnce()).toMatchObject({pending: 1, unattributed: 1});
    expect(calls).toEqual(['tip', 'addressTransactions']);
  });
});

describe('deposit transaction', () => {
  const alice = wallet(1);
  const utxos: ChainUtxo[] = [
    {txHash: txHash(21), index: 0, address: alice.base, amounts: ada('3000000')},
    {txHash: txHash(22), index: 1, address: alice.base, amounts: [...ada('10000000'), {unit: TEST_USDM_UNIT, quantity: '50000000'}]},
  ];

  test('Tally builds it, the wallet key signs the body, and the signature is attached', () => {
    const built = buildDepositTx({utxos, changeAddress: alice.base, depositAddress: POOL, amounts: [{unit: TEST_USDM_UNIT, quantity: '20000000'}], params: PARAMS, slot: 1000});
    const tx = C.Transaction.from_hex(built.cborHex);
    const pay = tx.body().outputs().get(0);
    expect(pay.address().to_bech32('addr_test')).toBe(POOL);
    // A token output carries the minimum ADA it needs.
    expect(BigInt(built.lovelace)).toBeGreaterThan(1_000_000n);
    expect(tx.body().ttl_bignum()?.to_str()).toBe('8200');
    const witnesses = C.TransactionWitnessSet.new();
    const vkeys = C.Vkeywitnesses.new();
    vkeys.add(C.make_vkey_witness(C.TransactionHash.from_hex(built.txHash), alice.payment));
    witnesses.set_vkeys(vkeys);
    const signed = attachWitnesses(built.cborHex, witnesses.to_hex());
    expect(signed.txHash).toBe(built.txHash);
    expect(signed.signers).toEqual([alice.payment.to_public().hash().to_hex()]);
    const wrong = C.TransactionWitnessSet.new();
    const wrongKeys = C.Vkeywitnesses.new();
    wrongKeys.add(C.make_vkey_witness(C.TransactionHash.from_hex(txHash(5)), alice.payment));
    wrong.set_vkeys(wrongKeys);
    expect(() => attachWitnesses(built.cborHex, wrong.to_hex())).toThrow('does not match');
  });

  test('a deposit larger than the wallet is refused', () => {
    expect(() => buildDepositTx({utxos, changeAddress: alice.base, depositAddress: POOL, amounts: ada('900000000'), params: PARAMS, slot: 1000}))
      .toThrow('does not hold enough');
  });
});

describe('basic security', () => {
  test('the sign-in message names the website and says that signing moves no funds', () => {
    const {accounts} = setup();
    const {message} = accounts.challenge(wallet(1).reward);
    expect(message).toStartWith('tally-origins.vercel.app asks you to sign in to Tally.');
    expect(message).toContain('Sign it only on https://tally-origins.vercel.app.');
    expect(message).toContain('It does not move funds');
    const store = AgentStore.open();
    closers.push(() => store.close());
    expect(new WalletAccounts(store, {domain: 'localhost:5190'}).challenge(wallet(1).reward).message).toStartWith('localhost:5190 asks');
  });

  test('a session lasts one day', () => {
    const {accounts, signIn, advance} = setup();
    const session = signIn(wallet(1));
    advance(23 * 3_600_000);
    expect(accounts.sessionEntity(session.token)).toBe(session.entityId);
    advance(2 * 3_600_000);
    expect(() => accounts.sessionEntity(session.token)).toThrow('session ended');
  });

  test('the rate limit map stays bounded under a flood of new keys', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now, 3);
    for (const key of ['a', 'b', 'c']) expect(limiter.take(key)).toBe(0);
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBeGreaterThan(0);
    // A new key drops the oldest one and the map keeps three keys.
    for (let index = 0; index < 50; index++) limiter.take(`flood-${index}`);
    expect((limiter as unknown as {hits: Map<string, unknown>}).hits.size).toBe(3);
    now = 5000;
    expect(limiter.take('a')).toBe(0);
  });

  test('the rate limit counts per key and resets after its window', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('b')]).toEqual([0, 0, 0]);
    expect(limiter.take('a')).toBe(1);
    now = 1000;
    expect(limiter.take('a')).toBe(0);
  });

  test('sign-in routes refuse a visitor after 20 requests in 10 minutes', async () => {
    const store = AgentStore.open();
    closers.push(() => store.close());
    const route = accountRoutes.find((item) => item.path === '/reliability/wallets/challenge')!;
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const request = new Request('http://tally.test/reliability/wallets/challenge', {
        method: 'POST', headers: {'content-type': 'application/json', 'x-tally-visitor': '203.0.113.50'}, body: JSON.stringify({address: wallet(1).reward}),
      });
      statuses.push((await route.handler(request, new URL(request.url), store)).status);
    }
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe('every-time checks in the marketplace gate', () => {
  test('with the wallet rule on, a KYC-verified party also needs a proven wallet', () => {
    const {store, accounts, signIn} = setup();
    const buyer = signIn(wallet(1));
    accounts.submitKyc(buyer.entityId, {kind: 'person', documentId: 'P1111111'});
    store.insertEntity({id: 'no-wallet', displayName: 'No wallet', wallets: [], roles: ['buyer', 'seller'], kycStatus: 'verified', kycTier: 'basic', createdAt: '2026-10-08T00:00:00.000Z'});
    const now = new Date(Date.UTC(2026, 9, 8, 3)).toISOString();
    const deal = {type: 'goods' as const, buyerId: buyer.entityId, sellerId: 'no-wallet', value: 100, now};
    expect(new MarketplaceGate(store, DEFAULT_RELIABILITY_POLICIES, {requireWallet: false}).checkDeal(deal).allowed).toBe(true);
    const gate = new MarketplaceGate(store, DEFAULT_RELIABILITY_POLICIES, {requireWallet: true});
    expect(gate.checkDeal(deal).violations).toEqual([expect.objectContaining({code: 'wallet_required', party: 'seller'})]);
    expect(gate.ownsAddress(buyer.entityId, wallet(1).base)).toBe(true);
    expect(gate.ownsAddress(buyer.entityId, wallet(2).base)).toBe(false);
  });

  test('a live contract needs confirmed deposits that open live contracts have not reserved', () => {
    const {store, accounts, signIn} = setup();
    const buyer = signIn(wallet(1));
    const seller = signIn(wallet(2));
    for (const id of [buyer.entityId, seller.entityId]) accounts.submitKyc(id, {kind: 'person', documentId: `P${id.slice(-6)}`});
    const gate = new MarketplaceGate(store, DEFAULT_RELIABILITY_POLICIES, {requireWallet: true});
    const now = new Date(Date.UTC(2026, 9, 8, 3)).toISOString();
    const deal = (quantity: bigint) => gate.checkDeal({
      type: 'goods', buyerId: buyer.entityId, sellerId: seller.entityId, value: 10, now, liveDeposit: {unit: TEST_USDM_UNIT, quantity},
    });
    expect(deal(10_000_000n).violations.map((item) => item.code)).toEqual(['deposit_required']);
    store.upsertLiveDeposit({
      txHash: txHash(30), outputIndex: 0, unit: TEST_USDM_UNIT, quantity: '25000000', depositAddress: POOL, entityId: buyer.entityId,
      status: 'confirmed', blockHeight: 1, blockTime: 1, firstSeenAt: 1, confirmedAt: 1, note: null,
    });
    expect(deal(25_000_000n).allowed).toBe(true);
    const contract = {
      id: 'live-1', version: 0, mode: 'live', templateId: 'physical-objective-spec', category: 'delivery', buyerId: buyer.entityId, sellerId: seller.entityId,
      createdAt: 1, createdBy: buyer.entityId, terms: {assetUnit: TEST_USDM_UNIT}, termsSha256: null, signatures: {},
      milestones: [{amountAtomic: '20000000'}],
    } as unknown as Contract;
    store.commitContract({contract, isNew: true, open: true, now: 1, audits: [], newOperations: [], operationUpdates: [], evidence: [], publications: []} as unknown as Parameters<AgentStore['commitContract']>[0]);
    expect(gate.availableDeposit(buyer.entityId, TEST_USDM_UNIT)).toEqual({
      deposited: 25_000_000n, reserved: 20_000_000n, spent: 0n, available: 5_000_000n,
    });
    expect(deal(10_000_000n).violations.map((item) => item.code)).toEqual(['deposit_required']);
    // The refusal names no balance: the requester can be the other party.
    expect(deal(10_000_000n).violations[0]?.message).not.toMatch(/deposited|reserved|available|25000000|5000000/);
    expect(deal(5_000_000n).allowed).toBe(true);
  });

  test('a closed live contract keeps its seller payout spent and returns refunds', () => {
    const {store, accounts, signIn} = setup();
    const buyer = signIn(wallet(1));
    const seller = signIn(wallet(2));
    for (const id of [buyer.entityId, seller.entityId]) accounts.submitKyc(id, {kind: 'person', documentId: `P${id.slice(-6)}`});
    const gate = new MarketplaceGate(store, DEFAULT_RELIABILITY_POLICIES, {requireWallet: true});
    store.upsertLiveDeposit({
      txHash: txHash(31), outputIndex: 0, unit: TEST_USDM_UNIT, quantity: '25000000', depositAddress: POOL, entityId: buyer.entityId,
      status: 'confirmed', blockHeight: 1, blockTime: 1, firstSeenAt: 1, confirmedAt: 1, note: null,
    });
    const tranche = (paidToSeller: string|null, paidToBuyer: string|null) => ({chain: {paidToSellerAtomic: paidToSeller, paidToBuyerAtomic: paidToBuyer}});
    const commit = (id: string, open: boolean, milestones: unknown[], isNew = true) => store.commitContract({
      contract: {
        id, version: isNew ? 0 : 1, mode: 'live', templateId: 'physical-objective-spec', category: 'delivery',
        buyerId: buyer.entityId, sellerId: seller.entityId, createdAt: 1, createdBy: buyer.entityId,
        terms: {assetUnit: TEST_USDM_UNIT}, termsSha256: null, signatures: {}, milestones,
      } as unknown as Contract,
      isNew, open, now: 1, audits: [], newOperations: [], operationUpdates: [], evidence: [], publications: [],
    } as unknown as Parameters<AgentStore['commitContract']>[0]);
    // Settled: the seller was paid 20 USDM. Reusing it was the bug.
    commit('paid', false, [{amountAtomic: '20000000', fundedAt: 5, tranches: [tranche('20000000', null)]}]);
    expect(gate.availableDeposit(buyer.entityId, TEST_USDM_UNIT)).toEqual({
      deposited: 25_000_000n, reserved: 0n, spent: 20_000_000n, available: 5_000_000n,
    });
    // Refunded in full, or cancelled before funding: nothing is spent.
    commit('refunded', false, [{amountAtomic: '3000000', fundedAt: 5, tranches: [tranche(null, '3000000')]}]);
    commit('unfunded', false, [{amountAtomic: '4000000', fundedAt: null, tranches: [tranche(null, null)]}]);
    expect(gate.availableDeposit(buyer.entityId, TEST_USDM_UNIT).available).toBe(5_000_000n);
    const deal = (quantity: bigint) => gate.checkDeal({
      type: 'goods', buyerId: buyer.entityId, sellerId: seller.entityId, value: 10,
      now: new Date(Date.UTC(2026, 9, 8, 3)).toISOString(), liveDeposit: {unit: TEST_USDM_UNIT, quantity},
    });
    expect(deal(20_000_000n).violations.map((item) => item.code)).toEqual(['deposit_required']);
    expect(deal(5_000_000n).allowed).toBe(true);
  });

  test('a missing wallet does not hide an exposure limit', () => {
    const {store, accounts, signIn} = setup();
    const buyer = signIn(wallet(1));
    accounts.submitKyc(buyer.entityId, {kind: 'person', documentId: 'P777777'});
    store.insertEntity({
      id: 'kyc-no-wallet', displayName: 'No wallet', wallets: [], roles: ['buyer', 'seller'],
      kycStatus: 'verified', kycTier: 'basic', createdAt: new Date(0).toISOString(),
    });
    const gate = new MarketplaceGate(store, DEFAULT_RELIABILITY_POLICIES, {requireWallet: true});
    const check = gate.checkDeal({
      type: 'goods', buyerId: buyer.entityId, sellerId: 'kyc-no-wallet', value: 9000,
      now: new Date(Date.UTC(2026, 9, 8, 3)).toISOString(),
    });
    expect(check.violations.map((item) => `${item.party}:${item.code}`)).toEqual([
      'buyer:exposure_limit', 'seller:wallet_required', 'seller:exposure_limit',
    ]);
  });
});

describe('account routes', () => {
  test('sign in over HTTP, read the account with the session, and refuse without it', async () => {
    const store = AgentStore.open();
    closers.push(() => store.close());
    const chain = new FakeChain();
    setDepositSettings({chain, depositAddress: POOL, confirmations: 3});
    const route = (method: string, path: string) => accountRoutes.find((item) => item.method === method && item.path === path)!;
    const call = async (method: string, path: string, body?: unknown, token?: string) => {
      const request = new Request(`http://tally.test${path}`, {
        method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      const response = await route(method, path).handler(request, new URL(request.url), store);
      return {status: response.status, body: await response.json() as {[key: string]: unknown}};
    };
    const alice = wallet(1);
    const challenge = await call('POST', '/reliability/wallets/challenge', {address: alice.reward});
    expect(challenge.status).toBe(200);
    const signed = signData(alice.stake, alice.reward, challenge.body.message as string);
    const verified = await call('POST', '/reliability/wallets/verify', {challengeId: challenge.body.challengeId, address: alice.reward, ...signed, source: 'cip30', displayName: 'Kopi'});
    expect(verified.status).toBe(200);
    expect(verified.body.account).toMatchObject({entity: {displayName: 'Kopi'}, deposits: {enabled: true, mode: 'live', depositAddress: POOL}, readiness: {wallet: true, kyc: false}});
    const session = verified.body.session as string;
    expect((await call('GET', '/reliability/account')).status).toBe(401);
    expect((await call('GET', '/reliability/account', undefined, session)).body.wallets).toHaveLength(1);
    const kyc = await call('POST', '/reliability/account/kyc', {kind: 'person', documentId: 'P7654321'}, session);
    expect(kyc.body.readiness).toMatchObject({kyc: true, canTrade: true});
    expect((await call('POST', '/reliability/account/deposits/build', {amounts: ada('0'), from: {kind: 'browser', address: alice.base}}, session)).status).toBe(400);
    expect((await call('POST', '/reliability/account/deposits/build', {amounts: ada('1000000'), from: {kind: 'browser', address: wallet(2).base}}, session)).body.code).toBe('wrong_key');
    expect((await call('POST', '/reliability/account/sign-out', {}, session)).status).toBe(200);
    expect((await call('GET', '/reliability/account', undefined, session)).status).toBe(401);
    // Signing in again with a blank optional name opens the same account.
    // The ended session token in the request does not block the new sign-in.
    const again = await call('POST', '/reliability/wallets/challenge', {address: alice.reward});
    const resigned = await call('POST', '/reliability/wallets/verify', {
      challengeId: again.body.challengeId, address: alice.reward, ...signData(alice.stake, alice.reward, again.body.message as string), source: 'browser', displayName: '  ',
    }, session);
    expect(resigned).toMatchObject({status: 200, body: {created: false, account: {entity: {displayName: 'Kopi'}}}});
  });
});

describe('deposit settings and chain rejections', () => {
  test('a bad deposit setting turns deposits off instead of failing every request', () => {
    const env = (name: string, value: string) => Object.fromEntries([[name, value]]) as {[key: string]: string};
    const off = {chain: null, depositAddress: null, confirmations: 3};
    expect(depositSettingsOrOff(env('TALLY_DEPOSIT_ADDRESS', 'addr1_mainnet_is_refused'))).toEqual(off);
    expect(depositSettingsOrOff(env('TALLY_DEPOSIT_CONFIRMATIONS', 'zero'))).toEqual(off);
    expect(depositSettingsOrOff(env('TALLY_DEPOSIT_ADDRESS', POOL)).depositAddress).toBe(POOL);
  });

  test('a deposit that the chain rejects ends the build instead of reporting an outage', async () => {
    const {store, signIn} = setup();
    const alice = wallet(1);
    const account = signIn(alice);
    class RejectingChain extends FakeChain {
      override async addressUtxos(): Promise<ChainUtxo[]> {
        return [{txHash: txHash(41), index: 0, address: alice.base, amounts: ada('20000000')}];
      }
      override async submit(): Promise<string> {
        throw new BlockfrostError('Blockfrost /tx/submit returned 400: inputs already spent', 400);
      }
    }
    const deposits = new WalletDeposits(store, {chain: new RejectingChain(), depositAddress: POOL, confirmations: 3});
    const built = await deposits.build(account.entityId, ada('5000000'), {kind: 'browser', address: alice.base});
    const witnesses = C.TransactionWitnessSet.new();
    const vkeys = C.Vkeywitnesses.new();
    vkeys.add(C.make_vkey_witness(C.TransactionHash.from_hex(built.txHash), alice.payment));
    witnesses.set_vkeys(vkeys);
    await expect(deposits.submit(account.entityId, built.buildId, witnesses.to_hex())).rejects.toMatchObject({
      code: 'deposit_rejected', status: 400,
    });
    // The rejected build is gone, so a retry cannot send it again.
    await expect(deposits.submit(account.entityId, built.buildId, witnesses.to_hex())).rejects.toThrow('expired');
  });
});
