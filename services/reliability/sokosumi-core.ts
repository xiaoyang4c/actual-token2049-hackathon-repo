/**
 * @fileoverview Sokosumi Core client for a Coworker runtime. It signs every
 * request with the Coworker's own API key (`coworker_...`), so it works for
 * personal and organization workspaces alike. Read
 * services/reliability/coworkers/README.md.
 *
 * Routes (Sokosumi API v1, preprod):
 * - GET  /v1/coworkers/me                 identity and capabilities
 * - GET  /v1/coworkers/me/events          task events for this Coworker
 * - GET  /v1/tasks/{id}                   one task
 * - GET  /v1/tasks/{id}/events            its events
 * - POST /v1/tasks/{id}/events            status, comment, or masumiPayment
 * - GET  /v1/tasks/{id}/receipt           the seller payment receipt
 */

export const SOKOSUMI_PREPROD_API = 'https://api.preprod.sokosumi.com';
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

export interface CoreTask {
  id: string;
  name: string;
  description: string|null;
  status: string;
  assigneeId: string|null;
  organizationId: string|null;
}

export interface CoreEvent {
  id: string;
  taskId: string;
  status: string|null;
  comment: string|null;
  actorType: string|null;
  actorId: string|null;
  createdAt: string;
}

export interface CoreReceipt {
  blockchainIdentifier: string|null;
  onChainState: string|null;
  settled: boolean;
  txHash: string|null;
}

/** `uncertain` means the request may have reached Core. Inspect the task before a retry. */
export class CoreError extends Error {
  constructor(message: string, readonly status: number|null, readonly uncertain: boolean) {
    super(message);
    this.name = 'CoreError';
  }
}

type Json = {[key: string]: unknown};

const record = (value: unknown): Json|null =>
  (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null);
const text = (value: unknown): string|null => (typeof value === 'string' ? value : null);

function toTask(value: unknown): CoreTask {
  const item = record(value);
  if (!item || typeof item.id !== 'string' || typeof item.status !== 'string') throw new CoreError('Core returned a malformed task', null, false);
  const assignee = record(item.assignee);
  return {
    id: item.id,
    name: text(item.name) ?? '',
    description: text(item.description),
    status: item.status,
    assigneeId: text(item.assigneeId) ?? (assignee?.type === 'coworker' ? text(assignee.id) : null),
    organizationId: text(item.organizationId),
  };
}

function toEvent(value: unknown): CoreEvent {
  const item = record(value);
  if (!item || typeof item.id !== 'string' || typeof item.taskId !== 'string') throw new CoreError('Core returned a malformed event', null, false);
  const actor = record(item.actor);
  return {
    id: item.id,
    taskId: item.taskId,
    status: text(item.status),
    comment: text(item.comment),
    actorType: text(actor?.type),
    actorId: text(actor?.id),
    createdAt: text(item.createdAt) ?? '',
  };
}

export class SokosumiCore {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly apiKey: string, options: {baseUrl?: string; fetch?: typeof fetch} = {}) {
    if (!/^coworker_\S+$/.test(apiKey)) throw new Error('a Coworker API key starts with coworker_ and has no spaces');
    this.baseUrl = (options.baseUrl ?? SOKOSUMI_PREPROD_API).replace(/\/+$/, '');
    this.fetcher = options.fetch ?? fetch;
  }

  /** Returns the `data` field. A POST that fails without a response is uncertain. */
  private async call(method: 'GET'|'POST', path: string, body?: Json): Promise<unknown> {
    if (!path.startsWith('/v1/') || /[\s\\#]/.test(path)) throw new Error(`unsupported Core path ${path}`);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        redirect: 'error',
        headers: {'authorization': `Bearer ${this.apiKey}`, 'accept': 'application/json', ...(body ? {'content-type': 'application/json'} : {})},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Never include the error detail: it can echo request headers.
      throw new CoreError(`Core ${method} ${path.split('?')[0]} got no response`, null, method === 'POST');
    }
    let parsed: unknown;
    try {
      const raw = await response.text();
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      throw new CoreError(`Core ${method} ${path.split('?')[0]} returned ${response.status}`, response.status, false);
    }
    const envelope = record(parsed);
    if (!envelope || !('data' in envelope)) throw new CoreError(`Core ${method} ${path.split('?')[0]} returned no data`, response.status, method === 'POST');
    return envelope.data;
  }

  async me(): Promise<{id: string; capabilities: string[]; archived: boolean}> {
    const item = record(await this.call('GET', '/v1/coworkers/me'));
    if (!item || typeof item.id !== 'string') throw new CoreError('Core returned a malformed Coworker', null, false);
    return {
      id: item.id,
      capabilities: Array.isArray(item.capabilities) ? item.capabilities.filter((value): value is string => typeof value === 'string') : [],
      archived: item.archivedAt !== null && item.archivedAt !== undefined,
    };
  }

  /** One page of this Coworker's task events. */
  async events(cursor: string|null): Promise<{events: CoreEvent[]; nextCursor: string|null}> {
    const query = new URLSearchParams({limit: String(PAGE_LIMIT)});
    if (cursor) query.set('cursor', cursor);
    const response = await this.callPage(`/v1/coworkers/me/events?${query}`);
    return {events: response.items.map(toEvent), nextCursor: response.nextCursor};
  }

  async task(id: string): Promise<CoreTask> {
    return toTask(await this.call('GET', `/v1/tasks/${encodeURIComponent(id)}`));
  }

  /** Every event of one task, oldest first. */
  async taskEvents(id: string): Promise<CoreEvent[]> {
    const events: CoreEvent[] = [];
    let cursor: string|null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({limit: String(PAGE_LIMIT)});
      if (cursor) query.set('cursor', cursor);
      const response = await this.callPage(`/v1/tasks/${encodeURIComponent(id)}/events?${query}`);
      events.push(...response.items.map(toEvent));
      if (!response.nextCursor) return events.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      cursor = response.nextCursor;
    }
    throw new CoreError(`task ${id} has more than ${MAX_PAGES} pages of events`, null, false);
  }

  /** Posts a status, a comment, or a masumiPayment event. Returns the event id. */
  async postEvent(taskId: string, body: Json): Promise<string> {
    const event = record(await this.call('POST', `/v1/tasks/${encodeURIComponent(taskId)}/events`, body));
    if (!event || typeof event.id !== 'string') throw new CoreError('Core did not confirm the event', null, true);
    return event.id;
  }

  async receipt(taskId: string): Promise<CoreReceipt> {
    const item = record(await this.call('GET', `/v1/tasks/${encodeURIComponent(taskId)}/receipt`));
    if (!item) throw new CoreError('Core returned a malformed receipt', null, false);
    return {
      blockchainIdentifier: text(item.blockchainIdentifier),
      onChainState: text(item.onChainState),
      settled: item.settled === true,
      txHash: text(item.txHash),
    };
  }

  private async callPage(path: string): Promise<{items: unknown[]; nextCursor: string|null}> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: 'GET', redirect: 'error',
        headers: {'authorization': `Bearer ${this.apiKey}`, 'accept': 'application/json'},
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CoreError(`Core GET ${path.split('?')[0]} got no response`, null, false);
    }
    if (!response.ok) throw new CoreError(`Core GET ${path.split('?')[0]} returned ${response.status}`, response.status, false);
    const body = record(await response.json().catch(() => null));
    const pagination = record(record(body?.meta)?.pagination);
    if (!body || !Array.isArray(body.data)) throw new CoreError(`Core GET ${path.split('?')[0]} returned no list`, response.status, false);
    const next = pagination?.nextCursor;
    return {items: body.data, nextCursor: typeof next === 'string' && next ? next : null};
  }
}
