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
  readonly name: 'gemini'|'bedrock';
  reply(system: string, turns: ChatTurn[], tools: ToolSpec[]): Promise<ModelReply>;
}

/** Provider errors never include the request or response body: they can echo keys. */
export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

type Json = {[key: string]: unknown};
const record = (value: unknown): Json|null =>
  (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null);

export interface ProviderOptions {
  fetch?: typeof fetch;
  /** Waits between retries. Tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
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
    const problem = response ? `returned ${response.status}` : 'got no response';
    if ((response && !RETRY_STATUSES.has(response.status)) || attempt >= MODEL_ATTEMPTS) {
      throw new ModelError(`${label} ${problem}${attempt > 1 ? ` after ${attempt} tries` : ''}`);
    }
    const hinted = response ? retryDelayMs(await response.json().catch(() => null)) : null;
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

  constructor(private readonly apiKey: string, private readonly model: string, options: ProviderOptions = {}) {
    if (!apiKey.trim() || /\s/.test(apiKey)) throw new Error('missing or invalid Gemini API key');
    if (!/^[a-z0-9.-]+$/.test(model)) throw new Error(`invalid Gemini model name ${model}`);
    this.http = http(options);
  }

  async reply(system: string, turns: ChatTurn[], tools: ToolSpec[]): Promise<ModelReply> {
    const contents = turns.map((turn) => {
      if (turn.role === 'user') return {role: 'user', parts: [{text: turn.text}]};
      if (turn.role === 'assistant') {
        // Gemini 3 rejects a function call turn without its thought signature, so resend the original content.
        if (record(turn.raw)?.role === 'model') return turn.raw;
        return {role: 'model', parts: [...(turn.text ? [{text: turn.text}] : []), ...turn.calls.map((call) => ({functionCall: {name: call.name, args: call.args}}))]};
      }
      return {role: 'user', parts: turn.results.map((result) => ({
        functionResponse: {...(result.callId.startsWith('gemini:') ? {} : {id: result.callId}), name: result.name, response: {result: result.output}},
      }))};
    });
    const body = await postJson(this.http,
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
      {'x-goog-api-key': this.apiKey},
      {
        systemInstruction: {parts: [{text: system}]},
        contents,
        tools: tools.length ? [{functionDeclarations: tools.map((tool) => ({name: tool.name, description: tool.description, parameters: geminiSchema(tool.parameters)}))}] : [],
        generationConfig: {temperature: 0.2, maxOutputTokens: 8192},
      }, 'Gemini');
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
    return {text, calls, raw: candidate.content};
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
// The tool loop
// ---------------------------------------------------------------------------

export interface RunnableTool extends ToolSpec {
  run(args: {[key: string]: unknown}): unknown;
}

/** Runs the model until it answers without a tool call. Tool errors go back to the model as data. */
export async function runWithTools(
  provider: ModelProvider, system: string, userText: string, tools: RunnableTool[], maxSteps = MAX_TOOL_STEPS,
): Promise<{text: string; toolCalls: number}> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const specs: ToolSpec[] = tools.map(({name, description, parameters}) => ({name, description, parameters}));
  const turns: ChatTurn[] = [{role: 'user', text: userText}];
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
