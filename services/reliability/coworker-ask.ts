/**
 * @fileoverview The Coworker chat on the Tally website. A visitor writes in
 * one chat, and Deal Desk, Mediator, or Trust Check answers. The visitor can
 * pick the Coworker, or send `auto` and let the words of the message pick it.
 * The chat is free. Nothing here pays, signs, or stores a contract: every
 * Coworker tool only reads, and a draft uses a sandbox. Paid Tasks with Masumi
 * escrow stay on Sokosumi for other agents.
 *
 * The server keeps no conversation. The browser sends the earlier messages
 * with each new message, so any instance can answer it.
 *
 * Limits keep visitors from spending the model quota that paid Tasks need:
 * - A request in the fill-in format never uses the model.
 * - At most `modelAnswersPerDay` website answers use the model (UTC day),
 *   and at most `modelAnswersPerVisitorPerDay` for one visitor.
 * - Each visitor may send `perVisitor` messages in `visitorWindowMs`.
 * - One answer runs at a time, and at most `maxQueued` wait.
 * - A model answer gets `answerMs`. After that the job asks for the fill-in
 *   format, so one slow model call cannot hold the queue.
 *
 * The worker starts this server on 127.0.0.1 when COWORKER_ASK_PORT is set.
 * The UI server forwards POST /coworkers/ask and GET /coworkers/ask?id= here.
 */

import {createHash, randomUUID} from 'node:crypto';
import type {ChatMessage, ModelProvider} from './coworker-models';
import {answerFillIn, COWORKER_NAMES, COWORKER_SLUGS, fillInProblems, needsInputMessage, runCoworker, type CoworkerSlug} from './coworker-runner';
import type {CoworkerTools} from './coworker-tools';

export interface AskLimits {
  maxTextChars: number;
  /** Only the latest earlier messages are kept. */
  maxHistoryMessages: number;
  /** A longer earlier message is cut to this length. */
  maxHistoryChars: number;
  perVisitor: number;
  visitorWindowMs: number;
  modelAnswersPerDay: number;
  modelAnswersPerVisitorPerDay: number;
  maxQueued: number;
  /** The longest wait for a model answer. A model call retries for minutes when the model is busy. */
  answerMs: number;
  /** A finished answer can be read for this long. */
  keepMs: number;
}

export const DEFAULT_ASK_LIMITS: AskLimits = {
  maxTextChars: 4000,
  maxHistoryMessages: 12,
  maxHistoryChars: 6000,
  perVisitor: 5,
  visitorWindowMs: 10 * 60_000,
  modelAnswersPerDay: 10,
  modelAnswersPerVisitorPerDay: 5,
  maxQueued: 5,
  answerMs: 2 * 60_000,
  keepMs: 30 * 60_000,
};

export type AskMode = 'model'|'fill-in'|'needs-input';

/** One earlier message of the chat, as the browser sends it. */
export interface ChatEntry {
  role: 'user'|'assistant';
  text: string;
  /** The Coworker that wrote an assistant message. */
  coworker?: CoworkerSlug;
}

export interface AskJob {
  id: string;
  coworker: CoworkerSlug;
  /** True when the message asked for `auto` and the server picked the Coworker. */
  routed: boolean;
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
  history: ChatEntry[];
  visitor: string;
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

const isSlug = (value: unknown): value is CoworkerSlug =>
  typeof value === 'string' && (COWORKER_SLUGS as readonly string[]).includes(value);

/**
 * Words that point to a Coworker, with a weight. A fill-in key weighs more
 * than a word. Only the Deal Desk writes `milestone:` with a `|`.
 */
const ROUTES: ReadonlyArray<[CoworkerSlug, RegExp, number]> = [
  ['deal-desk', /^\s*(template|item|amount|remedy|quantity|unit)\s*:|^\s*milestone\s*:.*\|/im, 3],
  ['mediator', /^\s*contract( id)?\s*:/im, 3],
  ['trust-check', /^\s*(company|counterparty)\s*:/im, 3],
  ['mediator', /\b(disput\w*|rulings?|rule on|mediat\w*|arbitrat\w*|tier 3|complain\w*)\b/i, 2],
  ['mediator', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, 2],
  ['trust-check', /\b(trust\w*|reliab\w*|credit\w*|reputation|track record|background|kyc|scores?|(record|history) of)\b/i, 2],
  ['deal-desk', /\b(draft\w*|deal|buy\w*|bought|sell\w*|purchas\w*|order\w*|escrow\w*|suppl\w*|shipment|usdm|price)\b/i, 1],
];

/**
 * The Coworker for an `auto` message. A message with no clear signal stays
 * with the Coworker that answered last, so a short follow-up keeps its thread.
 */
export function chooseCoworker(text: string, current: CoworkerSlug|null): CoworkerSlug {
  const score = new Map<CoworkerSlug, number>(COWORKER_SLUGS.map((slug) => [slug, 0]));
  for (const [slug, pattern, weight] of ROUTES) if (pattern.test(text)) score.set(slug, (score.get(slug) ?? 0) + weight);
  const [best, bestScore] = [...score].reduce((top, entry) => (entry[1] > top[1] ? entry : top));
  if (bestScore === 0) return current ?? 'deal-desk';
  return current && (score.get(current) ?? 0) >= bestScore ? current : best;
}

/** Valid earlier messages, the latest ones only, or null when the shape is wrong. */
function readHistory(value: unknown, limits: AskLimits): ChatEntry[]|null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const entries: ChatEntry[] = [];
  for (const item of value) {
    const entry = item as {role?: unknown; text?: unknown; coworker?: unknown}|null;
    if (!entry || (entry.role !== 'user' && entry.role !== 'assistant') || typeof entry.text !== 'string') return null;
    const text = entry.text.length > limits.maxHistoryChars ? `${entry.text.slice(0, limits.maxHistoryChars)}…` : entry.text;
    entries.push({role: entry.role, text, ...(isSlug(entry.coworker) ? {coworker: entry.coworker} : {})});
  }
  return entries.slice(-limits.maxHistoryMessages);
}

/**
 * The text for the fill-in path. When the new message alone is not readable,
 * the user's earlier messages to the same Coworker are added, newest first,
 * so a field sent again wins. A follow-up can then send only the missing fields.
 */
export function fillInText(slug: CoworkerSlug, text: string, history: ChatEntry[]): string {
  if (!fillInProblems(slug, text).length) return text;
  // Milestone lines repeat, so only the newest message that has them counts.
  // Otherwise a corrected message would add its lots to the old ones.
  const milestoneLine = /^\s*milestone\s*:.*$/gim;
  let milestonesSeen = milestoneLine.test(text);
  const earlier: string[] = [];
  for (const entry of [...history].reverse()) {
    if (entry.role === 'user') {
      milestoneLine.lastIndex = 0;
      const has = milestoneLine.test(entry.text);
      earlier.push(milestonesSeen ? entry.text.replace(milestoneLine, '') : entry.text);
      milestonesSeen ||= has;
    } else if (entry.coworker !== slug) {
      break;
    }
  }
  if (!earlier.length) return text;
  const combined = [text, ...earlier].join('\n');
  return fillInProblems(slug, combined).length ? text : combined;
}

/** Earlier messages for the model. A message from another Coworker carries its name. */
function modelHistory(slug: CoworkerSlug, history: ChatEntry[]): ChatMessage[] {
  return history.map((entry) => ({
    role: entry.role,
    text: entry.role === 'assistant' && entry.coworker && entry.coworker !== slug ? `(${COWORKER_NAMES[entry.coworker]} wrote:)\n${entry.text}` : entry.text,
  }));
}

export class AskService {
  private readonly limits: AskLimits;
  private readonly jobs = new Map<string, Stored>();
  private readonly queue: string[] = [];
  private readonly visits = new Map<string, number[]>();
  private running = false;
  private modelDay = '';
  private modelAnswers = 0;
  private readonly modelVisitors = new Map<string, number>();

  constructor(private readonly deps: AskDeps) {
    this.limits = {...DEFAULT_ASK_LIMITS, ...deps.limits};
  }

  submit(coworker: unknown, text: unknown, visitor: string, history?: unknown): Submitted {
    const now = this.deps.now();
    this.prune(now);
    if (coworker !== 'auto' && !isSlug(coworker)) {
      return {ok: false, status: 400, error: 'Choose a Coworker: auto, deal-desk, mediator, or trust-check.'};
    }
    const request = typeof text === 'string' ? text.trim() : '';
    if (!request) return {ok: false, status: 400, error: 'Write a request first.'};
    if (request.length > this.limits.maxTextChars) return {ok: false, status: 400, error: `Keep the request under ${this.limits.maxTextChars} characters.`};
    const earlier = readHistory(history, this.limits);
    if (!earlier) return {ok: false, status: 400, error: 'Send history as a list of {"role": "user" or "assistant", "text": "..."}.'};
    const recent = (this.visits.get(visitor) ?? []).filter((at) => now - at < this.limits.visitorWindowMs);
    if (recent.length >= this.limits.perVisitor) {
      return {ok: false, status: 429, error: `You can send ${this.limits.perVisitor} messages every ${Math.round(this.limits.visitorWindowMs / 60_000)} minutes. Try again soon.`};
    }
    if (this.queue.length >= this.limits.maxQueued) return {ok: false, status: 503, error: 'The Coworkers are busy. Try again in a minute.'};
    this.visits.set(visitor, [...recent, now]);
    const current = [...earlier].reverse().find((entry) => entry.role === 'assistant' && entry.coworker)?.coworker ?? null;
    const slug = isSlug(coworker) ? coworker : chooseCoworker(request, current);
    const job: AskJob = {id: randomUUID(), coworker: slug, routed: coworker === 'auto', status: 'queued', position: 0, answer: null, mode: null, error: null};
    this.jobs.set(job.id, {job, text: request, history: earlier, visitor, createdAt: now});
    this.queue.push(job.id);
    this.deps.log({event: 'ask_queued', id: job.id, coworker: slug, routed: job.routed, history: earlier.length, visitor: createHash('sha256').update(visitor).digest('hex').slice(0, 12)});
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
          const result = await this.answer(stored);
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

  private async answer({job: {id, coworker: slug}, text, history, visitor}: Stored): Promise<{text: string; mode: AskMode}> {
    const readable = fillInText(slug, text, history);
    const problems = fillInProblems(slug, readable);
    if (!problems.length) {
      // The fill-in format is enough. The model quota stays for paid Tasks.
      const answer = answerFillIn(slug, readable, this.deps.tools);
      return answer.kind === 'answer' ? {text: answer.text, mode: 'fill-in'} : {text: answer.message, mode: 'needs-input'};
    }
    const provider = this.deps.provider;
    if (provider?.available() && this.takeModelAnswer(visitor)) {
      try {
        const answer = await this.withinAnswerLimit(id, runCoworker(slug, text, this.deps.tools, provider, {history: modelHistory(slug, history)}));
        return answer.kind === 'answer' ? {text: answer.text, mode: answer.mode} : {text: answer.message, mode: 'needs-input'};
      } catch {
        // The model failed or took too long, and the request is not in the fill-in format.
      }
    }
    return {text: `${needsInputMessage(slug, problems)}${provider ? MODEL_BUSY_NOTE : ''}`, mode: 'needs-input'};
  }

  /**
   * Stops waiting for a model answer after `answerMs`. The model call cannot be
   * cancelled. It ends later on its own request timeouts, and its result is dropped.
   */
  private withinAnswerLimit<T>(id: string, work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>|undefined;
    const limit = new Promise<never>((resolve, reject) => {
      timer = setTimeout(() => {
        this.deps.log({event: 'ask_model_timeout', id, ms: this.limits.answerMs});
        reject(new Error('the model took too long'));
      }, this.limits.answerMs);
    });
    return Promise.race([work, limit]).finally(() => clearTimeout(timer));
  }

  /** Takes one model answer from today's website budget and the visitor's share of it. */
  private takeModelAnswer(visitor: string): boolean {
    const day = new Date(this.deps.now()).toISOString().slice(0, 10);
    if (day !== this.modelDay) {
      this.modelDay = day;
      this.modelAnswers = 0;
      this.modelVisitors.clear();
    }
    const used = this.modelVisitors.get(visitor) ?? 0;
    if (this.modelAnswers >= this.limits.modelAnswersPerDay || used >= this.limits.modelAnswersPerVisitorPerDay) return false;
    this.modelAnswers++;
    this.modelVisitors.set(visitor, used + 1);
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
      let body: {coworker?: unknown; text?: unknown; history?: unknown};
      try {
        body = await req.json() as {coworker?: unknown; text?: unknown; history?: unknown};
      } catch {
        return Response.json({error: 'Send JSON: {"coworker": "...", "text": "..."}.'}, {status: 400});
      }
      const result = service.submit(body?.coworker, body?.text, visitor, body?.history);
      return result.ok ? Response.json({job: result.job}, {status: 202}) : Response.json({error: result.error}, {status: result.status});
    },
  });
}
