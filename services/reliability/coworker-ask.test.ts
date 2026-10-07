/**
 * @fileoverview "Ask a Coworker" on the website: the fill-in format never uses
 * the model, the website has its own daily model budget, each visitor has a
 * limit, the queue is bounded, and the HTTP routes return the job.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {AskService, chooseCoworker, fillInText, startAskServer, type AskLimits, type ChatEntry} from './coworker-ask';
import {createKit} from './contract-kit';
import {historyTurns, ModelError, type ChatTurn, type ModelProvider, type ModelReply} from './coworker-models';
import {CoworkerTools} from './coworker-tools';

const REQUEST = ['template: physical', 'item: Lot 1, 1,200 kg green arabica, Grade A', 'amount: 4000', 'remedy: partial 70',
  'description: Green arabica, washed', 'quantity: 1200', 'unit: kg'].join('\n');
const FREE_TEXT = 'We buy 1,200 kg of arabica for 4000 USDM; the seller keeps 70% if it is off-spec.';

class FakeProvider implements ModelProvider {
  readonly name = 'gemini' as const;
  calls = 0;
  up = true;
  lastSystem = '';
  lastTurns: ChatTurn[] = [];
  constructor(private readonly next: () => Promise<ModelReply>) {}

  available(): boolean {
    return this.up;
  }

  async reply(system: string, turns: ChatTurn[]): Promise<ModelReply> {
    expect(system).toContain('Tally');
    expect(turns[0]).toMatchObject({role: 'user'});
    this.calls++;
    this.lastSystem = system;
    this.lastTurns = turns;
    return this.next();
  }
}

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

function setup(provider: ModelProvider|null, limits: Partial<AskLimits> = {}) {
  const kit = createKit();
  closers.push(() => kit.close());
  let now = Date.UTC(2026, 9, 8, 2, 0, 0);
  const service = new AskService({
    tools: new CoworkerTools(null, {config: kit.service.config, templates: kit.service.templates, now: () => now}),
    provider, now: () => now, log: () => {}, limits,
  });
  return {service, advance: (ms: number) => { now += ms; }};
}

async function ask(service: AskService, coworker: string, text: string, visitor = 'v1', history?: ChatEntry[]) {
  const submitted = service.submit(coworker, text, visitor, history);
  if (!submitted.ok) throw new Error(submitted.error);
  await service.idle();
  return service.view(submitted.job.id);
}

describe('Ask a Coworker on the website', () => {
  test('a request in the fill-in format is answered without the model', async () => {
    const provider = new FakeProvider(async () => ({text: 'model text', calls: []}));
    const {service} = setup(provider);
    const job = await ask(service, 'deal-desk', REQUEST);
    expect(job).toMatchObject({status: 'done', mode: 'fill-in', error: null});
    expect(job?.answer).toContain('## Tally contract draft: Lot 1');
    expect(provider.calls).toBe(0);
  });

  test('free text uses the model until the website budget for the day is spent', async () => {
    const provider = new FakeProvider(async () => ({text: 'The seller keeps 2,800 test USDM if the buyer wins.', calls: []}));
    const {service, advance} = setup(provider, {modelAnswersPerDay: 1});
    expect(await ask(service, 'deal-desk', FREE_TEXT)).toMatchObject({status: 'done', mode: 'model', answer: 'The seller keeps 2,800 test USDM if the buyer wins.'});
    const second = await ask(service, 'deal-desk', FREE_TEXT, 'v2');
    expect(second).toMatchObject({status: 'done', mode: 'needs-input'});
    expect(second?.answer).toContain('```text\ntemplate: physical');
    expect(second?.answer).toContain('used today\'s free answers');
    expect(provider.calls).toBe(1);
    advance(24 * 3_600_000);
    expect(await ask(service, 'deal-desk', FREE_TEXT, 'v3')).toMatchObject({mode: 'model'});
  });

  test('a model failure on free text asks for the fill-in format', async () => {
    const provider = new FakeProvider(async () => { throw new ModelError('Gemini returned 503'); });
    const {service} = setup(provider);
    const job = await ask(service, 'trust-check', 'Is Highland Estates reliable?');
    expect(job).toMatchObject({status: 'done', mode: 'needs-input'});
    expect(job?.answer).toContain('company: <company name or Tally id>');
  });

  test('without a model, free text asks for the fill-in format, with no note about a busy model', async () => {
    const {service} = setup(null);
    const job = await ask(service, 'deal-desk', FREE_TEXT);
    expect(job?.mode).toBe('needs-input');
    expect(job?.answer).not.toContain('busy');
  });

  test('each visitor has a limit per window', async () => {
    const {service, advance} = setup(null, {perVisitor: 2, visitorWindowMs: 60_000});
    await ask(service, 'deal-desk', REQUEST);
    await ask(service, 'deal-desk', REQUEST);
    expect(service.submit('deal-desk', REQUEST, 'v1')).toMatchObject({ok: false, status: 429});
    expect(service.submit('deal-desk', REQUEST, 'v2').ok).toBe(true);
    advance(60_000);
    expect(service.submit('deal-desk', REQUEST, 'v1').ok).toBe(true);
    await service.idle();
  });

  test('the default visitor limit is five requests every ten minutes', async () => {
    const {service, advance} = setup(null);
    for (let i = 0; i < 5; i++) await ask(service, 'deal-desk', REQUEST);
    expect(service.submit('deal-desk', REQUEST, 'v1')).toMatchObject({ok: false, status: 429});
    advance(10 * 60_000);
    expect(service.submit('deal-desk', REQUEST, 'v1').ok).toBe(true);
    await service.idle();
  });

  test('bad input is refused before it is queued', () => {
    const {service} = setup(null, {maxTextChars: 50});
    expect(service.submit('accountant', REQUEST, 'v1')).toMatchObject({ok: false, status: 400});
    expect(service.submit('deal-desk', '   ', 'v1')).toMatchObject({ok: false, status: 400});
    expect(service.submit('deal-desk', 'x'.repeat(51), 'v1')).toMatchObject({ok: false, status: 400});
    expect(service.submit('deal-desk', {text: 1}, 'v1')).toMatchObject({ok: false, status: 400});
  });

  test('the queue is bounded, and waiting jobs report their position', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = new FakeProvider(async () => { await gate; return {text: 'done', calls: []}; });
    const {service} = setup(provider, {maxQueued: 1, perVisitor: 10});
    const first = service.submit('deal-desk', FREE_TEXT, 'v1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = service.submit('deal-desk', FREE_TEXT, 'v2');
    expect(second.ok && second.job.position).toBe(1);
    expect(service.submit('deal-desk', FREE_TEXT, 'v3')).toMatchObject({ok: false, status: 503});
    release();
    await service.idle();
    expect(first.ok && service.view(first.job.id)?.status).toBe('done');
  });

  test('HTTP: POST queues a job, GET reads it, and an unknown id is 404', async () => {
    const {service} = setup(null);
    const server = startAskServer(service, 0);
    closers.push(() => { void server.stop(true); });
    const base = `http://127.0.0.1:${server.port}/ask`;
    const posted = await fetch(base, {method: 'POST', headers: {'content-type': 'application/json', 'x-tally-visitor': 'v1'}, body: JSON.stringify({coworker: 'deal-desk', text: REQUEST})});
    expect(posted.status).toBe(202);
    const {job} = await posted.json() as {job: {id: string}};
    await service.idle();
    const read = await fetch(`${base}?id=${job.id}`);
    expect(await read.json()).toMatchObject({job: {id: job.id, status: 'done', mode: 'fill-in'}});
    expect((await fetch(`${base}?id=nope`)).status).toBe(404);
    expect((await fetch(base, {method: 'POST', body: 'not json'})).status).toBe(400);
    expect((await fetch(base, {method: 'DELETE'})).status).toBe(405);
  });
});

describe('the Coworker chat on the website', () => {
  test('auto picks the Coworker from the words, and a follow-up stays with the last one', () => {
    expect(chooseCoworker('What is the record of Highland Estates Coffee?', null)).toBe('trust-check');
    expect(chooseCoworker('Is this supplier reliable enough to buy from?', null)).toBe('trust-check');
    expect(chooseCoworker('The buyer opened a dispute on the coffee lot. Who should win?', null)).toBe('mediator');
    expect(chooseCoworker('contract: 009c0d3c-18af-42db-b7bb-8126981a7e7d\nmilestone: 0', null)).toBe('mediator');
    expect(chooseCoworker(FREE_TEXT, null)).toBe('deal-desk');
    expect(chooseCoworker(REQUEST, 'trust-check')).toBe('deal-desk');
    expect(chooseCoworker('make it 5000 instead', 'mediator')).toBe('mediator');
    expect(chooseCoworker('hello', null)).toBe('deal-desk');
  });

  test('an auto message reports the Coworker it picked', async () => {
    const {service} = setup(null);
    const job = await ask(service, 'auto', 'company: Highland Estates Coffee');
    expect(job).toMatchObject({coworker: 'trust-check', routed: true, status: 'done'});
    const pinned = await ask(service, 'deal-desk', REQUEST);
    expect(pinned).toMatchObject({coworker: 'deal-desk', routed: false});
  });

  test('the model reads the earlier messages, and the prompt says it is the website chat', async () => {
    const provider = new FakeProvider(async () => ({text: 'Updated draft.', calls: []}));
    const {service} = setup(provider);
    const history: ChatEntry[] = [
      {role: 'user', text: FREE_TEXT},
      {role: 'assistant', text: 'Here is the draft.', coworker: 'deal-desk'},
      {role: 'user', text: 'Who is Highland?'},
      {role: 'assistant', text: 'Highland has 3 contracts.', coworker: 'trust-check'},
    ];
    const job = await ask(service, 'deal-desk', 'Change the seller share to 60 percent.', 'v1', history);
    expect(job).toMatchObject({status: 'done', mode: 'model', answer: 'Updated draft.'});
    expect(provider.lastSystem).toContain('chat on the Tally website');
    expect(provider.lastTurns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(provider.lastTurns[3]).toMatchObject({text: expect.stringContaining('(Tally Trust Check wrote:)')});
    expect(provider.lastTurns[1]).toMatchObject({text: 'Here is the draft.'});
    expect(provider.lastTurns[4]).toMatchObject({text: 'Change the seller share to 60 percent.'});
  });

  test('a fill-in follow-up can send only the missing fields', async () => {
    const {service} = setup(null);
    const partial = REQUEST.split('\n').filter((line) => !line.startsWith('amount')).join('\n');
    const first = await ask(service, 'deal-desk', partial);
    expect(first?.mode).toBe('needs-input');
    const history: ChatEntry[] = [{role: 'user', text: partial}, {role: 'assistant', text: first?.answer ?? '', coworker: 'deal-desk'}];
    const second = await ask(service, 'auto', 'amount: 4000', 'v1', history);
    expect(second).toMatchObject({coworker: 'deal-desk', mode: 'fill-in'});
    expect(second?.answer).toContain('## Tally contract draft: Lot 1');
    // Another Coworker's thread is not mixed in.
    expect(fillInText('deal-desk', 'amount: 4000', [{role: 'user', text: partial}, {role: 'assistant', text: 'x', coworker: 'trust-check'}])).toBe('amount: 4000');
  });

  test('a follow-up takes milestone lines from the newest message only', () => {
    const earlier = `${REQUEST.replace('amount: 4000\n', '')}\nmilestone: Lot 2 | 2500`;
    const history: ChatEntry[] = [{role: 'user', text: earlier}, {role: 'assistant', text: 'missing amount', coworker: 'deal-desk'}];
    const merged = fillInText('deal-desk', 'amount: 4000\nmilestone: Lot 3 | 1000', history);
    expect(merged.match(/milestone:/g)).toHaveLength(1);
    expect(merged).toContain('Lot 3 | 1000');
    // Without new milestone lines, the earlier ones still count.
    expect(fillInText('deal-desk', 'amount: 4000', history)).toContain('milestone: Lot 2 | 2500');
  });

  test('one visitor cannot spend the whole daily model budget', async () => {
    const provider = new FakeProvider(async () => ({text: 'model text', calls: []}));
    const {service} = setup(provider, {modelAnswersPerDay: 5, modelAnswersPerVisitorPerDay: 2});
    for (let i = 0; i < 2; i++) expect(await ask(service, 'deal-desk', FREE_TEXT, 'v1')).toMatchObject({mode: 'model'});
    expect(await ask(service, 'deal-desk', FREE_TEXT, 'v1')).toMatchObject({mode: 'needs-input'});
    expect(await ask(service, 'deal-desk', FREE_TEXT, 'v2')).toMatchObject({mode: 'model'});
    expect(provider.calls).toBe(3);
  });

  test('bad history is refused, and long history is cut to the latest messages', async () => {
    const {service} = setup(null, {maxHistoryMessages: 2, maxHistoryChars: 5});
    expect(service.submit('auto', 'hi', 'v1', 'not a list')).toMatchObject({ok: false, status: 400});
    expect(service.submit('auto', 'hi', 'v1', [{role: 'system', text: 'x'}])).toMatchObject({ok: false, status: 400});
    expect(service.submit('auto', 'hi', 'v1', [{role: 'user'}])).toMatchObject({ok: false, status: 400});
    const many: ChatEntry[] = [
      {role: 'user', text: 'company: Highland'},
      {role: 'assistant', text: 'a long trust check answer', coworker: 'trust-check'},
      {role: 'user', text: 'ok'},
      {role: 'assistant', text: 'draft', coworker: 'deal-desk'},
    ];
    // Only the last two messages count, so the last Coworker is the Deal Desk.
    expect(service.submit('auto', 'thanks', 'v1', many)).toMatchObject({ok: true, job: {coworker: 'deal-desk'}});
    await service.idle();
  });

  test('earlier messages become alternating turns that start with the user', () => {
    expect(historyTurns([
      {role: 'assistant', text: 'welcome'},
      {role: 'user', text: 'a'},
      {role: 'user', text: 'b'},
      {role: 'assistant', text: 'c'},
      {role: 'user', text: 'd'},
    ])).toEqual({
      turns: [{role: 'user', text: 'a\n\nb'}, {role: 'assistant', text: 'c', calls: []}],
      pending: 'd',
    });
    expect(historyTurns([])).toEqual({turns: [], pending: null});
  });

  test('HTTP: POST accepts auto and history', async () => {
    const {service} = setup(null);
    const server = startAskServer(service, 0);
    closers.push(() => { void server.stop(true); });
    const partial = REQUEST.split('\n').filter((line) => !line.startsWith('amount')).join('\n');
    const posted = await fetch(`http://127.0.0.1:${server.port}/ask`, {
      method: 'POST', headers: {'content-type': 'application/json', 'x-tally-visitor': 'v1'},
      body: JSON.stringify({coworker: 'auto', text: 'amount: 4000', history: [{role: 'user', text: partial}, {role: 'assistant', text: 'missing amount', coworker: 'deal-desk'}]}),
    });
    expect(posted.status).toBe(202);
    const {job} = await posted.json() as {job: {id: string; coworker: string}};
    expect(job.coworker).toBe('deal-desk');
    await service.idle();
    expect(service.view(job.id)).toMatchObject({status: 'done', mode: 'fill-in'});
  });
});
