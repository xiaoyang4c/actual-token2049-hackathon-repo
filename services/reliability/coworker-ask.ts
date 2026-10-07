/**
 * @fileoverview "Ask a Coworker" on the Tally website. A visitor sends a
 * request and a Coworker answers it as a free preview. Nothing here pays,
 * signs, or stores a contract: every Coworker tool only reads, and a draft
 * uses a sandbox. Paid Tasks with escrow stay on Sokosumi.
 *
 * Limits keep visitors from spending the model quota that paid Tasks need:
 * - A request in the fill-in format never uses the model.
 * - At most `modelAnswersPerDay` website answers use the model (UTC day).
 * - Each visitor may ask `perVisitor` times in `visitorWindowMs`.
 * - One answer runs at a time, and at most `maxQueued` wait.
 *
 * The worker starts this server on 127.0.0.1 when COWORKER_ASK_PORT is set.
 * The UI server forwards POST /coworkers/ask and GET /coworkers/ask?id= here.
 */

import {createHash, randomUUID} from 'node:crypto';
import type {ModelProvider} from './coworker-models';
import {answerFillIn, COWORKER_SLUGS, fillInProblems, needsInputMessage, runCoworker, type CoworkerSlug} from './coworker-runner';
import type {CoworkerTools} from './coworker-tools';

export interface AskLimits {
  maxTextChars: number;
  perVisitor: number;
  visitorWindowMs: number;
  modelAnswersPerDay: number;
  maxQueued: number;
  /** A finished answer can be read for this long. */
  keepMs: number;
}

export const DEFAULT_ASK_LIMITS: AskLimits = {
  maxTextChars: 4000,
  perVisitor: 5,
  visitorWindowMs: 10 * 60_000,
  modelAnswersPerDay: 10,
  maxQueued: 5,
  keepMs: 30 * 60_000,
};

export type AskMode = 'model'|'fill-in'|'needs-input';

export interface AskJob {
  id: string;
  coworker: CoworkerSlug;
  status: 'queued'|'running'|'done'|'failed';
  /** Waiting jobs ahead of this one. Zero while it runs. */
  position: number;
  answer: string|null;
  mode: AskMode|null;
  error: string|null;
}

interface Stored {
  job: AskJob;
  text: string;
  createdAt: number;
}

export interface AskDeps {
  tools: CoworkerTools;
  provider: ModelProvider|null;
  now: () => number;
  log: (line: {[key: string]: unknown}) => void;
  limits?: Partial<AskLimits>;
}

export type Submitted = {ok: true; job: AskJob}|{ok: false; status: 400|429|503; error: string};

const MODEL_BUSY_NOTE = '\n\n_The AI model is busy or has used today\'s free answers, so this request needs the fill-in format._';

export class AskService {
  private readonly limits: AskLimits;
  private readonly jobs = new Map<string, Stored>();
  private readonly queue: string[] = [];
  private readonly visits = new Map<string, number[]>();
  private running = false;
  private modelDay = '';
  private modelAnswers = 0;

  constructor(private readonly deps: AskDeps) {
    this.limits = {...DEFAULT_ASK_LIMITS, ...deps.limits};
  }

  submit(coworker: unknown, text: unknown, visitor: string): Submitted {
    const now = this.deps.now();
    this.prune(now);
    if (typeof coworker !== 'string' || !(COWORKER_SLUGS as readonly string[]).includes(coworker)) {
      return {ok: false, status: 400, error: 'Choose a Coworker: deal-desk, mediator, or trust-check.'};
    }
    const request = typeof text === 'string' ? text.trim() : '';
    if (!request) return {ok: false, status: 400, error: 'Write a request first.'};
    if (request.length > this.limits.maxTextChars) return {ok: false, status: 400, error: `Keep the request under ${this.limits.maxTextChars} characters.`};
    const recent = (this.visits.get(visitor) ?? []).filter((at) => now - at < this.limits.visitorWindowMs);
    if (recent.length >= this.limits.perVisitor) {
      return {ok: false, status: 429, error: `You can ask ${this.limits.perVisitor} times every ${Math.round(this.limits.visitorWindowMs / 60_000)} minutes. Try again soon.`};
    }
    if (this.queue.length >= this.limits.maxQueued) return {ok: false, status: 503, error: 'The Coworkers are busy. Try again in a minute.'};
    this.visits.set(visitor, [...recent, now]);
    const job: AskJob = {id: randomUUID(), coworker: coworker as CoworkerSlug, status: 'queued', position: 0, answer: null, mode: null, error: null};
    this.jobs.set(job.id, {job, text: request, createdAt: now});
    this.queue.push(job.id);
    this.deps.log({event: 'ask_queued', id: job.id, coworker, visitor: createHash('sha256').update(visitor).digest('hex').slice(0, 12)});
    void this.drain();
    return {ok: true, job: this.view(job.id) as AskJob};
  }

  /** The job as the visitor sees it, or null when it is unknown or expired. */
  view(id: string): AskJob|null {
    const stored = this.jobs.get(id);
    if (!stored) return null;
    const ahead = this.queue.indexOf(id);
    return {...stored.job, position: stored.job.status === 'queued' ? Math.max(ahead, 0) + (this.running ? 1 : 0) : 0};
  }

  /** Resolves when the queue is empty. Tests use it. */
  async idle(): Promise<void> {
    while (this.running || this.queue.length) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let id = this.queue.shift(); id; id = this.queue.shift()) {
        const stored = this.jobs.get(id);
        if (!stored) continue;
        stored.job.status = 'running';
        const started = this.deps.now();
        try {
          const result = await this.answer(stored.job.coworker, stored.text);
          Object.assign(stored.job, {status: 'done', answer: result.text, mode: result.mode});
        } catch (error) {
          Object.assign(stored.job, {status: 'failed', error: 'The Coworker could not answer. Try again in a minute.'});
          this.deps.log({event: 'ask_failed', id, error: (error as Error).message});
        }
        this.deps.log({event: 'ask_done', id, coworker: stored.job.coworker, mode: stored.job.mode, ms: this.deps.now() - started});
      }
    } finally {
      this.running = false;
    }
  }

  private async answer(slug: CoworkerSlug, text: string): Promise<{text: string; mode: AskMode}> {
    const problems = fillInProblems(slug, text);
    if (!problems.length) {
      // The fill-in format is enough. The model quota stays for paid Tasks.
      const answer = answerFillIn(slug, text, this.deps.tools);
      return answer.kind === 'answer' ? {text: answer.text, mode: 'fill-in'} : {text: answer.message, mode: 'needs-input'};
    }
    const provider = this.deps.provider;
    if (provider?.available() && this.takeModelAnswer()) {
      try {
        const answer = await runCoworker(slug, text, this.deps.tools, provider);
        return answer.kind === 'answer' ? {text: answer.text, mode: answer.mode} : {text: answer.message, mode: 'needs-input'};
      } catch {
        // The model failed and the request is not in the fill-in format.
      }
    }
    return {text: `${needsInputMessage(slug, problems)}${provider ? MODEL_BUSY_NOTE : ''}`, mode: 'needs-input'};
  }

  private takeModelAnswer(): boolean {
    const day = new Date(this.deps.now()).toISOString().slice(0, 10);
    if (day !== this.modelDay) {
      this.modelDay = day;
      this.modelAnswers = 0;
    }
    if (this.modelAnswers >= this.limits.modelAnswersPerDay) return false;
    this.modelAnswers++;
    return true;
  }

  private prune(now: number): void {
    for (const [id, stored] of this.jobs) {
      if (now - stored.createdAt > this.limits.keepMs && stored.job.status !== 'queued' && stored.job.status !== 'running') this.jobs.delete(id);
    }
    for (const [visitor, times] of this.visits) {
      if (times.every((at) => now - at >= this.limits.visitorWindowMs)) this.visits.delete(visitor);
    }
  }
}

/** The HTTP face of the service. It listens on 127.0.0.1 only; the UI server forwards to it. */
export function startAskServer(service: AskService, port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/ask') return new Response('not found', {status: 404});
      if (req.method === 'GET') {
        const job = service.view(url.searchParams.get('id') ?? '');
        return job ? Response.json({job}) : Response.json({error: 'This answer is no longer available.'}, {status: 404});
      }
      if (req.method !== 'POST') return new Response('method not allowed', {status: 405, headers: {allow: 'GET, POST'}});
      const visitor = req.headers.get('x-tally-visitor') ?? 'unknown';
      let body: {coworker?: unknown; text?: unknown};
      try {
        body = await req.json() as {coworker?: unknown; text?: unknown};
      } catch {
        return Response.json({error: 'Send JSON: {"coworker": "...", "text": "..."}.'}, {status: 400});
      }
      const result = service.submit(body?.coworker, body?.text, visitor);
      return result.ok ? Response.json({job: result.job}, {status: 202}) : Response.json({error: result.error}, {status: result.status});
    },
  });
}
