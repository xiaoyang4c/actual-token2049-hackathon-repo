/**
 * @fileoverview The Coworker worker against fake Sokosumi Core and fake MPS:
 * the paid flow, input requests before payment, unknown outcomes, missing
 * funds, the model path, the fallback, and restarts.
 */

import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TEST_USDM_UNIT} from './contract-config';
import {createKit} from './contract-kit';
import {BedrockProvider, GeminiProvider, ModelError, runWithTools, type ChatTurn, type ModelProvider, type ModelReply, type ToolSpec} from './coworker-models';
import {readFields, readRemedy} from './coworker-runner';
import {CoworkerTools} from './coworker-tools';
import {CoworkerWorker, Journal, type CoreLike, type MpsLike, type WorkerCoworker} from './coworker-worker';
import {MpsError, sokosumiResultHash, type MpsPayment, type PaymentPlan, type SellerSource} from './mps-seller';
import {CoreError, type CoreEvent, type CoreReceipt, type CoreTask} from './sokosumi-core';

const COWORKER_ID = 'cw-deal-desk';
const SOURCE: SellerSource = {
  agentIdentifier: `${'ab'.repeat(28)}0001`,
  policyId: 'ab'.repeat(28),
  smartContractAddress: 'addr_test1wcontract',
  sellerVkey: 'cd'.repeat(28),
  sellerAddress: 'addr_test1qseller',
  supportedPaymentSourceIndex: 0,
};
const REQUEST = ['template: physical', 'item: Lot 1, 1,200 kg green arabica', 'amount: 4000', 'remedy: partial 70',
  'description: Green arabica', 'quantity: 1200', 'unit: kg'].join('\n');
const T0 = Date.UTC(2026, 9, 8, 2, 0, 0);

class FakeCore implements CoreLike {
  tasks = new Map<string, CoreTask>();
  log: CoreEvent[] = [];
  posted: Array<{taskId: string; body: {[key: string]: unknown}}> = [];
  failNextPost: 'uncertain'|null = null;

  addTask(id: string, description: string, status = 'READY'): void {
    this.tasks.set(id, {id, name: `Task ${id}`, description, status, assigneeId: COWORKER_ID, organizationId: 'org-1'});
    this.log.push({id: `e-${this.log.length}`, taskId: id, status, comment: null, actorType: 'user', actorId: 'u1', createdAt: new Date(T0).toISOString()});
  }

  comment(taskId: string, text: string): void {
    this.log.push({id: `e-${this.log.length}`, taskId, status: null, comment: text, actorType: 'user', actorId: 'u1', createdAt: new Date(T0 + this.log.length).toISOString()});
  }

  async events(): Promise<{events: CoreEvent[]; nextCursor: string|null}> {
    return {events: [...this.log], nextCursor: null};
  }

  async task(id: string): Promise<CoreTask> {
    const task = this.tasks.get(id);
    if (!task) throw new CoreError('missing', 404, false);
    return {...task};
  }

  async taskEvents(id: string): Promise<CoreEvent[]> {
    return this.log.filter((event) => event.taskId === id);
  }

  async postEvent(taskId: string, body: {[key: string]: unknown}): Promise<string> {
    if (this.failNextPost) {
      this.failNextPost = null;
      throw new CoreError('no response', null, true);
    }
    this.posted.push({taskId, body});
    const task = this.tasks.get(taskId);
    if (task && typeof body.status === 'string') task.status = body.status;
    const id = `p-${this.posted.length}`;
    this.log.push({id, taskId, status: typeof body.status === 'string' ? body.status : null, comment: typeof body.comment === 'string' ? body.comment : null,
      actorType: 'coworker', actorId: COWORKER_ID, createdAt: new Date(T0 + 1000 + this.posted.length).toISOString()});
    return id;
  }

  async receipt(): Promise<CoreReceipt> {
    return {blockchainIdentifier: null, onChainState: null, settled: false, txHash: null};
  }
}

class FakeMps implements MpsLike {
  payments = new Map<string, MpsPayment>();
  creates = 0;
  submits = 0;
  failCreate: 'uncertain'|null = null;

  async createPayment(plan: PaymentPlan, source: SellerSource): Promise<MpsPayment> {
    this.creates++;
    if (this.failCreate) throw new MpsError('no response', true);
    const id = `bi-${plan.taskId}`;
    const payment: MpsPayment = {
      id: `pay-${plan.taskId}`, blockchainIdentifier: id, agentIdentifier: source.agentIdentifier, inputHash: plan.inputHash,
      onChainState: null, resultHash: null, nextActionResultHash: null, requestedAction: 'WaitingForExternalAction', errorType: null,
      txHash: null, txStatus: null, confirmations: 0,
      times: {
        payByTime: String(Date.parse(plan.payByTime)), submitResultTime: String(Date.parse(plan.submitResultTime)),
        unlockTime: String(Date.parse(plan.unlockTime)), externalDisputeUnlockTime: String(Date.parse(plan.externalDisputeUnlockTime)),
      },
      funds: [{unit: TEST_USDM_UNIT, amount: plan.amountAtomic}],
      wallet: {walletVkey: source.sellerVkey, walletAddress: source.sellerAddress},
      source: {network: 'Preprod', paymentSourceType: 'Web3CardanoV2', policyId: source.policyId, smartContractAddress: source.smartContractAddress},
    };
    this.payments.set(id, payment);
    return {...payment};
  }

  async read(blockchainIdentifier: string): Promise<MpsPayment> {
    const payment = this.payments.get(blockchainIdentifier);
    if (!payment) throw new MpsError('unknown payment', false);
    return {...payment};
  }

  async submitResult(blockchainIdentifier: string, resultHash: string): Promise<MpsPayment> {
    this.submits++;
    const payment = this.payments.get(blockchainIdentifier);
    if (!payment) throw new MpsError('unknown payment', false);
    payment.resultHash = resultHash;
    payment.onChainState = 'ResultSubmitted';
    return {...payment};
  }

  lock(id: string): void {
    Object.assign(this.payments.get(id) as MpsPayment, {onChainState: 'FundsLocked', txStatus: 'Confirmed', txHash: 'aa'.repeat(32), confirmations: 1});
  }

  withdraw(id: string): void {
    Object.assign(this.payments.get(id) as MpsPayment, {onChainState: 'Withdrawn', txStatus: 'Confirmed', txHash: 'bb'.repeat(32), confirmations: 2});
  }
}

function setup(provider: ModelProvider|null = null) {
  const directory = mkdtempSync(join(tmpdir(), 'coworker-worker-'));
  const kit = createKit();
  const core = new FakeCore();
  const mps = new FakeMps();
  let now = T0;
  const coworker: WorkerCoworker = {slug: 'deal-desk', coworkerId: COWORKER_ID, source: SOURCE, core};
  const make = () => new CoworkerWorker({
    coworkers: [coworker], mps, provider, journal: new Journal(directory), priceAtomic: '1000000',
    tools: new CoworkerTools(null, {config: kit.service.config, templates: kit.service.templates, now: () => now}),
    now: () => now, log: () => {},
  });
  return {
    core, mps, make, journal: new Journal(directory),
    advance: (ms: number) => { now += ms; },
    close: () => { kit.close(); rmSync(directory, {recursive: true, force: true}); },
  };
}

describe('Coworker worker: the paid Task flow', () => {
  test('answers before payment, then pays, submits, completes, and collects, across a restart', async () => {
    const env = setup();
    env.core.addTask('t1', REQUEST);
    await env.make().runOnce();
    let entry = env.journal.read('t1');
    expect(entry?.stage).toBe('awaiting_funds');
    expect(entry?.answer?.text).toContain('Tally contract draft');
    expect(entry?.answer?.text).toContain('2,800 test USDM');
    expect(env.core.posted.map((item) => item.body.status ?? Object.keys(item.body)[0])).toEqual(['RUNNING', 'masumiPayment']);
    const event = env.core.posted[1]?.body.masumiPayment as {[key: string]: unknown};
    expect(Object.keys(event).sort()).toEqual(['Amounts', 'PaymentSource', 'agentIdentifier', 'blockchainIdentifier', 'externalDisputeUnlockTime',
      'identifierFromPurchaser', 'inputHash', 'payByTime', 'paymentSourceType', 'sellerVkey', 'submitResultTime', 'supportedPaymentSourceIndex', 'unlockTime']);
    expect(event.Amounts).toEqual([{unit: TEST_USDM_UNIT, amount: '1000000'}]);

    // Funds not locked yet: a second pass changes nothing.
    await env.make().runOnce();
    expect(env.journal.read('t1')?.stage).toBe('awaiting_funds');

    env.mps.lock('bi-t1');
    await env.make().runOnce(); // a fresh worker: the journal carries the state
    entry = env.journal.read('t1');
    expect(entry?.stage).toBe('collecting');
    const answer = entry?.answer?.text as string;
    expect(env.mps.payments.get('bi-t1')?.resultHash).toBe(sokosumiResultHash(entry?.plan?.identifierFromPurchaser as string, answer));
    expect(env.core.posted.at(-1)?.body).toEqual({status: 'COMPLETED', comment: answer});

    env.mps.withdraw('bi-t1');
    await env.make().runOnce();
    entry = env.journal.read('t1');
    expect(entry?.stage).toBe('collected');
    expect(entry?.collectionTxHash).toBe('bb'.repeat(32));
    expect(env.mps.creates).toBe(1);
    expect(env.mps.submits).toBe(1);
    env.close();
  });

  test('an unreadable request asks for input before any payment, then continues after the reply', async () => {
    const env = setup();
    env.core.addTask('t2', 'Can you help with a deal?');
    await env.make().runOnce();
    expect(env.journal.read('t2')?.stage).toBe('input_requested');
    expect(env.mps.creates).toBe(0);
    const ask = env.core.posted[0]?.body;
    expect(ask?.status).toBe('INPUT_REQUIRED');
    expect(String(ask?.comment)).toContain('template: physical');

    await env.make().runOnce(); // no reply yet
    expect(env.core.posted).toHaveLength(1);

    env.core.comment('t2', REQUEST);
    await env.make().runOnce();
    expect(env.journal.read('t2')?.stage).toBe('awaiting_funds');
    expect(env.mps.creates).toBe(1);
    env.close();
  });

  test('a request the engine rejects asks for a fix and never charges', async () => {
    const env = setup();
    env.core.addTask('t3', REQUEST.replace('amount: 4000', 'amount: 0.000001'));
    await env.make().runOnce();
    expect(env.journal.read('t3')?.stage).toBe('input_requested');
    expect(String(env.core.posted[0]?.body.comment)).toContain('invalid_amount');
    expect(env.mps.creates).toBe(0);
    env.close();
  });

  test('a payment request with an unknown outcome stops for a person and is never repeated', async () => {
    const env = setup();
    env.mps.failCreate = 'uncertain';
    env.core.addTask('t4', REQUEST);
    await env.make().runOnce();
    expect(env.journal.read('t4')?.stage).toBe('inspect');
    env.mps.failCreate = null;
    await env.make().runOnce();
    expect(env.mps.creates).toBe(1);
    expect(env.journal.read('t4')?.note).toContain('inspect MPS');
    env.close();
  });

  test('funds that never lock fail the Task, and no result is submitted', async () => {
    const env = setup();
    env.core.addTask('t5', REQUEST);
    await env.make().runOnce();
    env.advance(21 * 60_000); // past the submit-result deadline
    await env.make().runOnce();
    expect(env.journal.read('t5')?.stage).toBe('failed');
    expect(env.core.posted.at(-1)?.body.status).toBe('FAILED');
    expect(env.mps.submits).toBe(0);
    env.close();
  });

  test('an uncertain COMPLETED post is checked against the task before it is sent again', async () => {
    const env = setup();
    env.core.addTask('t6', REQUEST);
    await env.make().runOnce();
    env.mps.lock('bi-t6');
    env.core.failNextPost = 'uncertain';
    await env.make().runOnce();
    expect(env.journal.read('t6')?.stage).toBe('completing');
    await env.make().runOnce();
    expect(env.journal.read('t6')?.stage).toBe('collecting');
    expect(env.core.posted.filter((item) => item.body.status === 'COMPLETED')).toHaveLength(1);
    env.close();
  });
});

class ScriptedProvider implements ModelProvider {
  readonly name = 'gemini' as const;
  calls: ChatTurn[][] = [];
  constructor(private readonly replies: Array<ModelReply|Error>) {}

  async reply(system: string, turns: ChatTurn[]): Promise<ModelReply> {
    expect(system).toContain('Tally');
    this.calls.push(structuredClone(turns));
    const next = this.replies.shift();
    if (!next) throw new ModelError('no scripted reply');
    if (next instanceof Error) throw next;
    return next;
  }
}

describe('Coworker worker: models', () => {
  test('with a model, the model calls the engine and its answer becomes the result', async () => {
    const provider = new ScriptedProvider([
      {text: '', calls: [{id: 'c1', name: 'draftContract', args: {templateId: 'physical-objective-spec', remedyType: 'partial_release', sellerSharePercent: '70',
        milestones: [{title: 'Lot 1', amount: '4000', description: 'Green arabica', quantity: 1200, unit: 'kg'}]}}]},
      {text: 'Draft: the seller keeps 2,800 test USDM if the buyer wins.', calls: []},
    ]);
    const env = setup(provider);
    env.core.addTask('m1', 'I am buying 1,200 kg of arabica for 4000 USDM. Keep 70% for the seller if it is off-spec.');
    await env.make().runOnce();
    expect(env.journal.read('m1')?.stage).toBe('awaiting_funds');
    expect(provider.calls).toHaveLength(0); // the model runs only after the funds lock
    env.mps.lock('bi-m1');
    await env.make().runOnce();
    const toolTurn = provider.calls[1]?.find((turn) => turn.role === 'tool');
    const output = toolTurn?.role === 'tool' ? toolTurn.results[0]?.output as {ok: boolean; result: {milestones: Array<{buyerWins: {toSeller: {display: string}}}>}} : null;
    expect(output?.ok).toBe(true);
    expect(output?.result.milestones[0]?.buyerWins.toSeller.display).toBe('2,800 test USDM');
    expect(env.journal.read('m1')?.answer).toEqual({text: 'Draft: the seller keeps 2,800 test USDM if the buyer wins.', mode: 'model'});
    env.close();
  });

  test('a model outage falls back to the fill-in answer for a readable request', async () => {
    const env = setup(new ScriptedProvider([new ModelError('Gemini returned 503')]));
    env.core.addTask('m2', REQUEST);
    await env.make().runOnce();
    env.mps.lock('bi-m2');
    await env.make().runOnce();
    const answer = env.journal.read('m2')?.answer?.text ?? '';
    expect(answer).toContain('Tally contract draft');
    expect(answer).toContain('Gemini returned 503');
    expect(env.journal.read('m2')?.stage).toBe('collecting');
    env.close();
  });
});

describe('providers and parsing', () => {
  const tool: ToolSpec = {name: 'findEntities', description: 'find', parameters: {type: 'object', required: ['query'], properties: {query: {type: 'string'}}}};

  test('Gemini: upper-case schema types, function calls, and the key in a header', async () => {
    let sent: {url: string; headers: {[key: string]: string}; body: {[key: string]: unknown}}|null = null;
    const fetcher = (async (url: string, init: RequestInit) => {
      sent = {url, headers: init.headers as {[key: string]: string}, body: JSON.parse(String(init.body))};
      return new Response(JSON.stringify({candidates: [{content: {parts: [{functionCall: {name: 'findEntities', args: {query: 'kopi'}}}]}}]}));
    }) as unknown as typeof fetch;
    const reply = await new GeminiProvider('test-key', 'gemini-2.5-flash', {fetch: fetcher}).reply('rules', [{role: 'user', text: 'who is kopi?'}], [tool]);
    expect(reply.calls).toEqual([{id: 'gemini:findEntities-0', name: 'findEntities', args: {query: 'kopi'}}]);
    const request = sent as unknown as {url: string; headers: {[key: string]: string}; body: {tools: Array<{functionDeclarations: Array<{parameters: {type: string; properties: {query: {type: string}}}}>}>}};
    expect(request.url).toContain('/models/gemini-2.5-flash:generateContent');
    expect(request.url).not.toContain('test-key');
    expect(request.headers['x-goog-api-key']).toBe('test-key');
    expect(request.body.tools[0]?.functionDeclarations[0]?.parameters.type).toBe('OBJECT');
    expect(request.body.tools[0]?.functionDeclarations[0]?.parameters.properties.query.type).toBe('STRING');
  });

  test('Gemini 3: the thought signature and the call id go back unchanged on the next turn', async () => {
    const bodies: Array<{contents: Array<{role: string; parts: Array<{[key: string]: unknown}>}>}> = [];
    const replies = [
      {candidates: [{content: {role: 'model', parts: [{functionCall: {id: 'call_1', name: 'findEntities', args: {query: 'kopi'}}, thoughtSignature: 'sig-abc'}]}}]},
      {candidates: [{content: {role: 'model', parts: [{text: 'Kopi Origin Roasters has 4 simulated deals.'}]}}]},
    ];
    const fetcher = (async (url: string, init: RequestInit) => {
      expect(url).toContain('gemini-3.8-flash:generateContent');
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(replies.shift()));
    }) as unknown as typeof fetch;
    const provider = new GeminiProvider('test-key', 'gemini-3.8-flash', {fetch: fetcher});
    const result = await runWithTools(provider, 'rules', 'who is kopi?', [{...tool, run: () => ({ok: true, result: []})}]);
    expect(result.text).toBe('Kopi Origin Roasters has 4 simulated deals.');
    const second = bodies[1]?.contents ?? [];
    expect(second[1]).toEqual({role: 'model', parts: [{functionCall: {id: 'call_1', name: 'findEntities', args: {query: 'kopi'}}, thoughtSignature: 'sig-abc'}]});
    expect((second[2]?.parts[0]?.functionResponse as {id: string}).id).toBe('call_1');
  });

  test('a rate limit or an overloaded model is retried, with the wait Google asks for', async () => {
    const statuses: number[] = [];
    const replies: Array<[number, unknown]> = [
      [503, {error: {code: 503, status: 'UNAVAILABLE'}}],
      [429, {error: {code: 429, status: 'RESOURCE_EXHAUSTED', details: [{'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s'}]}}],
      [200, {candidates: [{content: {role: 'model', parts: [{text: 'OK'}]}}]}],
    ];
    const fetcher = (async () => {
      const [status, body] = replies.shift() as [number, unknown];
      statuses.push(status);
      return new Response(JSON.stringify(body), {status});
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    const provider = new GeminiProvider('test-key', 'gemini-3.8-flash', {fetch: fetcher, sleep: async (ms) => { waits.push(ms); }});
    expect((await provider.reply('rules', [{role: 'user', text: 'hi'}], [])).text).toBe('OK');
    expect(statuses).toEqual([503, 429, 200]);
    expect(waits).toEqual([2000, 7000]);
  });

  test('model retries stop after the last try, and a bad request is not retried', async () => {
    let calls = 0;
    const overloaded = (async () => { calls++; return new Response('{}', {status: 503}); }) as unknown as typeof fetch;
    const noWait = {sleep: async () => {}};
    await expect(new GeminiProvider('k', 'gemini-3.8-flash', {fetch: overloaded, ...noWait}).reply('rules', [{role: 'user', text: 'hi'}], []))
      .rejects.toThrow('Gemini returned 503 after 4 tries');
    expect(calls).toBe(4);
    calls = 0;
    const invalid = (async () => { calls++; return new Response('{}', {status: 400}); }) as unknown as typeof fetch;
    await expect(new BedrockProvider('k', 'ap-southeast-2', 'au.anthropic.claude-sonnet-4-5-20250929-v1:0', {fetch: invalid, ...noWait})
      .reply('rules', [{role: 'user', text: 'hi'}], [])).rejects.toThrow('Bedrock returned 400');
    expect(calls).toBe(1);
  });

  test('Bedrock: Converse tool use with a bearer API key', async () => {
    let auth = '';
    const fetcher = (async (url: string, init: RequestInit) => {
      auth = (init.headers as {[key: string]: string}).authorization ?? '';
      expect(url).toBe('https://bedrock-runtime.ap-southeast-2.amazonaws.com/model/au.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse');
      return new Response(JSON.stringify({output: {message: {content: [{toolUse: {toolUseId: 'tu1', name: 'findEntities', input: {query: 'kopi'}}}]}}}));
    }) as unknown as typeof fetch;
    const reply = await new BedrockProvider('bedrock-key', 'ap-southeast-2', 'au.anthropic.claude-sonnet-4-5-20250929-v1:0', {fetch: fetcher})
      .reply('rules', [{role: 'user', text: 'who is kopi?'}], [tool]);
    expect(auth).toBe('Bearer bedrock-key');
    expect(reply.calls).toEqual([{id: 'tu1', name: 'findEntities', args: {query: 'kopi'}}]);
  });

  test('the Sokosumi result hash escapes quotes, backslashes, and newlines', () => {
    const nonce = '0123456789abcdef0123';
    const text = 'a "quoted"\nline\\end';
    const expected = createHash('sha256').update(`${nonce};a \\"quoted\\"\\nline\\\\end`, 'utf8').digest('hex');
    expect(sokosumiResultHash(nonce, text)).toBe(expected);
  });

  test('fill-in fields read lines or JSON, and remedies read plain words', () => {
    expect(readFields('Template: Physical\nAMOUNT: 4000 (test USDM)\nnoise line').get('amount')).toEqual(['4000']);
    expect(readFields('{"company": "kopi", "counterparty": "highland"}').get('company')).toEqual(['kopi']);
    expect(readRemedy('partial 72.5%').remedy).toEqual({type: 'partial_release', sellerSharePercent: '72.5'});
    expect(readRemedy('refund with return').remedy).toEqual({type: 'full_refund_with_return'});
    expect(readRemedy('full refund, no return').remedy).toEqual({type: 'full_refund_no_return'});
    expect(readRemedy('redo').remedy).toEqual({type: 'redo_or_replace'});
    expect(readRemedy('partial').problem).toContain('seller keeps');
    expect(readRemedy('maybe').problem).toContain('not one of');
  });
});
