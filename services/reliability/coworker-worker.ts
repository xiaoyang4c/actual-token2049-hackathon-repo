/**
 * @fileoverview The Coworker Task worker. It finds Tasks assigned to the
 * three Tally Coworkers on Sokosumi, asks for payment through the Masumi
 * payment service, waits for the buyer's funds, answers, submits the result
 * hash, completes the Task, and follows the seller collection.
 *
 * Safety rules:
 * - The journal records each stage before every external write.
 * - After a crash, a write whose outcome is unknown is never sent again
 *   blindly. The worker reads the current state; if it cannot tell, it stops
 *   that Task and marks it for a person (stage `inspect`).
 * - Without a model, the full answer is computed before payment, so a
 *   request that the engine rejects never charges anyone.
 *
 *   bun run coworkers:worker            (poll)
 *   bun run coworkers:worker --once     (one pass)
 */

import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AgentStore} from '../../packages/db/src/index';
import {loadContractConfig} from './contract-config';
import {AskService, startAskServer} from './coworker-ask';
import {BedrockProvider, GeminiProvider, ModelError, OpenAiCompatibleProvider, type ModelProvider} from './coworker-models';
import {
  answerFillIn, COWORKER_SLUGS, needsInputMessage, fillInProblems, RESULT_LIMIT_BYTES, runCoworker, type CoworkerSlug,
} from './coworker-runner';
import {CoworkerTools} from './coworker-tools';
import {
  checkPayment, collected, fundsLocked, masumiPaymentEvent, MpsError, MpsSeller, paymentPlan, sokosumiResultHash,
  type MpsPayment, type PaymentPlan, type SellerSource,
} from './mps-seller';
import {CoreError, SokosumiCore, type CoreEvent, type CoreReceipt, type CoreTask} from './sokosumi-core';

/** How long to follow a collection after the external dispute unlock before asking a person. */
const COLLECTION_GRACE_MS = 30 * 60_000;
/** Pages of the Coworker event feed read per pass. */
const EVENT_PAGES_PER_PASS = 5;

export type Stage =
  'input_requested'|'starting'|'running'|'answer_ready'|'payment_requesting'|'payment_requested'|
  'payment_event_posting'|'awaiting_funds'|'working'|'result_ready'|'result_submitting'|'completing'|
  'collecting'|'collected'|'failed'|'inspect';

const TERMINAL: ReadonlySet<Stage> = new Set<Stage>(['collected', 'failed', 'inspect']);

export interface JournalEntry {
  taskId: string;
  coworker: CoworkerSlug;
  coworkerId: string;
  stage: Stage;
  text: string;
  handledCommentIds: string[];
  answer: {text: string; mode: string}|null;
  plan: PaymentPlan|null;
  blockchainIdentifier: string|null;
  resultHash: string|null;
  collectionTxHash: string|null;
  note: string|null;
  updatedAt: string;
}

/** One JSON file per Task, written atomically. */
export class Journal {
  constructor(private readonly directory: string) {
    mkdirSync(directory, {recursive: true});
  }

  private path(taskId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new Error(`unsafe task id ${taskId}`);
    return join(this.directory, `${taskId}.json`);
  }

  read(taskId: string): JournalEntry|null {
    const path = this.path(taskId);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as JournalEntry : null;
  }

  save(entry: JournalEntry, now: number): JournalEntry {
    const next = {...entry, updatedAt: new Date(now).toISOString()};
    const path = this.path(entry.taskId);
    writeFileSync(`${path}.tmp`, JSON.stringify(next, null, 2), {mode: 0o600});
    renameSync(`${path}.tmp`, path);
    return next;
  }

  open(): JournalEntry[] {
    return readdirSync(this.directory).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as JournalEntry)
      .filter((entry) => !TERMINAL.has(entry.stage));
  }
}

/** The Core calls the worker needs. SokosumiCore implements it; tests use a fake. */
export interface CoreLike {
  events(cursor: string|null): Promise<{events: CoreEvent[]; nextCursor: string|null}>;
  task(id: string): Promise<CoreTask>;
  taskEvents(id: string): Promise<CoreEvent[]>;
  postEvent(taskId: string, body: {[key: string]: unknown}): Promise<string>;
  receipt(taskId: string): Promise<CoreReceipt>;
}

export interface MpsLike {
  createPayment(plan: PaymentPlan, source: SellerSource): Promise<MpsPayment>;
  read(blockchainIdentifier: string, source: SellerSource): Promise<MpsPayment>;
  submitResult(blockchainIdentifier: string, resultHash: string): Promise<MpsPayment>;
}

export interface WorkerCoworker {
  slug: CoworkerSlug;
  coworkerId: string;
  source: SellerSource;
  core: CoreLike;
}

export interface WorkerDeps {
  coworkers: WorkerCoworker[];
  mps: MpsLike;
  tools: CoworkerTools;
  provider: ModelProvider|null;
  journal: Journal;
  priceAtomic: string;
  now: () => number;
  log: (line: {[key: string]: unknown}) => void;
}

const uncertain = (error: unknown) =>
  (error instanceof CoreError && error.uncertain) || (error instanceof MpsError && error.uncertain);

/** Human comments that the worker has not handled yet, oldest first. */
function newComments(events: CoreEvent[], entry: JournalEntry): CoreEvent[] {
  return events.filter((event) => event.comment && event.actorType === 'user' && !entry.handledCommentIds.includes(event.id));
}

export class CoworkerWorker {
  constructor(private readonly deps: WorkerDeps) {}

  /** One pass over every Coworker: new Tasks, then every open journal entry. */
  async runOnce(): Promise<void> {
    for (const coworker of this.deps.coworkers) {
      const taskIds = new Set(this.deps.journal.open()
        .filter((entry) => entry.coworkerId === coworker.coworkerId).map((entry) => entry.taskId));
      try {
        for (const taskId of await this.discover(coworker)) taskIds.add(taskId);
      } catch (error) {
        this.deps.log({coworker: coworker.slug, event: 'discover_failed', error: (error as Error).message});
      }
      for (const taskId of taskIds) {
        try {
          await this.step(coworker, taskId);
        } catch (error) {
          this.deps.log({coworker: coworker.slug, taskId, event: 'step_failed', error: (error as Error).message});
        }
      }
    }
  }

  private async discover(coworker: WorkerCoworker): Promise<Set<string>> {
    const ids = new Set<string>();
    let cursor: string|null = null;
    for (let page = 0; page < EVENT_PAGES_PER_PASS; page++) {
      const result = await coworker.core.events(cursor);
      for (const event of result.events) {
        const entry = this.deps.journal.read(event.taskId);
        if (!entry || !TERMINAL.has(entry.stage)) ids.add(event.taskId);
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return ids;
  }

  private save(entry: JournalEntry, stage: Stage, changes: Partial<JournalEntry> = {}): JournalEntry {
    const next = this.deps.journal.save({...entry, ...changes, stage}, this.deps.now());
    this.deps.log({coworker: entry.coworker, taskId: entry.taskId, stage});
    return next;
  }

  private stop(entry: JournalEntry, note: string): JournalEntry {
    return this.save(entry, 'inspect', {note});
  }

  /** Advances one Task as far as it can go in this pass. */
  async step(coworker: WorkerCoworker, taskId: string): Promise<JournalEntry|null> {
    const core = coworker.core;
    let entry = this.deps.journal.read(taskId);
    if (entry && TERMINAL.has(entry.stage)) return entry;
    const task = await core.task(taskId);
    if (task.assigneeId !== coworker.coworkerId) return entry;

    if (!entry) {
      if (task.status !== 'READY') return null;
      entry = this.deps.journal.save({
        taskId, coworker: coworker.slug, coworkerId: coworker.coworkerId, stage: 'starting',
        text: [task.name, task.description].filter(Boolean).join('\n\n'), handledCommentIds: [], answer: null, plan: null,
        blockchainIdentifier: null, resultHash: null, collectionTxHash: null, note: null, updatedAt: '',
      }, this.deps.now());
    }

    if (entry.stage === 'input_requested') {
      const comments = newComments(await core.taskEvents(taskId), entry);
      if (!comments.length) return entry;
      entry = this.save(entry, 'starting', {
        text: [entry.text, ...comments.map((event) => event.comment as string)].join('\n\n'),
        handledCommentIds: [...entry.handledCommentIds, ...comments.map((event) => event.id)],
      });
    }

    if (entry.stage === 'starting') {
      // A restart can leave only the initial journal write. Validate before charging.
      if (!entry.answer) entry = await this.prepare(coworker, entry, task);
      if (entry.stage === 'input_requested' || TERMINAL.has(entry.stage)) return entry;
      entry = await this.start(coworker, entry, task);
    }
    if (entry.stage === 'running' || entry.stage === 'answer_ready') entry = await this.requestPayment(coworker, entry);
    if (entry.stage === 'payment_requesting') return this.stop(entry, 'the payment request may have reached MPS without a saved reply; inspect MPS before a retry');
    if (entry.stage === 'payment_requested') entry = await this.postPaymentEvent(coworker, entry);
    if (entry.stage === 'payment_event_posting') return this.stop(entry, 'the payment event may have reached Sokosumi; inspect the Task before a retry');
    if (entry.stage === 'awaiting_funds') entry = await this.awaitFunds(coworker, entry);
    if (entry.stage === 'working') entry = await this.work(coworker, entry);
    if (entry.stage === 'result_ready' || entry.stage === 'result_submitting') entry = await this.submit(coworker, entry);
    if (entry.stage === 'completing') entry = await this.complete(coworker, entry);
    if (entry.stage === 'collecting') entry = await this.collect(coworker, entry);
    return entry;
  }

  /**
   * Without a model, or while every model has used up its quota: compute the
   * whole answer now, before any payment. A request that is unreadable or that
   * the engine rejects asks for input.
   */
  private async prepare(coworker: WorkerCoworker, entry: JournalEntry, task: CoreTask): Promise<JournalEntry> {
    if (this.deps.provider?.available()) return entry;
    if (this.deps.provider) this.deps.log({coworker: coworker.slug, taskId: entry.taskId, event: 'model_unavailable', using: 'fill-in'});
    const problems = fillInProblems(coworker.slug, entry.text);
    const answer = problems.length ? null : answerFillIn(coworker.slug, entry.text, this.deps.tools);
    if (answer?.kind === 'answer') return this.save(entry, 'starting', {answer: {text: answer.text, mode: answer.mode}});
    const message = answer?.kind === 'needs_input' ? answer.message : needsInputMessage(coworker.slug, problems);
    // Ask once per new request. The comment and the status go in one event.
    try {
      await coworker.core.postEvent(task.id, {status: 'INPUT_REQUIRED', comment: message});
    } catch (error) {
      if (!uncertain(error)) throw error;
    }
    return this.save(entry, 'input_requested', {note: 'waiting for the requester to reply in the fill-in format'});
  }

  private async start(coworker: WorkerCoworker, entry: JournalEntry, task: CoreTask): Promise<JournalEntry> {
    if (task.status !== 'RUNNING') {
      try {
        await coworker.core.postEvent(task.id, {status: 'RUNNING'});
      } catch (error) {
        if (!uncertain(error)) throw error;
        if ((await coworker.core.task(task.id)).status !== 'RUNNING') return this.stop(entry, 'the RUNNING status is unconfirmed');
      }
    }
    return this.save(entry, entry.answer ? 'answer_ready' : 'running');
  }

  private async requestPayment(coworker: WorkerCoworker, entry: JournalEntry): Promise<JournalEntry> {
    const task = await coworker.core.task(entry.taskId);
    const plan = paymentPlan({id: task.id, name: task.name, description: task.description}, coworker.source, this.deps.priceAtomic, this.deps.now());
    const pending = this.save(entry, 'payment_requesting', {plan});
    let payment: MpsPayment;
    try {
      payment = await this.deps.mps.createPayment(plan, coworker.source);
    } catch (error) {
      if (uncertain(error)) return pending; // step() stops it for a person
      return this.fail(coworker, pending, `the payment request failed: ${(error as Error).message}`);
    }
    return this.save(pending, 'payment_requested', {blockchainIdentifier: payment.blockchainIdentifier});
  }

  private async postPaymentEvent(coworker: WorkerCoworker, entry: JournalEntry): Promise<JournalEntry> {
    const plan = entry.plan as PaymentPlan;
    const payment = await this.deps.mps.read(entry.blockchainIdentifier as string, coworker.source);
    checkPayment(payment, plan, coworker.source);
    const pending = this.save(entry, 'payment_event_posting');
    try {
      await coworker.core.postEvent(entry.taskId, masumiPaymentEvent(coworker.source, plan, payment));
    } catch (error) {
      if (uncertain(error)) return pending;
      return this.fail(coworker, pending, `Sokosumi refused the payment event: ${(error as Error).message}`);
    }
    return this.save(pending, 'awaiting_funds');
  }

  private async awaitFunds(coworker: WorkerCoworker, entry: JournalEntry): Promise<JournalEntry> {
    const plan = entry.plan as PaymentPlan;
    const payment = await this.deps.mps.read(entry.blockchainIdentifier as string, coworker.source);
    if (fundsLocked(payment)) return this.save(entry, entry.answer ? 'result_ready' : 'working');
    if (payment.onChainState !== null && payment.onChainState !== 'FundsLocked') {
      return this.fail(coworker, entry, `the escrow is ${payment.onChainState}, not FundsLocked`);
    }
    if (this.deps.now() >= Date.parse(plan.submitResultTime)) {
      return this.fail(coworker, entry, 'the buyer funds did not lock before the result deadline');
    }
    return entry;
  }

  private async work(coworker: WorkerCoworker, entry: JournalEntry): Promise<JournalEntry> {
    let answer;
    try {
      answer = await runCoworker(coworker.slug, entry.text, this.deps.tools, this.deps.provider);
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      return this.fail(coworker, entry, `the language model failed: ${error.message}`);
    }
    // A paid model answer that asks for input is still the answer to this Task.
    const text = answer.kind === 'answer' ? answer.text : answer.message;
    if (Buffer.byteLength(text, 'utf8') > RESULT_LIMIT_BYTES) return this.fail(coworker, entry, 'the answer is longer than 1 MiB');
    return this.save(entry, 'result_ready', {answer: {text, mode: answer.kind === 'answer' ? answer.mode : 'model'}});
  }

  private async submit(coworker: WorkerCoworker, entry: JournalEntry): Promise<JournalEntry> {
    const plan = entry.plan as PaymentPlan;
    const text = (entry.answer as {text: string}).text;
    const hash = sokosumiResultHash(plan.identifierFromPurchaser, text);
    const current = await this.deps.mps.read(entry.blockchainIdentifier as string, coworker.source);
    if (current.resultHash === hash || current.nextActionResultHash === hash) return this.save(entry, 'completing', {resultHash: hash});
    if (current.resultHash || current.nextActionResultHash) return this.stop(entry, 'the escrow already has a different result hash');
    if (this.deps.now() >= Date.parse(plan.submitResultTime)) return this.fail(coworker, entry, 'the result deadline passed before submission');
    if (!fundsLocked(current)) return this.stop(entry, `the escrow is ${current.onChainState ?? 'not funded'}; the result was not submitted`);
    const pending = this.save(entry, 'result_submitting', {resultHash: hash});
    try {
      await this.deps.mps.submitResult(entry.blockchainIdentifier as string, hash);
    } catch (error) {
      if (uncertain(error)) return pending; // the next pass reads the escrow first
      throw error;
    }
    return this.save(pending, 'completing');
  }

  private async complete(coworker: WorkerCoworker, entry: JournalEntry): Promise<JournalEntry> {
    // Core may have accepted the event before the collecting stage reached disk.
    if ((await coworker.core.task(entry.taskId)).status === 'COMPLETED') return this.save(entry, 'collecting');
    try {
      await coworker.core.postEvent(entry.taskId, {status: 'COMPLETED', comment: (entry.answer as {text: string}).text});
    } catch (error) {
      if (!uncertain(error)) throw error;
      if ((await coworker.core.task(entry.taskId)).status !== 'COMPLETED') return entry; // retry next pass
    }
    return this.save(entry, 'collecting');
  }

  private async collect(coworker: WorkerCoworker, entry: JournalEntry): Promise<JournalEntry> {
    const plan = entry.plan as PaymentPlan;
    const payment = await this.deps.mps.read(entry.blockchainIdentifier as string, coworker.source);
    if (collected(payment)) return this.save(entry, 'collected', {collectionTxHash: payment.txHash, note: 'seller collection confirmed by MPS'});
    if (this.deps.now() >= Date.parse(plan.externalDisputeUnlockTime) + COLLECTION_GRACE_MS) {
      return this.stop(entry, `collection not confirmed; the escrow is ${payment.onChainState ?? 'unknown'}`);
    }
    return entry;
  }

  /** Marks the Task failed on Sokosumi. No result is submitted, so the buyer's escrow refunds. */
  private async fail(coworker: WorkerCoworker, entry: JournalEntry, reason: string): Promise<JournalEntry> {
    try {
      await coworker.core.postEvent(entry.taskId, {status: 'FAILED', comment: `${reason}. No result was submitted, so the escrowed funds return to the buyer.`});
    } catch {
      // Recorded below; a person reconciles the Task.
    }
    return this.save(entry, 'failed', {note: reason});
  }
}

// ---------------------------------------------------------------------------
// Configuration and entry point
// ---------------------------------------------------------------------------

export interface WorkerFileConfig {
  priceAtomic: string;
  source: Omit<SellerSource, 'agentIdentifier'>;
  coworkers: Array<{slug: CoworkerSlug; coworkerId: string; agentIdentifier: string}>;
}

function secret(directory: string, name: string): string|null {
  const path = join(directory, name);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
}

/** Each model has its own free-tier quota (20 requests a day in October 2026), so the worker tries them in turn. */
export const DEFAULT_GEMINI_MODELS = 'gemini-3.8-flash,gemini-3.5-flash,gemini-3.1-flash-lite';

/** Builds the provider from COWORKER_MODEL_PROVIDER: none, gemini, bedrock, or openai-compatible. */
export function providerFromEnv(env: Record<string, string|undefined>, secretsDir: string): ModelProvider|null {
  const name = (env.COWORKER_MODEL_PROVIDER ?? 'none').trim().toLowerCase();
  if (name === 'none') return null;
  if (name === 'gemini') {
    const key = secret(secretsDir, 'gemini_api_key');
    if (!key) throw new Error('COWORKER_MODEL_PROVIDER=gemini needs the gemini_api_key secret');
    return new GeminiProvider(key, env.COWORKER_GEMINI_MODEL ?? DEFAULT_GEMINI_MODELS);
  }
  if (name === 'bedrock') {
    const key = secret(secretsDir, 'bedrock_api_key');
    if (!key) throw new Error('COWORKER_MODEL_PROVIDER=bedrock needs the bedrock_api_key secret');
    return new BedrockProvider(key, env.COWORKER_BEDROCK_REGION ?? 'ap-southeast-2',
      env.COWORKER_BEDROCK_MODEL_ID ?? 'au.anthropic.claude-sonnet-4-5-20250929-v1:0');
  }
  if (name === 'openai-compatible') {
    const key = secret(secretsDir, 'openai_compatible_api_key');
    if (!key) throw new Error('COWORKER_MODEL_PROVIDER=openai-compatible needs the openai_compatible_api_key secret');
    const baseUrl = env.COWORKER_OPENAI_BASE_URL?.trim();
    const models = env.COWORKER_OPENAI_MODEL?.trim();
    if (!baseUrl || !models) throw new Error('COWORKER_MODEL_PROVIDER=openai-compatible needs COWORKER_OPENAI_BASE_URL and COWORKER_OPENAI_MODEL');
    const minIntervalMs = Number(env.COWORKER_OPENAI_MIN_INTERVAL_MS ?? 0);
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) throw new Error('COWORKER_OPENAI_MIN_INTERVAL_MS must be a number of milliseconds');
    return new OpenAiCompatibleProvider(key, baseUrl, models, {minIntervalMs});
  }
  throw new Error(`COWORKER_MODEL_PROVIDER must be none, gemini, bedrock, or openai-compatible (got ${name})`);
}

async function main(): Promise<void> {
  const env = process.env;
  const secretsDir = env.TALLY_SECRETS_DIR ?? join(homedir(), 'tally-secrets');
  const stateDir = env.COWORKER_STATE_DIR ?? join(homedir(), 'tally-app', 'data', 'coworker-worker');
  const configPath = env.COWORKER_CONFIG ?? join(import.meta.dir, '..', '..', 'deploy', 'preprod', 'coworkers.json');
  const databasePath = env.CONTROL_DB_PATH;
  if (!databasePath) throw new Error('set CONTROL_DB_PATH to the control API database');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as WorkerFileConfig;
  const mpsToken = secret(secretsDir, 'mps_worker_token');
  if (!mpsToken) throw new Error('the mps_worker_token secret is missing');
  const coworkers: WorkerCoworker[] = [];
  for (const item of config.coworkers) {
    if (!(COWORKER_SLUGS as readonly string[]).includes(item.slug)) throw new Error(`unknown Coworker ${item.slug}`);
    const key = secret(secretsDir, `coworker_${item.slug.replace('-', '_')}_key`);
    if (!key) {
      console.log(JSON.stringify({coworker: item.slug, event: 'skipped', reason: 'no runtime key'}));
      continue;
    }
    coworkers.push({slug: item.slug, coworkerId: item.coworkerId, source: {...config.source, agentIdentifier: item.agentIdentifier}, core: new SokosumiCore(key)});
  }
  const provider = providerFromEnv(env, secretsDir);
  const store = AgentStore.open(databasePath);
  const tools = new CoworkerTools(store, {config: loadContractConfig(env)});
  const log = (line: {[key: string]: unknown}) => console.log(JSON.stringify({at: new Date().toISOString(), ...line}));
  const worker = new CoworkerWorker({
    coworkers,
    mps: new MpsSeller(mpsToken, {baseUrl: env.MPS_BASE_URL}),
    tools,
    provider,
    journal: new Journal(stateDir),
    priceAtomic: config.priceAtomic,
    now: () => Date.now(),
    log,
  });
  // The website chat shares the tools and the model, so it shares its quota limits too.
  const askPort = env.COWORKER_ASK_PORT ? Number(env.COWORKER_ASK_PORT) : null;
  const ask = askPort ? startAskServer(new AskService({
    tools, provider, now: () => Date.now(), log,
    limits: {
      ...(env.COWORKER_ASK_MODEL_PER_DAY ? {modelAnswersPerDay: Number(env.COWORKER_ASK_MODEL_PER_DAY)} : {}),
      ...(env.COWORKER_ASK_MODEL_PER_VISITOR ? {modelAnswersPerVisitorPerDay: Number(env.COWORKER_ASK_MODEL_PER_VISITOR)} : {}),
    },
  }), askPort) : null;
  console.log(JSON.stringify({event: 'worker_started', coworkers: coworkers.map((item) => item.slug), provider: provider?.name ?? 'none', askPort}));
  const once = process.argv.includes('--once');
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
  const intervalMs = Number(env.COWORKER_POLL_MS ?? 10_000);
  do {
    await worker.runOnce();
    if (once) break;
    try {
      await delay(intervalMs, undefined, {signal: stop.signal});
    } catch {
      break;
    }
  } while (!stop.signal.aborted);
  await ask?.stop();
  store.close();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(JSON.stringify({event: 'worker_stopped', error: (error as Error).message}));
    process.exit(1);
  });
}
