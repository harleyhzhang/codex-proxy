// Grok through xAI's Responses endpoint, signed in with the Grok Build login (its auth.json in GROK_HOME,
// refreshed here). Codex's tools become function tools, so Grok makes real tool calls; requests and
// replies are the Responses format Codex already speaks, translated only where names and item types differ.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { positiveInt } from '../env';
import { isRecord, type JsonRecord } from '../json';
import { logSafe } from '../log';
import { codexToolCall, functionTools, HISTORY_CALL_TYPES, HISTORY_OUTPUT_TYPES, historyCallArguments, historyToolName, keyLookup } from '../protocol/native-tools';
import { imageUrl, isImagePart, requestTools, toolDescriptors, type ToolDescriptor } from '../protocol/prompt';
import { sseEvents } from '../protocol/stream';
import type { ProxyOutput, ResponsesRequest, StreamEvent, OutputSink, ToolCall } from '../protocol/types';
import { abortable, ProxyTransportError, sleep } from '../transport';
import { BackendError, CONTEXT_OVERFLOW_TEXT, contextOverflowError, estimateVisibleTokens, OVERLOADED_TEXT, overloadedError, retryOnce, type SubscriptionBackend } from './contract';

const MODEL = 'grok-4.7';
const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
/** Grok Build's public OAuth client; the login in auth.json was issued to it. */
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const REFRESH_LEAD_MS = 5 * 60_000;
/** Native Codex retries a 5xx four times with a doubling 200 ms backoff. */
const SERVER_RETRIES = 4;

type GrokOptions = {
  /** The Grok Build home holding auth.json. */
  home: string;
  baseUrl?: string;
  issuer?: string;
  /** Where the current Grok Build version is looked up after the server rejects ours as too old. */
  versionUrl?: string;
};

class GrokError extends BackendError {
  constructor(message: string, retryable = false) {
    super(message, { retryable });
    this.name = 'GrokError';
  }
}

const signedOut = (home: string) =>
  new GrokError(`Grok is signed out: its login expired or was rejected. Sign in again with \`GROK_HOME=${JSON.stringify(home)} grok login\`; no automatic fallback`);

/**
 * The Grok Build login. The access token lasts six hours and every refresh rotates the refresh token,
 * so the router is the only thing that refreshes it: concurrent turns share one refresh and the new
 * tokens are written back atomically (other fields untouched), where `grok login` also writes.
 */
class GrokLogin {
  private refreshing?: Promise<string>;
  private tokenEndpoint?: string;
  constructor(private readonly home: string, private readonly issuer: string) {}

  private read(): { file: JsonRecord; entry: JsonRecord } {
    let file: unknown;
    try { file = JSON.parse(readFileSync(join(this.home, 'auth.json'), 'utf8')); } catch { throw signedOut(this.home); }
    const slot = isRecord(file) ? Object.keys(file).find(key => key.startsWith(`${this.issuer}::`)) : undefined;
    const entry = isRecord(file) && slot && isRecord(file[slot]) ? file[slot] : undefined;
    if (!isRecord(file) || !entry || typeof entry.key !== 'string' || typeof entry.refresh_token !== 'string') throw signedOut(this.home);
    return { file, entry };
  }

  /** A token valid for at least the refresh lead. `stale` forces a refresh unless it was already replaced. */
  async token(signal?: AbortSignal, stale?: string): Promise<string> {
    const { entry } = this.read();
    const key = entry.key as string;
    if (key !== stale && Date.parse(String(entry.expires_at)) - Date.now() > REFRESH_LEAD_MS) return key;
    // Shared and not tied to one turn's signal: a cancelled turn must not abandon a rotation mid-flight.
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined; });
    return abortable(this.refreshing, signal);
  }

  private async refresh(): Promise<string> {
    const started = performance.now();
    const { file, entry } = this.read();
    this.tokenEndpoint ??= await this.discover();
    const response = await fetch(this.tokenEndpoint, {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: entry.refresh_token as string }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    const token = isRecord(body) && typeof body.access_token === 'string' ? body.access_token : undefined;
    if (!response.ok || !token || !isRecord(body)) {
      logSafe('grok-refresh-failed', { status: response.status, error: isRecord(body) ? String(body.error ?? '') : '' });
      if (response.status >= 500) throw new GrokError(`Grok login refresh failed (xAI HTTP ${response.status}); retry the turn`);
      throw signedOut(this.home);
    }
    entry.key = token;
    if (typeof body.refresh_token === 'string') entry.refresh_token = body.refresh_token;
    entry.expires_at = new Date(Date.now() + (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000).toISOString();
    const path = join(this.home, 'auth.json');
    writeFileSync(`${path}.tmp-router`, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp-router`, path);
    logSafe('grok-login-refreshed', { ms: Math.round(performance.now() - started), expires_in: typeof body.expires_in === 'number' ? body.expires_in : 0 });
    return token;
  }

  private async discover(): Promise<string> {
    const response = await fetch(`${this.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(30_000) });
    const body: unknown = await response.json().catch(() => undefined);
    const endpoint = isRecord(body) && typeof body.token_endpoint === 'string' ? body.token_endpoint : '';
    if (!response.ok || !endpoint.startsWith(`${new URL(this.issuer).origin}/`)) throw new GrokError(`Grok login discovery failed (HTTP ${response.status}); retry the turn`);
    return endpoint;
  }
}

/**
 * Grok's encrypted reasoning for the calls it made, put back in front of those calls when the history
 * returns, so a tool loop keeps its train of thought. Codex never sees it, and other models never get it.
 */
class ReasoningReplay {
  private readonly byCall = new Map<string, unknown[]>();
  remember(callId: string, items: unknown[]): void {
    this.byCall.delete(callId);
    this.byCall.set(callId, items);
    while (this.byCall.size > 512) this.byCall.delete(this.byCall.keys().next().value!);
  }
  before(callId: string | undefined): unknown[] { return (callId && this.byCall.get(callId)) || []; }
}

const TEXT_PARTS = new Set(['input_text', 'output_text', 'text']);

/** An image part xAI can read (inline data or a web URL); anything else becomes a short note. */
function imagePart(value: JsonRecord, legacy: boolean): JsonRecord {
  const url = imageUrl(value, legacy);
  return url && /^(data:image\/|https:\/\/)/.test(url) ? { type: 'input_image', image_url: url } : { type: 'input_text', text: '[image omitted: only inline or web images can be shown]' };
}

/** Message or tool-output content as xAI parts: text and images keep their kind, anything else is JSON text. */
function parts(value: unknown, textType: 'input_text' | 'output_text', legacy = false): JsonRecord[] {
  if (typeof value === 'string') return value ? [{ type: textType, text: value }] : [];
  if (Array.isArray(value)) return value.flatMap(part => parts(part, textType, legacy));
  if (!isRecord(value)) return value === undefined || value === null ? [] : [{ type: textType, text: JSON.stringify(value) }];
  if (isImagePart(value, legacy)) return [imagePart(value, legacy)];
  if (TEXT_PARTS.has(String(value.type)) && typeof value.text === 'string') return value.text ? [{ type: textType, text: value.text }] : [];
  if (value.type === 'encrypted_content') return [{ type: textType, text: '[encrypted content from a GPT agent; unreadable here]' }];
  return [{ type: textType, text: JSON.stringify(value) }];
}

/** Codex's history as xAI input items. Calls use the flattened tool names the request declares. */
function grokInput(request: ResponsesRequest, keyFor: (name: string) => string, replay?: ReasoningReplay): unknown[] {
  if (typeof request.input === 'string') return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: request.input }] }];
  const input: unknown[] = [];
  for (const item of request.input) {
    const type = item.type ?? 'message';
    if (HISTORY_CALL_TYPES.has(type)) {
      input.push(...(replay?.before(item.call_id) ?? []));
      input.push({ type: 'function_call', call_id: item.call_id, name: keyFor(historyToolName(item)), arguments: historyCallArguments(item) });
    } else if (HISTORY_OUTPUT_TYPES.has(type)) {
      const output = type === 'tool_search_output' ? [{ type: 'input_text', text: JSON.stringify(item.tools ?? []) }] : parts(item.output, 'input_text', type === 'computer_call_output');
      // Plain text stays a string; text with images stays a part list, which xAI shows the model as an image.
      input.push({ type: 'function_call_output', call_id: item.call_id, output: output.every(part => part.type === 'input_text') ? output.map(part => part.text).join('\n') : output });
    } else if (type === 'agent_message') {
      const text = parts(item.content, 'input_text').map(part => part.text ?? '').join('\n');
      input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `<agent_message author=${JSON.stringify(item.author ?? 'unknown')} recipient=${JSON.stringify(item.recipient ?? 'unknown')}>\n${text}\n</agent_message>` }] });
    } else if (type === 'message') {
      const role = item.role === 'assistant' || item.role === 'developer' || item.role === 'system' ? item.role : 'user';
      const content = parts(item.content, role === 'assistant' ? 'output_text' : 'input_text');
      if (content.length) input.push({ type: 'message', role, content });
    } else if (type !== 'reasoning' && !item.encrypted_content) {
      // Reasoning and other encrypted items belong to another provider; anything else readable stays as text.
      input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: JSON.stringify(item) }] });
    }
  }
  return input;
}

function toolChoice(choice: unknown, keyFor: (name: string) => string): unknown {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (isRecord(choice) && typeof choice.name === 'string') return { type: 'function', name: keyFor(choice.namespace ? `${String(choice.namespace)}.${choice.name}` : choice.name) };
  return undefined;
}

type Prepared = { body: JsonRecord; byKey: Map<string, ToolDescriptor> };

function grokRequest(request: ResponsesRequest, replay?: ReasoningReplay): Prepared {
  const { definitions, byKey } = functionTools(toolDescriptors(requestTools(request)));
  const keyFor = keyLookup(byKey);
  const tools = Object.entries(definitions).map(([name, tool]) => ({ type: 'function', name, description: tool.description, parameters: tool.inputSchema }));
  const extra = request as ResponsesRequest & JsonRecord;
  return {
    byKey,
    body: {
      model: MODEL,
      instructions: request.instructions,
      input: grokInput(request, keyFor, replay),
      ...(tools.length ? { tools, tool_choice: toolChoice(request.tool_choice, keyFor), parallel_tool_calls: true } : {}),
      // `summary` makes xAI stream a readable summary of Grok's thinking, which Codex shows as it thinks.
      reasoning: { effort: request.reasoning?.effort ?? 'high', summary: 'auto' },
      max_output_tokens: request.max_output_tokens,
      // Codex's per-thread key; xAI caches the shared prefix under it.
      prompt_cache_key: typeof extra.prompt_cache_key === 'string' ? extra.prompt_cache_key : undefined,
      stream: true,
      store: false,
    },
  };
}

/** xAI's reply as Codex output: text, and calls named and shaped as the Codex tools they stand for. */
function grokOutput(output: unknown[], byKey: Map<string, ToolDescriptor>): { text: string; toolCalls: ToolCall[]; reasoning: unknown[] } {
  let text = '';
  const toolCalls: ToolCall[] = [];
  const reasoning: unknown[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === 'reasoning') reasoning.push(item);
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) if (isRecord(part) && typeof part.text === 'string') text += part.text;
    }
    if (item.type !== 'function_call' || typeof item.name !== 'string') continue;
    toolCalls.push(codexToolCall(byKey, item.name, typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}), typeof item.call_id === 'string' ? item.call_id : undefined));
  }
  return { text, toolCalls, reasoning };
}

/** xAI's own error text, short; it never contains the request. */
async function errorDetail(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const detail = isRecord(body) ? body.error ?? body.message : undefined;
  return (typeof detail === 'string' ? detail : isRecord(detail) && typeof detail.message === 'string' ? detail.message : '').replace(/\s+/g, ' ').slice(0, 300);
}

function refusal(status: number, detail: string, home: string): BackendError {
  if (CONTEXT_OVERFLOW_TEXT.test(detail) || /input_too_large/.test(detail)) return contextOverflowError('Grok');
  if (status === 401 || status === 403) return signedOut(home);
  if (status === 503 || status === 529 || OVERLOADED_TEXT.test(detail)) return overloadedError('Grok');
  if (status === 429) return new GrokError(`Grok usage limit reached${detail ? `: ${detail}` : ''}; no automatic fallback`);
  return new GrokError(`Grok request refused (xAI HTTP ${status}${detail ? `: ${detail}` : ''})`);
}

export function createGrokBackend(options: GrokOptions): SubscriptionBackend {
  const baseUrl = options.baseUrl ?? 'https://cli-chat-proxy.grok.com/v1';
  const login = new GrokLogin(options.home, options.issuer ?? 'https://auth.x.ai');
  const replay = new ReasoningReplay();
  // The chat proxy accepts only current Grok Build clients (HTTP 426 otherwise).
  let clientVersion = '1.0.46';

  const headers = (token: string) => ({
    authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream',
    'user-agent': `xai-grok-workspace/${clientVersion}`, 'x-grok-client-version': clientVersion,
    'x-xai-token-auth': 'xai-grok-cli', 'x-grok-client-identifier': 'grok-shell', 'x-authenticateresponse': 'authenticate-response',
  });

  async function currentVersion(): Promise<boolean> {
    try {
      const body: unknown = await (await fetch(options.versionUrl ?? 'https://registry.npmjs.org/@xai-official/grok/latest', { signal: AbortSignal.timeout(10_000) })).json();
      if (isRecord(body) && typeof body.version === 'string' && /^\d+\.\d+\.\d+$/.test(body.version) && body.version !== clientVersion) {
        logSafe('grok-client-version', { version: body.version });
        clientVersion = body.version;
        return true;
      }
    } catch {}
    return false;
  }

  /** Opens the stream. Nothing has reached Codex yet, so each retry here is safe. */
  async function open(body: string, signal: AbortSignal): Promise<Response> {
    let token = await login.token(signal);
    let refreshed = false, upgraded = false;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${baseUrl}/responses`, { method: 'POST', headers: headers(token), body, signal });
      if (response.ok) return response;
      const detail = await errorDetail(response);
      logSafe('grok-http-refused', { status: response.status, attempt });
      if (response.status === 401 && !refreshed) { refreshed = true; token = await login.token(signal, token); continue; }
      if (response.status === 426 && !upgraded) { upgraded = true; if (await currentVersion()) continue; }
      if (response.status >= 500 && response.status !== 503 && attempt < SERVER_RETRIES) { await sleep(200 * 2 ** attempt, signal); continue; }
      throw refusal(response.status, detail, options.home);
    }
  }

  async function run(request: ResponsesRequest, signal?: AbortSignal, sink?: OutputSink): Promise<ProxyOutput> {
    signal?.throwIfAborted();
    if (request.model !== MODEL) throw new GrokError('Unsupported Grok model');
    if (!(EFFORTS as readonly string[]).includes(request.reasoning?.effort ?? 'high')) throw new GrokError('Unsupported Grok reasoning effort');
    const started = performance.now();
    const { body, byKey } = grokRequest(request, replay);
    // Bound silence, like native Codex's stream idle timeout; every chunk restarts the window.
    const idleMs = positiveInt('GROK_TIMEOUT_MS', 300_000);
    const idle = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new DOMException('Grok stream idle', 'TimeoutError')), idleMs); };
    const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    touch();
    let firstEventMs = 0, completed: JsonRecord | undefined, failed: StreamEvent | undefined;
    try {
      const response = await open(JSON.stringify(body), combined);
      if (!response.body) throw new ProxyTransportError();
      const watched = new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { touch(); controller.enqueue(chunk); } })));
      await sseEvents(watched, event => {
        firstEventMs ||= performance.now() - started;
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') sink?.text(event.delta);
        if (event.type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') sink?.reasoning?.(event.delta);
        // A finished call goes to Codex now, so it starts running while Grok writes the next one.
        if (event.type === 'response.output_item.done' && isRecord(event.item) && event.item.type === 'function_call') {
          const call = grokOutput([event.item], byKey).toolCalls[0];
          if (call) sink?.call?.(call);
        }
        if ((event.type === 'response.completed' || event.type === 'response.incomplete') && isRecord(event.response)) completed = event.response;
        if (event.type === 'response.failed' || event.type === 'error') failed = event;
      });
    } finally { clearTimeout(timer); }
    if (failed) {
      const error = isRecord(failed.error) ? failed.error : isRecord(failed.response) && isRecord(failed.response.error) ? failed.response.error : {};
      const detail = String(error.message ?? '').slice(0, 300);
      if (CONTEXT_OVERFLOW_TEXT.test(detail)) throw contextOverflowError('Grok');
      // A provider failure after the stream opened: nothing reached Codex, so one fresh attempt is safe.
      throw new GrokError(`Grok stream failed${detail ? `: ${detail}` : ''}`, true);
    }
    // A stream that ended without a terminal event dropped: the router's offline policy retries it.
    if (!completed) throw new ProxyTransportError();
    const { text, toolCalls, reasoning } = grokOutput(Array.isArray(completed.output) ? completed.output : [], byKey);
    if (reasoning.length && toolCalls[0]?.callId) replay.remember(toolCalls[0].callId, reasoning);
    const usage = isRecord(completed.usage) ? completed.usage : {};
    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : estimateVisibleTokens(JSON.stringify(body.input));
    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : estimateVisibleTokens(text + JSON.stringify(toolCalls));
    const cached = isRecord(usage.input_tokens_details) && typeof usage.input_tokens_details.cached_tokens === 'number' ? usage.input_tokens_details.cached_tokens : 0;
    logSafe('grok-turn', { ms: Math.round(performance.now() - started), first_event_ms: Math.round(firstEventMs), calls: toolCalls.length, input_tokens: inputTokens, cached_tokens: cached, status: String(completed.status ?? '') });
    return { text, toolCalls, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
  }

  return {
    name: 'Grok',
    models: { [MODEL]: MODEL },
    reservedPrefix: 'grok-',
    catalog: [{
      slug: MODEL, displayName: 'Grok 4.7', description: 'Grok 4.7 through your SuperGrok subscription',
      efforts: EFFORTS, defaultEffort: 'high', inputModalities: ['text', 'image'], contextWindow: 500_000,
    }],
    run: (request, signal, sink) => retryOnce('Grok', signal, () => run(request, signal, sink), sink),
    // A chat opening refreshes the login ahead of its first turn.
    prewarm: () => { void login.token().catch(() => {}); },
  };
}

export const grokBackend = createGrokBackend({ home: process.env.GROK_HOME ?? join(homedir(), '.grok') });
