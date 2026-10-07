/**
 * @fileoverview Language model providers for the Coworkers. The provider is
 * one setting: `none` (no model; the Coworker answers a fill-in format),
 * `gemini` (Google Gemini API), or `bedrock` (Amazon Bedrock Converse API with
 * a Bedrock API key). Switching needs no code change.
 *
 * The model never calculates. It can only ask for a tool; Tally's code runs
 * the tool and returns the result. Read services/reliability/coworkers/README.md.
 */

import {setTimeout as delay} from 'node:timers/promises';

const REQUEST_TIMEOUT_MS = 60_000;
/**
 * A model call has no side effects, so a rate limit or an overloaded server is
 * retried. The Gemini free tier returns 429 and 503 often.
 */
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
export const MODEL_ATTEMPTS = 4;
const RETRY_MAX_DELAY_MS = 30_000;
/** A model still overloaded after every try is skipped for this long. */
const BUSY_PAUSE_MS = 5 * 60_000;
/** Each tool round trip is one step. A draft needs two or three. */
export const MAX_TOOL_STEPS = 8;

/** A JSON-schema subset that both providers accept: type, description, properties, required, items, enum. */
export interface ParamSchema {
  type: 'object'|'string'|'number'|'integer'|'boolean'|'array';
  description?: string;
  properties?: {[name: string]: ParamSchema};
  required?: string[];
  items?: ParamSchema;
  enum?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: ParamSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  args: {[key: string]: unknown};
}

export type ChatTurn =
  {role: 'user'; text: string}|
  /** `raw` is the provider's own content for this turn. A provider sends it back unchanged when present. */
  {role: 'assistant'; text: string; calls: ToolCall[]; raw?: unknown}|
  {role: 'tool'; results: Array<{callId: string; name: string; output: unknown}>};

export interface ModelReply {
  text: string;
  calls: ToolCall[];
  /** The provider's own content. Gemini 3 needs its thought signatures back on the next turn. */
  raw?: unknown;
}

export interface ModelProvider {
  readonly name: 'gemini'|'bedrock'|'openai-compatible';
  /** False while every model is out of quota or overloaded. The worker then uses the fill-in path before payment. */
  available(): boolean;
  reply(system: string, turns: ChatTurn[], tools: ToolSpec[]): Promise<ModelReply>;
}

/** Provider errors never include the request or response body: they can echo keys. */
export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

/**
 * The model cannot answer for a while: its daily quota is used up, or it is
 * still overloaded after every try. Another model may answer now.
 */
export class ModelBusyError extends ModelError {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
    this.name = 'ModelBusyError';
  }
}

type Json = {[key: string]: unknown};
const record = (value: unknown): Json|null =>
  (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null);

export interface ProviderOptions {
  fetch?: typeof fetch;
  /** Waits between retries. Tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Http {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

const http = (options: ProviderOptions): Http => ({fetch: options.fetch ?? fetch, sleep: options.sleep ?? ((ms) => delay(ms))});

/** Google's RetryInfo delay ("7s", "1.5s"), when the error body has one. */
function retryDelayMs(errorBody: unknown): number|null {
  const details = record(record(errorBody)?.error)?.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details.map(record)) {
    const match = typeof detail?.retryDelay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay) : null;
    if (match) return Math.ceil(Number(match[1]) * 1000);
  }
  return null;
}

async function postJson(client: Http, url: string, headers: {[key: string]: string}, body: Json, label: string): Promise<Json> {
  for (let attempt = 1; ; attempt++) {
    let response: Response|null;
    try {
      response = await client.fetch(url, {
        method: 'POST', redirect: 'error', headers: {...headers, 'content-type': 'application/json'},
        body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      response = null;
    }
    if (response?.ok) {
      const parsed = record(await response.json().catch(() => null));
      if (!parsed) throw new ModelError(`${label} returned no JSON`);
      return parsed;
    }
    const hinted = response ? retryDelayMs(await response.json().catch(() => null)) : null;
    // A daily quota asks for a wait of hours. Retrying would only spend more of the next quota.
    if (response?.status === 429 && hinted !== null && hinted > RETRY_MAX_DELAY_MS) {
      throw new ModelBusyError(`${label} quota is used up for ${Math.ceil(hinted / 60_000)} minutes`, hinted);
    }
    const problem = response ? `returned ${response.status}` : 'got no response';
    if ((response && !RETRY_STATUSES.has(response.status)) || attempt >= MODEL_ATTEMPTS) {
      const message = `${label} ${problem}${attempt > 1 ? ` after ${attempt} tries` : ''}`;
      if (!response || RETRY_STATUSES.has(response.status)) throw new ModelBusyError(message, BUSY_PAUSE_MS);
      throw new ModelError(message);
    }
    await client.sleep(Math.min(hinted ?? 2000 * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS));
  }
}

// ---------------------------------------------------------------------------
// Gemini (generativelanguage.googleapis.com, v1beta generateContent)
// ---------------------------------------------------------------------------

/** Gemini takes OpenAPI-style schemas with upper-case type names. */
function geminiSchema(schema: ParamSchema): Json {
  return {
    type: schema.type.toUpperCase(),
    ...(schema.description ? {description: schema.description} : {}),
    ...(schema.enum ? {enum: schema.enum} : {}),
    ...(schema.items ? {items: geminiSchema(schema.items)} : {}),
    ...(schema.properties ? {properties: Object.fromEntries(Object.entries(schema.properties).map(([name, value]) => [name, geminiSchema(value)]))} : {}),
    ...(schema.required?.length ? {required: schema.required} : {}),
  };
}

export class GeminiProvider implements ModelProvider {
  readonly name = 'gemini' as const;
  private readonly http: Http;
  private readonly now: () => number;
  private readonly models: string[];
  /** A model that is out of quota or overloaded is skipped until then. The free tier counts requests per model per day. */
  private readonly pausedUntil = new Map<string, number>();

  /** `models` is a list, in order of preference, as an array or comma-separated. */
  constructor(private readonly apiKey: string, models: string|string[], options: ProviderOptions = {}) {
    if (!apiKey.trim() || /\s/.test(apiKey)) throw new Error('missing or invalid Gemini API key');
    this.models = (Array.isArray(models) ? models : models.split(',')).map((model) => model.trim()).filter(Boolean);
    if (!this.models.length) throw new Error('no Gemini model is configured');
    for (const model of this.models) if (!/^[a-z0-9.-]+$/.test(model)) throw new Error(`invalid Gemini model name ${model}`);
    this.http = http(options);
    this.now = options.now ?? Date.now;
  }

  available(): boolean {
    return this.models.some((model) => (this.pausedUntil.get(model) ?? 0) <= this.now());
  }

  async reply(system: string, turns: ChatTurn[], tools: ToolSpec[]): Promise<ModelReply> {
    // A conversation stays on the model that started it: thought signatures belong to that model.
    const started = turns.map((turn) => (turn.role === 'assistant' ? record(turn.raw)?.model : null)).find((model) => typeof model === 'string');
    const choices = typeof started === 'string' ? [started] : this.models.filter((model) => (this.pausedUntil.get(model) ?? 0) <= this.now());
    let busy: ModelBusyError|null = null;
    for (const model of choices) {
      try {
        return await this.call(model, system, turns, tools);
      } catch (error) {
        if (!(error instanceof ModelBusyError)) throw error;
        this.pausedUntil.set(model, this.now() + error.retryAfterMs);
        busy = error;
      }
    }
    throw busy ?? new ModelError('every configured Gemini model is out of quota or overloaded');
  }

  private async call(model: string, system: string, turns: ChatTurn[], tools: ToolSpec[]): Promise<ModelReply> {
    const contents = turns.map((turn) => {
      if (turn.role === 'user') return {role: 'user', parts: [{text: turn.text}]};
      if (turn.role === 'assistant') {
        // Gemini 3 rejects a function call turn without its thought signature, so resend the original content.
        const raw = record(turn.raw);
        if (raw?.model === model && record(raw.content)?.role === 'model') return raw.content;
        return {role: 'model', parts: [...(turn.text ? [{text: turn.text}] : []), ...turn.calls.map((call) => ({functionCall: {name: call.name, args: call.args}}))]};
      }
      return {role: 'user', parts: turn.results.map((result) => ({
        functionResponse: {...(result.callId.startsWith('gemini:') ? {} : {id: result.callId}), name: result.name, response: {result: result.output}},
      }))};
    });
    const body = await postJson(this.http,
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {'x-goog-api-key': this.apiKey},
      {
        systemInstruction: {parts: [{text: system}]},
        contents,
        tools: tools.length ? [{functionDeclarations: tools.map((tool) => ({name: tool.name, description: tool.description, parameters: geminiSchema(tool.parameters)}))}] : [],
        generationConfig: {temperature: 0.2, maxOutputTokens: 8192},
      }, `Gemini ${model}`);
    const candidate = record(Array.isArray(body.candidates) ? body.candidates[0] : null);
    const parts = Array.isArray(record(candidate?.content)?.parts) ? (record(candidate?.content)?.parts as unknown[]) : [];
    if (!candidate) throw new ModelError('Gemini returned no candidate');
    let text = '';
    const calls: ToolCall[] = [];
    parts.map(record).forEach((part, index) => {
      if (!part) return;
      if (typeof part.text === 'string') text += part.text;
      const call = record(part.functionCall);
      // Newer models give each call an id; older ones do not.
      if (call && typeof call.name === 'string') {
        calls.push({id: typeof call.id === 'string' ? call.id : `gemini:${call.name}-${index}`, name: call.name, args: record(call.args) ?? {}});
      }
    });
    if (!text && !calls.length) throw new ModelError(`Gemini returned an empty answer (${String(candidate.finishReason ?? 'no reason')})`);
    return {text, calls, raw: {model, content: candidate.content}};
  }
}

// ---------------------------------------------------------------------------
// Bedrock (Converse API, authenticated with a Bedrock API key)
// ---------------------------------------------------------------------------

export class BedrockProvider implements ModelProvider {
  readonly name = 'bedrock' as const;
  private readonly http: Http;

  constructor(
    private readonly apiKey: string, private readonly region: string, private readonly modelId: string,
    options: ProviderOptions = {},
  ) {
    if (!apiKey.trim() || /\s/.test(apiKey)) throw new Error('missing or invalid Bedrock API key');
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new Error(`invalid AWS region ${region}`);
    if (!/^[a-zA-Z0-9.:-]+$/.test(modelId)) throw new Error(`invalid Bedrock model id ${modelId}`);
    this.http = http(options);
  }

  available(): boolean {
    return true;
  }

  async reply(system: string, turns: ChatTurn[], tools: ToolSpec[]): Promise<ModelReply> {
    const messages = turns.map((turn) => {
      if (turn.role === 'user') return {role: 'user', content: [{text: turn.text}]};
      if (turn.role === 'assistant') {
        return {role: 'assistant', content: [...(turn.text ? [{text: turn.text}] : []), ...turn.calls.map((call) => ({toolUse: {toolUseId: call.id, name: call.name, input: call.args}}))]};
      }
      return {role: 'user', content: turn.results.map((result) => ({toolResult: {toolUseId: result.callId, content: [{json: {result: result.output}}]}}))};
    });
    const body = await postJson(this.http,
      `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(this.modelId)}/converse`,
      {'authorization': `Bearer ${this.apiKey}`},
      {
        system: [{text: system}],
        messages,
        ...(tools.length ? {toolConfig: {tools: tools.map((tool) => ({toolSpec: {name: tool.name, description: tool.description, inputSchema: {json: tool.parameters}}}))}} : {}),
        inferenceConfig: {maxTokens: 8192, temperature: 0.2},
      }, 'Bedrock');
    const content = record(record(body.output)?.message)?.content;
    if (!Array.isArray(content)) throw new ModelError('Bedrock returned no message');
    let text = '';
    const calls: ToolCall[] = [];
    for (const block of content.map(record)) {
      if (!block) continue;
      if (typeof block.text === 'string') text += block.text;
      const use = record(block.toolUse);
      if (use && typeof use.name === 'string' && typeof use.toolUseId === 'string') calls.push({id: use.toolUseId, name: use.name, args: record(use.input) ?? {}});
    }
    if (!text && !calls.length) throw new ModelError('Bedrock returned an empty answer');
    return {text, calls};
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible Chat Completions (Mistral, Groq, OpenRouter, and others)
// ---------------------------------------------------------------------------

/** Tool arguments arrive as a JSON string. Bad JSON becomes no arguments, and the tool reports what is missing. */
function jsonArgs(value: unknown): {[key: string]: unknown} {
  if (typeof value !== 'string') return record(value) ?? {};
  try {
    return record(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

export interface OpenAiCompatibleOptions extends ProviderOptions {
  /** The shortest time between two requests. A free plan can allow only a few requests a minute. */
  minIntervalMs?: number;
}

/**
 * Any service with the OpenAI Chat Completions API and function tools.
 * Some have a free plan with no payment card, such as the Mistral Experiment
 * plan. `models` is tried in order, as with Gemini.
 * https://platform.openai.com/docs/api-reference/chat/create
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible' as const;
  private readonly http: Http;
  private readonly now: () => number;
  private readonly url: string;
  private readonly models: string[];
  private readonly minIntervalMs: number;
  /** A model that is out of quota or overloaded is skipped until then. */
  private readonly pausedUntil = new Map<string, number>();
  private nextRequestAt = 0;

  /** `baseUrl` is the API root, such as https://api.mistral.ai/v1. `models` is a list, as an array or comma-separated. */
  constructor(private readonly apiKey: string, baseUrl: string, models: string|string[], options: OpenAiCompatibleOptions = {}) {
    if (!apiKey.trim() || /\s/.test(apiKey)) throw new Error('missing or invalid API key for the OpenAI-compatible model');
    if (!/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(baseUrl)) throw new Error(`the OpenAI-compatible base URL must be an https URL (got ${baseUrl})`);
    this.url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.models = (Array.isArray(models) ? models : models.split(',')).map((model) => model.trim()).filter(Boolean);
    if (!this.models.length) throw new Error('no OpenAI-compatible model is configured');
    for (const model of this.models) if (!/^[a-zA-Z0-9._:/-]+$/.test(model)) throw new Error(`invalid model name ${model}`);
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 0);
    this.http = http(options);
    this.now = options.now ?? Date.now;
  }

  available(): boolean {
    return this.models.some((model) => (this.pausedUntil.get(model) ?? 0) <= this.now());
  }

  async reply(system: string, turns: ChatTurn[], tools: ToolSpec[]): Promise<ModelReply> {
    let busy: ModelBusyError|null = null;
    for (const model of this.models.filter((item) => (this.pausedUntil.get(item) ?? 0) <= this.now())) {
      try {
        return await this.call(model, system, turns, tools);
      } catch (error) {
        if (!(error instanceof ModelBusyError)) throw error;
        this.pausedUntil.set(model, this.now() + error.retryAfterMs);
        busy = error;
      }
    }
    throw busy ?? new ModelError('every configured model is out of quota or overloaded');
  }

  /** Waits until `minIntervalMs` has passed since the last request. The slot is taken before the wait. */
  private async waitForTurn(): Promise<void> {
    const start = Math.max(this.now(), this.nextRequestAt);
    this.nextRequestAt = start + this.minIntervalMs;
    if (start > this.now()) await this.http.sleep(start - this.now());
  }

  private async call(model: string, system: string, turns: ChatTurn[], tools: ToolSpec[]): Promise<ModelReply> {
    const messages: Json[] = [{role: 'system', content: system}];
    for (const turn of turns) {
      if (turn.role === 'user') {
        messages.push({role: 'user', content: turn.text});
      } else if (turn.role === 'assistant') {
        const calls = turn.calls.map((call) => ({id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.args)}}));
        messages.push({role: 'assistant', content: turn.text, ...(calls.length ? {tool_calls: calls} : {})});
      } else {
        for (const result of turn.results) messages.push({role: 'tool', tool_call_id: result.callId, content: JSON.stringify(result.output)});
      }
    }
    await this.waitForTurn();
    const body = await postJson(this.http, this.url, {'authorization': `Bearer ${this.apiKey}`}, {
      model,
      messages,
      ...(tools.length ? {tools: tools.map((tool) => ({type: 'function', function: {name: tool.name, description: tool.description, parameters: tool.parameters}}))} : {}),
      temperature: 0.2,
    }, `Model ${model}`);
    const message = record(record(Array.isArray(body.choices) ? body.choices[0] : null)?.message);
    if (!message) throw new ModelError(`Model ${model} returned no message`);
    const text = typeof message.content === 'string' ? message.content : '';
    const calls: ToolCall[] = [];
    for (const call of (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(record)) {
      const fn = record(call?.function);
      if (call && typeof call.id === 'string' && typeof fn?.name === 'string') calls.push({id: call.id, name: fn.name, args: jsonArgs(fn.arguments)});
    }
    if (!text && !calls.length) throw new ModelError(`Model ${model} returned an empty answer`);
    return {text, calls};
  }
}

// ---------------------------------------------------------------------------
// The tool loop
// ---------------------------------------------------------------------------

export interface RunnableTool extends ToolSpec {
  run(args: {[key: string]: unknown}): unknown;
}

/**
 * Runs the model until it answers without a tool call. If a model runs out of
 * quota or stays overloaded in the middle of an answer, the answer starts
 * again on the next model.
 * That is safe because every Coworker tool only reads (a draft uses a sandbox).
 *
 * `history` holds earlier chat messages as text only. They go first, so the
 * model reads the conversation before the new message.
 */
export async function runWithTools(
  provider: ModelProvider, system: string, userText: string, tools: RunnableTool[], maxSteps = MAX_TOOL_STEPS,
  history: ChatMessage[] = [],
): Promise<{text: string; toolCalls: number}> {
  for (let restart = 0; ; restart++) {
    try {
      return await converse(provider, system, userText, tools, maxSteps, history);
    } catch (error) {
      if (!(error instanceof ModelBusyError) || restart >= 2 || !provider.available()) throw error;
    }
  }
}

/** One earlier message in a chat. */
export interface ChatMessage {
  role: 'user'|'assistant';
  text: string;
}

/**
 * Earlier messages as model turns. Bedrock needs user and assistant turns to
 * alternate and to start with a user turn, so this drops a leading assistant
 * message and joins two messages in a row from the same side. The new message
 * must follow an assistant turn, so a trailing user message is returned apart.
 */
export function historyTurns(history: ChatMessage[]): {turns: ChatTurn[]; pending: string|null} {
  const merged: ChatMessage[] = [];
  for (const message of history) {
    const text = message.text.trim();
    if (!text || (!merged.length && message.role === 'assistant')) continue;
    const last = merged.at(-1);
    if (last?.role === message.role) last.text = `${last.text}\n\n${text}`;
    else merged.push({role: message.role, text});
  }
  const pending = merged.at(-1)?.role === 'user' ? (merged.pop() as ChatMessage).text : null;
  const turns = merged.map((message): ChatTurn => (message.role === 'user' ? {role: 'user', text: message.text} : {role: 'assistant', text: message.text, calls: []}));
  return {turns, pending};
}

/** One conversation on one model. Tool errors go back to the model as data. */
async function converse(
  provider: ModelProvider, system: string, userText: string, tools: RunnableTool[], maxSteps: number,
  history: ChatMessage[],
): Promise<{text: string; toolCalls: number}> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const specs: ToolSpec[] = tools.map(({name, description, parameters}) => ({name, description, parameters}));
  const earlier = historyTurns(history);
  const turns: ChatTurn[] = [...earlier.turns, {role: 'user', text: earlier.pending ? `${earlier.pending}\n\n${userText}` : userText}];
  let toolCalls = 0;
  for (let step = 0; step < maxSteps; step++) {
    const reply = await provider.reply(system, turns, specs);
    if (!reply.calls.length) {
      if (!reply.text.trim()) throw new ModelError('the model returned no answer');
      return {text: reply.text.trim(), toolCalls};
    }
    turns.push({role: 'assistant', text: reply.text, calls: reply.calls, raw: reply.raw});
    turns.push({
      role: 'tool',
      results: reply.calls.map((call) => {
        toolCalls++;
        const tool = byName.get(call.name);
        if (!tool) return {callId: call.id, name: call.name, output: {ok: false, error: {code: 'unknown_tool', message: `no tool named ${call.name}`}}};
        try {
          return {callId: call.id, name: call.name, output: tool.run(call.args)};
        } catch (error) {
          return {callId: call.id, name: call.name, output: {ok: false, error: {code: 'tool_failed', message: error instanceof Error ? error.message : String(error)}}};
        }
      }),
    });
  }
  throw new ModelError(`the model did not finish within ${maxSteps} tool steps`);
}
