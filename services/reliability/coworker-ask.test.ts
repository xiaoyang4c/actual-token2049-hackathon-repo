/**
 * @fileoverview "Ask a Coworker" on the website: the fill-in format never uses
 * the model, the website has its own daily model budget, each visitor has a
 * limit, the queue is bounded, and the HTTP routes return the job.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {AskService, startAskServer, type AskLimits} from './coworker-ask';
import {createKit} from './contract-kit';
import {ModelError, type ChatTurn, type ModelProvider, type ModelReply} from './coworker-models';
import {CoworkerTools} from './coworker-tools';

const REQUEST = ['template: physical', 'item: Lot 1, 1,200 kg green arabica, Grade A', 'amount: 4000', 'remedy: partial 70',
  'description: Green arabica, washed', 'quantity: 1200', 'unit: kg'].join('\n');
const FREE_TEXT = 'We buy 1,200 kg of arabica for 4000 USDM; the seller keeps 70% if it is off-spec.';

class FakeProvider implements ModelProvider {
  readonly name = 'gemini' as const;
  calls = 0;
  up = true;
  constructor(private readonly next: () => Promise<ModelReply>) {}

  available(): boolean {
    return this.up;
  }

  async reply(system: string, turns: ChatTurn[]): Promise<ModelReply> {
    expect(system).toContain('Tally');
    expect(turns[0]).toMatchObject({role: 'user'});
    this.calls++;
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

async function ask(service: AskService, coworker: string, text: string, visitor = 'v1') {
  const submitted = service.submit(coworker, text, visitor);
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
