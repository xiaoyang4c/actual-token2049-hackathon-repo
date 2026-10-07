/**
 * @fileoverview Settlement anchors: fingerprints and company chains on the
 * showcase records, the batch rules against a fake chain, the real Cardano
 * transaction, and the Blockfrost client.
 */

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import * as C from '@emurgo/cardano-serialization-lib-nodejs';
import {createHash} from 'node:crypto';
import {copyFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../../packages/db/src/index';
import {anchorAddress, BlockfrostAnchorChain, buildAnchorTx, generateAnchorKey, type ProtocolParams} from './anchor-chain';
import {
  ANCHOR_MESSAGE_HEADER, AnchorWorker, companyAnchors, contractAnchors, EXPIRY_MARGIN_SLOTS, MIN_CONFIRMATIONS, recordHash,
  RESEND_AFTER_MS, VALIDITY_SLOTS, ZERO_HASH, type AnchorChain,
} from './anchors';
import {seedShowcase, SHOWCASE_PARTIES} from './contract-showcase';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const NOW = Date.UTC(2026, 9, 7, 6, 0, 0);
const directory = mkdtempSync(join(tmpdir(), 'anchors-'));
const template = join(directory, 'template.sqlite');
let copies = 0;

beforeAll(async () => {
  await seedShowcase(template, NOW);
});
afterAll(() => rmSync(directory, {recursive: true, force: true}));

/** A fresh copy of the seeded showcase database. */
function seeded(): {store: AgentStore; path: string} {
  const path = join(directory, `copy-${copies++}.sqlite`);
  copyFileSync(template, path);
  return {store: AgentStore.open(path), path};
}

class FakeChain implements AnchorChain {
  slot = 1_000;
  height = 100;
  funded = true;
  failSubmit = false;
  /** Sent transactions land in the next block unless this is false. */
  lands = true;
  wrongMessage = false;
  built: string[][] = [];
  sent: string[] = [];
  private pending = new Map<string, string[]>();
  private onChain = new Map<string, {blockHeight: number; message: string[]}>();

  async tip() {
    return {slot: this.slot, height: this.height};
  }

  async transaction(txHash: string) {
    const tx = this.onChain.get(txHash);
    return tx ? {blockHeight: tx.blockHeight, blockTime: 1_759_800_000 + tx.blockHeight} : null;
  }

  async anchorMessage(txHash: string) {
    const tx = this.onChain.get(txHash);
    return tx ? (this.wrongMessage ? [...tx.message.slice(0, -1), 'f'.repeat(64)] : tx.message) : null;
  }

  async build(message: string[], invalidHereafter: number) {
    if (!this.funded) return {unfunded: true as const};
    this.built.push(message);
    const cborHex = Buffer.from(JSON.stringify({message, invalidHereafter, n: this.built.length})).toString('hex');
    return {txHash: sha256(cborHex), cborHex};
  }

  async submit(cborHex: string) {
    this.sent.push(cborHex);
    if (this.failSubmit) throw new Error('timeout');
    if (this.lands) this.pending.set(sha256(cborHex), (JSON.parse(Buffer.from(cborHex, 'hex').toString()) as {message: string[]}).message);
    return sha256(cborHex);
  }

  /** Adds a block: sent transactions land, and the chain moves on. */
  block(slots = 20) {
    this.height++;
    this.slot += slots;
    for (const [hash, message] of this.pending) this.onChain.set(hash, {blockHeight: this.height, message});
    this.pending.clear();
  }
}

function worker(store: AgentStore, chain: AnchorChain|null, options: {submit?: boolean; now?: () => number} = {}) {
  const events: Array<{[key: string]: unknown}> = [];
  return {
    events,
    run: new AnchorWorker({store, chain, submit: options.submit ?? true, now: options.now ?? (() => NOW), log: (line) => events.push(line)}),
  };
}

describe('settlement fingerprints and company chains', () => {
  test('a record fingerprint ignores key order and changes with any edit', () => {
    expect(recordHash({b: 1, a: {d: [1, 2], c: 'x'}})).toBe(recordHash({a: {c: 'x', d: [1, 2]}, b: 1}));
    expect(recordHash({a: 1})).not.toBe(recordHash({a: 2}));
  });

  test('final showcase records become chained entries for each company, and the chains check out', () => {
    const {store} = seeded();
    const {run} = worker(store, null);
    const added = run.collect();
    expect(added).toBeGreaterThan(0);
    expect(run.collect()).toBe(0);
    const kopi = companyAnchors(store, SHOWCASE_PARTIES.kopi.id);
    expect(kopi.chain.intact).toBe(true);
    expect(kopi.chain.length).toBeGreaterThan(0);
    expect(kopi.entries.map((entry) => entry.seq)).toEqual(Array.from({length: kopi.entries.length}, (value, index) => index + 1));
    expect(kopi.entries.every((entry) => entry.anchor.status === 'waiting')).toBe(true);
    const contractId = kopi.entries[0]?.contractId as string;
    const view = contractAnchors(store, contractId);
    expect(view.records[0]?.recordUnchanged).toBe(true);
    expect(view.records[0]?.entries.length).toBeGreaterThanOrEqual(2);
    store.close();
  });

  test('an edited settlement record or a missing entry breaks the company chain', () => {
    const {store, path} = seeded();
    worker(store, null).run.collect();
    const entries = companyAnchors(store, SHOWCASE_PARTIES.kopi.id).entries;
    const db = new Database(path);
    db.query(`UPDATE contract_publications SET json = json_set(json, '$.outcome.state', 'successful', '$.outcome.fault', NULL)
      WHERE id = (SELECT publication_id FROM reliability_anchor_entries WHERE entry_hash = ?)`).run(entries[0]?.entryHash as string);
    expect(companyAnchors(store, SHOWCASE_PARTIES.kopi.id).chain.problems.join(' ')).toContain('changed after it was fingerprinted');
    if (entries.length > 1) {
      db.query('DELETE FROM reliability_anchor_entries WHERE entry_hash = ?').run(entries[0]?.entryHash as string);
      expect(companyAnchors(store, SHOWCASE_PARTIES.kopi.id).chain.problems.join(' ')).toContain('an entry is missing');
    }
    db.close();
    store.close();
  });
});

describe('anchor batches', () => {
  test('with submission off, fingerprints are recorded and nothing is built or sent', async () => {
    const {store} = seeded();
    const chain = new FakeChain();
    await worker(store, chain, {submit: false}).run.runOnce();
    expect(store.anchorCounts().entries).toBeGreaterThan(0);
    expect(chain.built).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
    store.close();
  });

  test('turning submission off stops resends of an existing batch but still confirms it', async () => {
    const {store} = seeded();
    try {
      const chain = new FakeChain();
      await worker(store, chain).run.runOnce();
      const open = store.getOpenAnchorBatch()!;
      const readOnly = worker(store, chain, {submit: false, now: () => NOW + RESEND_AFTER_MS}).run;
      await readOnly.runOnce();
      expect(chain.sent).toHaveLength(1);
      chain.block();
      chain.block();
      await readOnly.runOnce();
      expect(store.getAnchorBatch(open.id)?.status).toBe('confirmed');
    } finally {
      store.close();
    }
  });

  test('a batch is saved before it is sent, and confirmed only with enough confirmations and the same message', async () => {
    const {store} = seeded();
    const chain = new FakeChain();
    const {run} = worker(store, chain);
    await run.runOnce();
    const open = store.getOpenAnchorBatch();
    expect(open?.status).toBe('submitted');
    expect(chain.sent).toEqual([open?.txCbor as string]);
    expect(chain.built[0]?.[0]).toBe(ANCHOR_MESSAGE_HEADER);
    expect(open?.invalidHereafter).toBe(1_000 + VALIDITY_SLOTS);

    chain.block();
    await run.runOnce();
    expect(MIN_CONFIRMATIONS).toBe(2);
    expect(store.getOpenAnchorBatch()?.status).toBe('submitted');
    chain.block();
    await run.runOnce();
    expect(store.getOpenAnchorBatch()).toBeNull();
    expect(store.getAnchorBatch(open?.id as string)?.status).toBe('confirmed');
    const kopi = companyAnchors(store, SHOWCASE_PARTIES.kopi.id);
    expect(kopi.chain.anchored).toBe(kopi.chain.length);
    expect(kopi.entries[0]?.anchor.explorerUrls[0]).toBe(`https://preprod.cardanoscan.io/transaction/${open?.txHash}`);
    expect(chain.built).toHaveLength(1);
    store.close();
  });

  test('a transaction whose message differs from the saved batch is not confirmed', async () => {
    const {store} = seeded();
    const chain = new FakeChain();
    chain.wrongMessage = true;
    const {run, events} = worker(store, chain);
    await run.runOnce();
    chain.block();
    chain.block();
    await run.runOnce();
    expect(store.getOpenAnchorBatch()?.note).toContain('does not match');
    expect(events.some((event) => event.event === 'anchor_batch_mismatch')).toBe(true);
    store.close();
  });

  test('a failed send is never replaced by a new transaction: the same bytes go again, then the batch expires and its entries are batched anew', async () => {
    const {store} = seeded();
    const chain = new FakeChain();
    chain.failSubmit = true;
    let now = NOW;
    const {run} = worker(store, chain, {now: () => now});
    await run.runOnce();
    const first = store.getOpenAnchorBatch();
    expect(first?.status).toBe('submitted');
    expect(first?.note).toContain('send failed: timeout');

    await run.runOnce();
    expect(chain.sent).toHaveLength(1);
    now += RESEND_AFTER_MS;
    await run.runOnce();
    expect(chain.sent).toEqual([first?.txCbor as string, first?.txCbor as string]);
    expect(chain.built).toHaveLength(1);

    // Every resend gets a fresh interval, including after a worker restart.
    await worker(store, chain, {now: () => now}).run.runOnce();
    expect(chain.sent).toHaveLength(2);

    chain.slot = (first?.invalidHereafter as number) + EXPIRY_MARGIN_SLOTS;
    await run.runOnce();
    expect(store.getAnchorBatch(first?.id as string)?.status).toBe('submitted');
    chain.slot += 1;
    await run.runOnce();
    expect(store.getAnchorBatch(first?.id as string)?.status).toBe('expired');
    expect(store.anchorCounts().unbatched).toBe(store.anchorCounts().entries);

    chain.failSubmit = false;
    await run.runOnce();
    const second = store.getOpenAnchorBatch();
    expect(second?.id).not.toBe(first?.id);
    expect(second?.entryHashes).toEqual(first?.entryHashes as string[]);
    store.close();
  });

  test('an unfunded wallet builds nothing, and new entries wait while a batch is open', async () => {
    const {store, path} = seeded();
    const chain = new FakeChain();
    chain.funded = false;
    const {run, events} = worker(store, chain);
    await run.runOnce();
    expect(store.getOpenAnchorBatch()).toBeNull();
    expect(events.some((event) => event.event === 'anchor_wallet_unfunded')).toBe(true);

    chain.funded = true;
    chain.lands = false;
    await run.runOnce();
    const open = store.getOpenAnchorBatch();
    const db = new Database(path);
    db.query('UPDATE reliability_anchor_entries SET batch_id = NULL WHERE entry_hash = ?').run(open?.entryHashes[0] as string);
    db.close();
    await run.runOnce();
    expect(chain.built).toHaveLength(1);
    store.close();
  });

  test('a batch saved before a crash is sent on the next pass, never rebuilt', async () => {
    const {store} = seeded();
    const chain = new FakeChain();
    const {run} = worker(store, chain, {submit: false});
    run.collect();
    const entries = store.listUnbatchedAnchorEntries(10);
    store.createAnchorBatch({id: 'b1', txHash: 'aa'.repeat(32), txCbor: 'beef', invalidHereafter: 5_000, entryHashes: entries.map((entry) => entry.entryHash), createdAt: NOW});
    await run.runOnce();
    expect(chain.sent).toHaveLength(0);
    expect(store.getAnchorBatch('b1')?.status).toBe('prepared');
    await worker(store, chain, {submit: true}).run.runOnce();
    expect(chain.sent).toEqual(['beef']);
    expect(chain.built).toHaveLength(0);
    expect(store.getAnchorBatch('b1')?.status).toBe('submitted');
    store.close();
  });
});

const PARAMS: ProtocolParams = {
  minFeeA: '44', minFeeB: '155381', maxTxSize: 16384, maxValueSize: 5000, coinsPerUtxoByte: '4310', keyDeposit: '2000000', poolDeposit: '500000000',
};

describe('the Cardano anchor transaction', () => {
  test('carries the message under label 674, expires, pays change back, and is signed by the anchor key', () => {
    const key = generateAnchorKey();
    const message = [ANCHOR_MESSAGE_HEADER, 'ab'.repeat(32), 'cd'.repeat(32)];
    const built = buildAnchorTx({skeyHex: key, utxos: [{txHash: '12'.repeat(32), index: 1, lovelace: '10000000'}], params: PARAMS, message, invalidHereafter: 777});
    const fixed = C.FixedTransaction.from_hex(built.cborHex);
    expect(fixed.transaction_hash().to_hex()).toBe(built.txHash);
    const tx = C.Transaction.from_hex(built.cborHex);
    const body = tx.body();
    expect(body.ttl_bignum()?.to_str()).toBe('777');
    expect(Number(body.fee().to_str())).toBeGreaterThan(150_000);
    expect(body.outputs().len()).toBe(1);
    expect(body.outputs().get(0).address().to_bech32('addr_test')).toBe(anchorAddress(key));
    expect(Number(body.outputs().get(0).amount().coin().to_str()) + Number(body.fee().to_str())).toBe(10_000_000);
    expect(tx.witness_set().vkeys()?.len()).toBe(1);
    const lines = tx.auxiliary_data()?.metadata()?.get(C.BigNum.from_str('674'))?.as_map().get(C.TransactionMetadatum.new_text('msg')).as_list();
    expect([0, 1, 2].map((index) => lines?.get(index).as_text())).toEqual(message);
  });

  test('refuses a message line over 64 bytes and an empty wallet', () => {
    const key = generateAnchorKey();
    const utxos = [{txHash: '12'.repeat(32), index: 0, lovelace: '5000000'}];
    expect(() => buildAnchorTx({skeyHex: key, utxos, params: PARAMS, message: ['x'.repeat(65)], invalidHereafter: 1})).toThrow('64 bytes');
    expect(() => buildAnchorTx({skeyHex: key, utxos: [], params: PARAMS, message: ['x'], invalidHereafter: 1})).toThrow('no ADA-only outputs');
    expect(() => anchorAddress('not hex')).toThrow('64 hex');
  });
});

describe('Blockfrost access', () => {
  const PROJECT = 'preprodTESTKEY123';
  function client(routes: {[path: string]: () => Response}) {
    const calls: Array<{url: string; init: RequestInit}> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({url, init});
      const path = url.replace('https://bf.test', '').split('?')[0] as string;
      return (routes[path] ?? (() => new Response('{"message":"not found"}', {status: 404})))();
    }) as unknown as typeof fetch;
    return {calls, chain: new BlockfrostAnchorChain(PROJECT, generateAnchorKey(), {baseUrl: 'https://bf.test', fetch: fetcher})};
  }

  test('reads the tip, transactions, messages, and ADA-only outputs, with the key only in the header', async () => {
    const {calls, chain} = client({
      '/blocks/latest': () => Response.json({slot: 55, height: 9}),
      '/txs/aa': () => Response.json({block_height: 8, block_time: 1700}),
      '/txs/aa/metadata': () => Response.json([{label: '674', json_metadata: {msg: [ANCHOR_MESSAGE_HEADER, ZERO_HASH]}}]),
    });
    expect(await chain.tip()).toEqual({slot: 55, height: 9});
    expect(await chain.transaction('aa')).toEqual({blockHeight: 8, blockTime: 1700});
    expect(await chain.transaction('bb')).toBeNull();
    expect(await chain.anchorMessage('aa')).toEqual([ANCHOR_MESSAGE_HEADER, ZERO_HASH]);
    expect(await chain.utxos()).toEqual([]);
    expect(calls.every((call) => (call.init.headers as {[key: string]: string}).project_id === PROJECT && !call.url.includes(PROJECT))).toBe(true);
  });

  test('sends CBOR bytes, and an error never shows the key', async () => {
    const {calls, chain} = client({
      '/tx/submit': () => Response.json({message: 'BadInputsUTxO'}, {status: 400}),
    });
    const error = await chain.submit('beef').catch((caught: Error) => caught);
    expect(String(error)).toContain('/tx/submit returned 400: BadInputsUTxO');
    expect(String(error)).not.toContain(PROJECT);
    expect((calls[0]?.init.headers as {[key: string]: string})['content-type']).toBe('application/cbor');
    expect([...(calls[0]?.init.body as Buffer)]).toEqual([0xbe, 0xef]);
    expect(() => new BlockfrostAnchorChain('mainnetKEY', generateAnchorKey())).toThrow('preprod');
  });
});
