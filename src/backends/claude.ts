// Claude through Anthropic's Messages API, signed in with the Claude Code login of a config directory
// (its macOS keychain item, or `.credentials.json`), refreshed here. Codex's tools become Claude tools,
// so Claude makes real tool calls, and its text streams to Codex as it is written.
import { readFileSync, renameSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { positiveInt } from '../env';
import { isRecord, sha256, type JsonRecord } from '../json';
import { logSafe } from '../log';
import { codexToolCall, functionTools, HISTORY_CALL_TYPES, HISTORY_OUTPUT_TYPES, historyCallArguments, historyToolName, keyLookup, rawInputTools } from '../protocol/native-tools';
import { imageUrl, isImagePart, requestTools, toolDescriptors, type ToolDescriptor } from '../protocol/prompt';
import { sseEvents } from '../protocol/stream';
import type { ProxyOutput, ResponsesRequest, TextSink, ToolCall } from '../protocol/types';
import { abortable, ProxyTransportError, sleep } from '../transport';
import { claudeLimits, ClaudeUsageLimitError, ClaudeUsageLimits, rateLimitInfo } from './claude-limits';
import { BackendError, CONTEXT_OVERFLOW_TEXT, contextOverflowError, OVERLOADED_TEXT, overloadedError, retryOnce, type SubscriptionBackend } from './contract';

const MODEL_ALIASES: Readonly<Record<string, string>> = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Claude Code's public OAuth client and its request identity; subscription logins accept only these. */
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLIENT_VERSION = '2.1.286';
const BETAS = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,effort-2025-11-24';
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const REFRESH_LEAD_MS = 5 * 60_000;
/** Native Codex retries a 5xx four times with a doubling 200 ms backoff. */
const SERVER_RETRIES = 4;
const MAX_OUTPUT_TOKENS = 128_000;

export class ClaudeError extends BackendError {
  constructor(message: string, retryable = false) {
    super(message, { retryable });
    this.name = 'ClaudeError';
  }
}

/** The router has already mapped public slugs and aliases to Anthropic's model ids. */
export function resolveModel(model: string): string {
  if (!/^claude-[a-z0-9.-]+$/.test(model)) throw new ClaudeError(`Unsupported Claude model: ${model}`);
  return model;
}

function resolveEffort(request: ResponsesRequest): string {
  const effort = request.reasoning?.effort ?? 'high';
  if (!(EFFORTS as readonly string[]).includes(effort)) throw new ClaudeError(`Unsupported Claude reasoning effort: ${effort}`);
  return effort;
}

type LoginStore = { read(): Promise<JsonRecord | undefined>; write(value: JsonRecord): Promise<void> };

/** The keychain item Claude Code keeps for a config directory: a hashed suffix for any non-default one. */
function keychainStore(configDir: string | undefined): LoginStore {
  const service = configDir ? `Claude Code-credentials-${sha256(configDir).slice(0, 8)}` : 'Claude Code-credentials';
  const account = process.env.USER || userInfo().username;
  return {
    async read() {
      const child = Bun.spawn(['security', 'find-generic-password', '-s', service, '-a', account, '-w'], { stdout: 'pipe', stderr: 'ignore' });
      const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      try { const value: unknown = code === 0 ? JSON.parse(text) : undefined; return isRecord(value) ? value : undefined; } catch { return undefined; }
    },
    // Written as Claude Code writes it: through `security -i` with a hex value, so it never appears in argv.
    async write(value) {
      const child = Bun.spawn(['security', '-i'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
      child.stdin.write(`add-generic-password -U -a "${account}" -s "${service}" -X "${Buffer.from(JSON.stringify(value)).toString('hex')}"\n`);
      await child.stdin.end();
      if (await child.exited !== 0) throw new ClaudeError('Could not save the refreshed Claude login to the keychain; retry the turn', true);
    },
  };
}

function fileStore(path: string): LoginStore {
  return {
    async read() {
      try { const value: unknown = JSON.parse(readFileSync(path, 'utf8')); return isRecord(value) ? value : undefined; } catch { return undefined; }
    },
    async write(value) {
      writeFileSync(`${path}.tmp-router`, JSON.stringify(value), { mode: 0o600 });
      renameSync(`${path}.tmp-router`, path);
    },
  };
}

export type ClaudeAccountOptions = {
  /** The Claude Code config directory whose login this account uses; unset means the default profile. */
  configDir?: string;
  expectedEmail?: string;
  expectedOrg?: string;
  /** Overrides for tests; production uses Anthropic, its token endpoint and the profile's own store. */
  apiUrl?: string;
  tokenUrl?: string;
  credentialsFile?: string;
};

/**
 * Claude's thinking for the calls it made, put back in front of those calls when the history returns,
 * so a tool loop keeps its train of thought. Anthropic accepts the history without it (another model's
 * calls, or after a restart), so a miss only costs continuity.
 */
class ThinkingReplay {
  private readonly byCall = new Map<string, JsonRecord[]>();
  remember(callId: string, blocks: JsonRecord[]): void {
    this.byCall.delete(callId);
    this.byCall.set(callId, blocks);
    while (this.byCall.size > 512) this.byCall.delete(this.byCall.keys().next().value!);
  }
  get(callId: unknown): JsonRecord[] | undefined { return typeof callId === 'string' ? this.byCall.get(callId) : undefined; }
}

const TEXT_PARTS = new Set(['input_text', 'output_text', 'text']);
const text = (value: string): JsonRecord[] => (value ? [{ type: 'text', text: value }] : []);
const toolId = (id: unknown) => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'call';

function imageBlock(value: JsonRecord, legacy: boolean): JsonRecord[] {
  const url = imageUrl(value, legacy) ?? '';
  const inline = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/s.exec(url);
  if (inline) return [{ type: 'image', source: { type: 'base64', media_type: inline[1], data: inline[2]!.replace(/\s/g, '') } }];
  if (url.startsWith('https://')) return [{ type: 'image', source: { type: 'url', url } }];
  return text('[image omitted: only inline PNG/JPEG/GIF/WebP or web images can be shown]');
}

/** Message or tool-output content as Claude blocks: text and images keep their kind, anything else is JSON text. */
function blocks(value: unknown, legacy = false): JsonRecord[] {
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.flatMap(part => blocks(part, legacy));
  if (!isRecord(value)) return value === undefined || value === null ? [] : text(JSON.stringify(value));
  if (isImagePart(value, legacy)) return imageBlock(value, legacy);
  if (TEXT_PARTS.has(String(value.type)) && typeof value.text === 'string') return text(value.text);
  if (value.type === 'encrypted_content') return text('[encrypted content from a GPT agent; unreadable here]');
  return text(JSON.stringify(value));
}

type Turn = { role: 'user' | 'assistant'; content: JsonRecord[] };

/**
 * Codex's history as Claude turns. Calls and results keep their structure; a call with no result gets
 * one saying it did not finish, and a result with no call becomes text, since Anthropic requires every
 * tool_use to be answered in the next user turn and every tool_result to answer one.
 */
export function claudeMessages(request: ResponsesRequest, keyFor: (name: string) => string, replay?: ThinkingReplay): Turn[] {
  const turns: Turn[] = [];
  const add = (role: Turn['role'], content: JsonRecord[]) => {
    if (!content.length) return;
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...content);
    else turns.push({ role, content: [...content] });
  };
  for (const item of typeof request.input === 'string' ? [{ role: 'user', content: request.input }] : request.input) {
    const type = item.type ?? 'message';
    if (HISTORY_CALL_TYPES.has(type)) {
      let input: unknown;
      try { input = JSON.parse(historyCallArguments(item)); } catch { input = {}; }
      add('assistant', [{ type: 'tool_use', id: toolId(item.call_id), name: keyFor(historyToolName(item)), input: isRecord(input) ? input : { value: input } }]);
    } else if (HISTORY_OUTPUT_TYPES.has(type)) {
      const content = type === 'tool_search_output' ? text(JSON.stringify(item.tools ?? [])) : blocks(item.output, type === 'computer_call_output');
      add('user', [{ type: 'tool_result', tool_use_id: toolId(item.call_id), content: content.length ? content : text('(no output)') }]);
    } else if (type === 'agent_message') {
      const body = blocks(item.content).map(block => block.text ?? '').join('\n');
      add('user', text(`<agent_message author=${JSON.stringify(item.author ?? 'unknown')} recipient=${JSON.stringify(item.recipient ?? 'unknown')}>\n${body}\n</agent_message>`));
    } else if (type === 'message') {
      if (item.role === 'assistant') add('assistant', blocks(item.content).filter(block => block.type === 'text'));
      else if (item.role === 'developer' || item.role === 'system') {
        const body = blocks(item.content).map(block => block.text ?? '').join('\n');
        add('user', text(body && `<${item.role}>\n${body}\n</${item.role}>`));
      } else add('user', blocks(item.content));
    } else if (type !== 'reasoning' && !item.encrypted_content) {
      // Reasoning and other encrypted items belong to another provider; anything else readable stays as text.
      add('user', text(JSON.stringify(item)));
    }
  }

  // Every call is answered in the turn right after it.
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index]!;
    if (turn.role !== 'assistant') continue;
    const calls = turn.content.filter(block => block.type === 'tool_use').map(block => block.id);
    if (!calls.length) continue;
    if (turns[index + 1]?.role !== 'user') turns.splice(index + 1, 0, { role: 'user', content: [] });
    const next = turns[index + 1]!;
    const answered = new Set(next.content.filter(block => block.type === 'tool_result').map(block => block.tool_use_id));
    for (const id of calls) if (!answered.has(id)) next.content.push({ type: 'tool_result', tool_use_id: id, content: text('(no result: this call did not finish)') });
    const thinking = calls.map(id => replay?.get(id)).find(Boolean);
    if (thinking) turn.content.unshift(...thinking);
  }
  // Results lead their turn, answer only the previous turn's calls, and answer each call once.
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index]!;
    if (turn.role !== 'user') continue;
    const previous = turns[index - 1];
    const open = new Set(previous?.role === 'assistant' ? previous.content.filter(block => block.type === 'tool_use').map(block => block.id) : []);
    const results: JsonRecord[] = [], rest: JsonRecord[] = [];
    for (const block of turn.content) {
      if (block.type !== 'tool_result') rest.push(block);
      else if (open.delete(block.tool_use_id)) results.push(block);
      else rest.push(...text(`<tool_result call_id=${JSON.stringify(block.tool_use_id)}>`), ...(block.content as JsonRecord[]), ...text('</tool_result>'));
    }
    turn.content = [...results, ...rest];
  }
  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: text('(earlier conversation)') });
  if (!turns.length || turns.at(-1)!.role === 'assistant') turns.push({ role: 'user', content: text('Continue.') });
  return turns;
}

function toolChoice(choice: unknown, keyFor: (name: string) => string): JsonRecord | undefined {
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  if (isRecord(choice) && typeof choice.name === 'string') return { type: 'tool', name: keyFor(choice.namespace ? `${String(choice.namespace)}.${choice.name}` : choice.name) };
  return undefined;
}

const cached = (block: JsonRecord | undefined) => { if (block && block.type !== 'thinking' && block.type !== 'redacted_thinking') block.cache_control = { type: 'ephemeral' }; };

export function claudeRequest(request: ResponsesRequest, replay?: ThinkingReplay): { body: JsonRecord; byKey: Map<string, ToolDescriptor> } {
  const { definitions, byKey } = functionTools(toolDescriptors(requestTools(request)));
  const keyFor = keyLookup(byKey);
  const tools: JsonRecord[] = Object.entries(definitions).map(([name, tool]) => ({ name, description: tool.description, input_schema: tool.inputSchema }));
  const raw = rawInputTools(byKey);
  const note = `You are running inside a Codex agent loop. The provided tools are Codex's tools: Codex executes each call on the user's machine and returns its result. Call them directly.${raw.length ? ` ${raw.join(', ')} ${raw.length === 1 ? 'takes' : 'take'} the whole raw input as the string field "input".` : ''}`;
  const system: JsonRecord[] = [{ type: 'text', text: IDENTITY }, { type: 'text', text: request.instructions ? `${note}\n\n${request.instructions}` : note }];
  const messages = claudeMessages(request, keyFor, replay);
  // Cache breakpoints at the end of the tools, the system prompt and the newest turn: each turn reads the
  // conversation the previous one wrote.
  cached(tools.at(-1)); cached(system.at(-1)); cached(messages.at(-1)?.content.at(-1));
  const choice = tools.length ? toolChoice(request.tool_choice, keyFor) : undefined;
  return {
    byKey,
    body: {
      model: resolveModel(request.model),
      max_tokens: request.max_output_tokens ?? MAX_OUTPUT_TOKENS,
      stream: true,
      system,
      messages,
      ...(tools.length ? { tools } : {}),
      ...(choice ? { tool_choice: choice } : {}),
      // Anthropic refuses thinking when the tool choice forces a call.
      ...(choice?.type === 'any' || choice?.type === 'tool' ? {} : { thinking: { type: 'adaptive' } }),
      output_config: { effort: resolveEffort(request) },
    },
  };
}

const signedOut = (configDir: string | undefined) =>
  new ClaudeError(`Claude account is not logged in for this configuration, or its credential store is inaccessible; sign in again with \`${configDir ? `CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)} ` : ''}claude auth login\``);

/** Anthropic's own error text, short; it never contains the request. */
async function errorDetail(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const error = isRecord(body) && isRecord(body.error) ? body.error : body;
  return (isRecord(error) && typeof error.message === 'string' ? error.message : '').replace(/\s+/g, ' ').slice(0, 300);
}

/** Each login owns its token, identity check, thinking replay, quota snapshot and usage sink. */
export class ClaudeAccount {
  rateLimitSink?: (info: unknown) => void;
  readonly options: Readonly<ClaudeAccountOptions>;
  private readonly store: LoginStore;
  private readonly replay = new ThinkingReplay();
  private refreshing?: Promise<string>;
  private verified?: { token: string; check: Promise<void> };

  constructor(options: ClaudeAccountOptions = {}, readonly limits = new ClaudeUsageLimits()) {
    this.options = Object.freeze({ ...options });
    const configDir = options.configDir;
    this.store = options.credentialsFile ? fileStore(options.credentialsFile)
      : process.platform === 'darwin' ? keychainStore(configDir)
      : fileStore(join(configDir ?? join(homedir(), '.claude'), '.credentials.json'));
  }
  onRateLimit(sink: (info: unknown) => void): void { this.rateLimitSink = sink; }
  private get api(): string { return this.options.apiUrl ?? 'https://api.anthropic.com'; }

  private headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': BETAS,
      'user-agent': `claude-cli/${CLIENT_VERSION} (external, sdk-cli)`, 'x-app': 'cli', ...extra,
    };
  }

  private async login(): Promise<{ all: JsonRecord; oauth: JsonRecord }> {
    const all = await this.store.read();
    const oauth = all && isRecord(all.claudeAiOauth) ? all.claudeAiOauth : undefined;
    if (!all || !oauth || typeof oauth.accessToken !== 'string' || typeof oauth.refreshToken !== 'string') throw signedOut(this.options.configDir);
    return { all, oauth };
  }

  /**
   * A token valid for at least the refresh lead. Refreshing rotates the refresh token, so this router is
   * the only thing that refreshes the profile's login: concurrent turns share one refresh, written back
   * where Claude Code keeps it. `stale` forces a refresh unless the stored token was already replaced.
   */
  private async token(signal?: AbortSignal, stale?: string): Promise<string> {
    const { oauth } = await this.login();
    const token = oauth.accessToken as string;
    if (token !== stale && typeof oauth.expiresAt === 'number' && oauth.expiresAt - Date.now() > REFRESH_LEAD_MS) return token;
    // Shared and not tied to one turn's signal: a cancelled turn must not abandon a rotation mid-flight.
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined; });
    return abortable(this.refreshing, signal);
  }

  private async refresh(): Promise<string> {
    const started = performance.now();
    const { all, oauth } = await this.login();
    const response = await fetch(this.options.tokenUrl ?? 'https://platform.claude.com/v1/oauth/token', {
      method: 'POST', signal: AbortSignal.timeout(30_000), headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: CLIENT_ID }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !isRecord(body) || typeof body.access_token !== 'string') {
      logSafe('claude-refresh-failed', { status: response.status, error: isRecord(body) ? String(body.error ?? '') : '' });
      if (response.status >= 500) throw new ClaudeError(`Claude login refresh failed (HTTP ${response.status}); retry the turn`, true);
      throw signedOut(this.options.configDir);
    }
    oauth.accessToken = body.access_token;
    if (typeof body.refresh_token === 'string') oauth.refreshToken = body.refresh_token;
    oauth.expiresAt = Date.now() + (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000;
    await this.store.write(all);
    logSafe('claude-login-refreshed', { ms: Math.round(performance.now() - started), expires_in: typeof body.expires_in === 'number' ? body.expires_in : 0 });
    return body.access_token;
  }

  /** Confirms once per token that the login is the pinned account and organization. */
  private verify(token: string): Promise<void> {
    const { expectedEmail, expectedOrg } = this.options;
    if (!expectedEmail && !expectedOrg) return Promise.resolve();
    if (this.verified?.token === token) return this.verified.check;
    const check = (async () => {
      const response = await fetch(`${this.api}/api/oauth/profile`, { headers: this.headers(token), signal: AbortSignal.timeout(30_000) });
      if (response.status === 401) throw signedOut(this.options.configDir);
      if (!response.ok) throw new ClaudeError(`Claude identity check failed (HTTP ${response.status}); retry the turn`, true);
      const profile: unknown = await response.json().catch(() => undefined);
      const email = isRecord(profile) && isRecord(profile.account) ? profile.account.email : undefined;
      const org = isRecord(profile) && isRecord(profile.organization) ? profile.organization.uuid : undefined;
      if ((expectedEmail && email !== expectedEmail) || (expectedOrg && org !== expectedOrg)) {
        logSafe('claude-identity-mismatch', { email_match: !expectedEmail || email === expectedEmail, org_match: !expectedOrg || org === expectedOrg });
        throw new ClaudeError('Claude account identity does not match its configured login');
      }
    })();
    this.verified = { token, check };
    check.catch(() => { if (this.verified?.check === check) this.verified = undefined; });
    return check;
  }

  /** A verified token. A token the profile endpoint rejects is refreshed once. */
  private async authorize(signal?: AbortSignal, stale?: string): Promise<string> {
    const token = await this.token(signal, stale);
    await abortable(this.verify(token), signal);
    return token;
  }

  /** A chat opening refreshes and verifies the login ahead of its first turn. Never throws. */
  prewarm(): void { void this.authorize().catch(() => {}); }

  private track(headers: Headers): void {
    const info = rateLimitInfo(headers);
    if (!info) return;
    this.limits.update(info);
    try { this.rateLimitSink?.(info); } catch {}
  }

  /** Opens the stream. Nothing has reached Codex yet, so each retry here is safe. */
  private async open(model: string, body: string, signal: AbortSignal): Promise<Response> {
    let token = await this.authorize(signal);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${this.api}/v1/messages?beta=true`, { method: 'POST', headers: this.headers(token, { 'content-type': 'application/json', accept: 'text/event-stream' }), body, signal });
      this.track(response.headers);
      if (response.ok) return response;
      const detail = await errorDetail(response);
      logSafe('claude-http-refused', { status: response.status, attempt });
      if (response.status === 401 && !refreshed) { refreshed = true; token = await this.authorize(signal, token); continue; }
      if (response.status === 429) throw this.limits.blocked(model) ?? new ClaudeUsageLimitError();
      if (CONTEXT_OVERFLOW_TEXT.test(detail)) throw contextOverflowError('Claude');
      if (response.status >= 500 && attempt < SERVER_RETRIES) { await sleep(200 * 2 ** attempt, signal); continue; }
      if (response.status === 529 || OVERLOADED_TEXT.test(detail)) throw overloadedError('Claude');
      if (response.status === 401 || response.status === 403) throw signedOut(this.options.configDir);
      // A server error that outlasted native Codex's retries stays a server error, which Codex retries itself.
      if (response.status >= 500) throw new Error(`Claude API HTTP ${response.status}`);
      throw new ClaudeError(`Claude request refused (HTTP ${response.status}${detail ? `: ${detail}` : ''})`);
    }
  }

  run(request: ResponsesRequest, signal?: AbortSignal, sink?: TextSink): Promise<ProxyOutput> {
    return retryOnce('Claude', signal, () => this.once(request, signal, sink), sink);
  }

  private async once(request: ResponsesRequest, signal: AbortSignal | undefined, sink: TextSink | undefined): Promise<ProxyOutput> {
    signal?.throwIfAborted();
    this.limits.assertAvailable(request.model);
    const started = performance.now();
    const { body, byKey } = claudeRequest(request, this.replay);
    // Bound silence, like native Codex's stream idle timeout; every chunk restarts the window.
    const idleMs = positiveInt('CLAUDE_TIMEOUT_MS', 300_000);
    const idle = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new DOMException('Claude stream idle', 'TimeoutError')), idleMs); };
    const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    touch();
    const content: JsonRecord[] = [];
    const usage: JsonRecord = {};
    let stop = '', ended = false, firstTextMs = 0, failure: JsonRecord | undefined;
    try {
      const response = await this.open(String(body.model), JSON.stringify(body), combined);
      if (!response.body) throw new ProxyTransportError();
      const watched = new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { touch(); controller.enqueue(chunk); } })));
      await sseEvents(watched, event => {
        const block = typeof event.index === 'number' ? content[event.index] : undefined;
        const delta = isRecord(event.delta) ? event.delta : {};
        if (event.type === 'message_start' && isRecord(event.message) && isRecord(event.message.usage)) Object.assign(usage, event.message.usage);
        else if (event.type === 'content_block_start' && typeof event.index === 'number' && isRecord(event.content_block)) content[event.index] = { ...event.content_block, partial: '' };
        else if (event.type === 'content_block_delta' && block) {
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            firstTextMs ||= performance.now() - started;
            block.text = String(block.text ?? '') + delta.text;
            sink?.text(delta.text);
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') block.partial += delta.partial_json;
          else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') block.thinking = String(block.thinking ?? '') + delta.thinking;
          else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') block.signature = delta.signature;
        } else if (event.type === 'message_delta') {
          if (isRecord(event.delta) && typeof event.delta.stop_reason === 'string') stop = event.delta.stop_reason;
          if (isRecord(event.usage)) Object.assign(usage, event.usage);
        } else if (event.type === 'message_stop') ended = true;
        else if (event.type === 'error') failure = isRecord(event.error) ? event.error : {};
      }, new Set(['message_stop', 'error']));
    } finally { clearTimeout(timer); }
    if (failure) {
      const detail = String(failure.message ?? failure.type ?? '').slice(0, 300);
      if (CONTEXT_OVERFLOW_TEXT.test(detail)) throw contextOverflowError('Claude');
      if (failure.type === 'overloaded_error' && sink?.started) throw overloadedError('Claude');
      // A provider failure after the stream opened: one fresh attempt is safe while nothing reached Codex.
      throw new ClaudeError(`Claude stream failed${detail ? `: ${detail}` : ''}`, true);
    }
    if (!ended) throw new ProxyTransportError();

    let textOut = '';
    const toolCalls: ToolCall[] = [];
    const thinking: JsonRecord[] = [];
    for (const block of content) {
      if (!block) continue;
      if (block.type === 'text') textOut += String(block.text ?? '');
      else if (block.type === 'thinking') thinking.push({ type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? '' });
      else if (block.type === 'redacted_thinking') thinking.push({ type: 'redacted_thinking', data: block.data });
      else if (block.type === 'tool_use' && typeof block.name === 'string') {
        // A call cut off by the output limit is not runnable.
        if (stop === 'max_tokens') throw new ClaudeError('Claude reached its output limit in the middle of a tool call; nothing was executed', true);
        toolCalls.push(codexToolCall(byKey, block.name, String(block.partial || '{}'), typeof block.id === 'string' ? block.id : undefined));
      }
    }
    if (thinking.length && toolCalls[0]?.callId) this.replay.remember(toolCalls[0].callId, thinking);
    const count = (key: string) => (typeof usage[key] === 'number' ? usage[key] as number : 0);
    // The prompt the model held is uncached input plus cache writes and reads; Codex compacts on this number.
    const inputTokens = count('input_tokens') + count('cache_creation_input_tokens') + count('cache_read_input_tokens');
    const outputTokens = count('output_tokens');
    logSafe('claude-turn', { model: String(body.model), ms: Math.round(performance.now() - started), first_text_ms: Math.round(firstTextMs), calls: toolCalls.length, input_tokens: inputTokens, cached_tokens: count('cache_read_input_tokens'), stop });
    return { text: textOut, toolCalls, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
  }


}

const primaryClaudeAccount = new ClaudeAccount({ configDir: process.env.CLAUDE_CONFIG_DIR, expectedEmail: process.env.CLAUDE_EXPECTED_EMAIL, expectedOrg: process.env.CLAUDE_EXPECTED_ORG }, claudeLimits);
export function onClaudeRateLimit(sink: (info: unknown) => void): void { primaryClaudeAccount.onRateLimit(sink); }

const claudeModel = (slug: string, displayName: string) => ({
  slug,
  displayName,
  description: `${displayName} through your signed-in Claude account`,
  efforts: EFFORTS,
  defaultEffort: 'high',
  inputModalities: ['text', 'image'] as const,
  contextWindow: 1_000_000,
});

export const claudeBackend: SubscriptionBackend = {
  name: 'Claude',
  models: { 'claude-opus-5-5': 'claude-opus-5-5', 'claude-fable-5-1': 'claude-fable-5-1', ...MODEL_ALIASES },
  reservedPrefix: 'claude-',
  catalog: [claudeModel('claude-opus-5-5', 'Opus 5.5'), claudeModel('claude-fable-5-1', 'Fable 5.1')],
  assertAvailable: (model) => claudeLimits.assertAvailable(model),
  run: (request, signal, sink) => primaryClaudeAccount.run(request, signal, sink),
  prewarm: () => primaryClaudeAccount.prewarm(),
};

export type SecondaryClaudeOptions = ClaudeAccountOptions & { configDir: string; prefix: string; label: string; models?: readonly string[] };

/** Opt-in second subscription, with native model ids behind distinct public slugs. */
export function createClaudeAccountBackend(options: SecondaryClaudeOptions) {
  if (!/^[a-z][a-z0-9-]*$/.test(options.prefix) || ['gpt', 'grok', 'claude'].includes(options.prefix) || /^(gpt|grok)-/.test(options.prefix))
    throw new Error('CLAUDE_ACCOUNT_MODEL_PREFIX must be a distinct lowercase namespace');
  if (!isAbsolute(options.configDir)) throw new Error('CLAUDE_ACCOUNT_CONFIG_DIR must be an absolute path');
  const canonical = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);
  const primary = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  if (canonical(options.configDir) === canonical(primary)) throw new Error('CLAUDE_ACCOUNT_CONFIG_DIR must differ from the primary Claude profile');
  const account = new ClaudeAccount(options);
  const selected = [...new Set(options.models ?? ['claude-opus-5-5', 'claude-fable-5-1'])];
  if (!selected.length || selected.some(model => !['claude-opus-5-5', 'claude-fable-5-1'].includes(model)))
    throw new Error('CLAUDE_ACCOUNT_MODELS must contain supported native Claude model slugs');
  const models = Object.fromEntries(selected.map(model => [`${options.prefix}-${model}`, model]));
  const backend: SubscriptionBackend = {
    name: `Claude (${options.label})`, models, reservedPrefix: `${options.prefix}-claude-`,
    catalog: selected.map(model => claudeModel(`${options.prefix}-${model}`, `${model === 'claude-opus-5-5' ? 'Opus 5.5' : 'Fable 5.1'} (${options.label})`)),
    assertAvailable: model => account.limits.assertAvailable(model),
    run: (request, signal, sink) => account.run(request, signal, sink),
    prewarm: () => account.prewarm(),
  };
  return { account, backend };
}

export function configuredClaudeAccount(env: Readonly<Record<string, string | undefined>> = process.env) {
  if (!env.CLAUDE_ACCOUNT_CONFIG_DIR) return undefined;
  return createClaudeAccountBackend({
    configDir: env.CLAUDE_ACCOUNT_CONFIG_DIR, prefix: env.CLAUDE_ACCOUNT_MODEL_PREFIX || 'secondary',
    label: env.CLAUDE_ACCOUNT_LABEL || 'Secondary', expectedEmail: env.CLAUDE_ACCOUNT_EXPECTED_EMAIL,
    expectedOrg: env.CLAUDE_ACCOUNT_EXPECTED_ORG,
    models: env.CLAUDE_ACCOUNT_MODELS?.split(',').map(model => model.trim()).filter(Boolean),
  });
}
