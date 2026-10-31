// Optional Cursor backend through Cursor's own SDK (`@cursor/sdk`), run inside the router: agents
// call Cursor's agent API directly, with no bridge process in between. Agents get no setting sources,
// no subagents and an empty in-memory file tree. Codex's tools are the agent's only tools (SDK custom
// tools behind the `mcp` group; see cursor-native.ts), so Cursor never owns execution: every call is
// validated and executed by Codex.
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { nonNegativeInt, positiveInt } from '../env';
import { isRecord, sha256, type JsonRecord } from '../json';
import { logSafe } from '../log';
import { functionTools, rawInputTools } from '../protocol/native-tools';
import { responseObject } from '../protocol/output';
import { imageUrl, isImagePart, preparePrompt, requestToPrompt, requestTools, toolDescriptors } from '../protocol/prompt';
import type { OutputSink, ProxyOutput, ResponsesRequest } from '../protocol/types';
import { abortable, ProxyTransportError, transportError } from '../transport';
import { BackendError, CONTEXT_OVERFLOW_TEXT, contextOverflowError, estimateVisibleTokens, retryOnce, type SubscriptionBackend } from './contract';
import { CUSTOM_TOOLS_PROVIDER, NativeRun, nativeToolList, toolResult, type ToolResult } from './cursor-native';

const CURSOR_MODELS = {
  // `context` is the Cursor model parameter requested (the largest each model offers); `window` is what
  // the catalog advertises to Codex so compaction happens at the real limit, not an artificial 200K.
  // Kimi exposes no context parameter and its limit is unverified, so it keeps the 200K default.
  // Kimi K3 is not a vision model on Cursor: a probed image arrives as an on-disk asset path only (2026-10-13).
  'kimi-k3': { name: 'Kimi K3', efforts: ['low', 'high', 'max'], parameter: 'reasoning', context: '', window: 200_000, vision: false, fast: false },
  // Grok 4.7: Cursor discovery lists a 500k context, but a run requested at 500k never reaches
  // RUN_LIFECYCLE_STATUS_FINISHED (probed 2026-10-13, text-only prompt); 256k is the largest that works.
  'grok-4.7': { name: 'Grok 4.7', efforts: ['low', 'medium', 'high', 'xhigh'], parameter: 'reasoning_effort', context: '256k', window: 256_000, vision: true, fast: true },
  'claude-opus-5-5': { name: 'Opus 5.5 via Cursor', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], parameter: 'effort', context: '1m', window: 1_000_000, vision: true, fast: true },
  // Cursor advertises 1m, but currently rejects that selection as invalid parameters; 300k is verified.
  'muse-wonder-1.0': { name: 'Muse Wonder', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], parameter: 'reasoning_effort', context: '300k', window: 300_000, vision: true, fast: false },
} as const;
type CursorModel = keyof typeof CURSOR_MODELS;

/** The part of `@cursor/sdk` the router uses; tests supply a scripted one. */
export type SdkRun = { readonly id: string; stream(): AsyncIterable<unknown>; wait(): Promise<unknown>; cancel(): Promise<void> };
export type SdkAgent = { readonly agentId: string; send(message: unknown, options?: JsonRecord): Promise<SdkRun>; close(): void };
export type CursorSdk = {
  Agent: { create(options: JsonRecord): Promise<SdkAgent> };
  Cursor: { me(options: { apiKey: string }): Promise<unknown>; models: { list(options: { apiKey: string }): Promise<unknown> } };
  JsonlLocalAgentStore: new (rootDir: string) => unknown;
  emptyFs(): unknown;
};

export type CursorOptions = {
  authFile: string; cwd: string; expectedEmail: string; expectedUserId: string; prefix: string; label: string; fastest?: boolean;
  /** Loads the SDK; tests pass a scripted one. */
  sdk?: () => Promise<CursorSdk>;
};
export class CursorError extends BackendError {
  constructor(message: string, retryable = false) { super(message, { retryable }); this.name = 'CursorError'; }
}

// Provider-side failures that native Codex would retry with backoff (429/5xx/overload). Matched
// against the short reason Cursor attaches to an errored run, never against model output.
const TRANSIENT_RUN_ERROR = /rate.?limit|too many requests|\b429\b|\b50[234]\b|overload|capacity|temporar|unavailable|internal error|try again|timed? ?out|upstream|gateway/i;
const short = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 160);

export function cursorSelection(model: string, effort = 'high', fastest = false): JsonRecord {
  if (!Object.hasOwn(CURSOR_MODELS, model)) throw new CursorError('Unsupported Cursor model');
  const spec = CURSOR_MODELS[model as CursorModel];
  if (!(spec.efforts as readonly string[]).includes(effort)) throw new CursorError('Unsupported Cursor reasoning effort');
  return { id: model, params: [{ id: spec.parameter, value: effort }, ...(spec.context ? [{ id: 'context', value: spec.context }] : []), ...(spec.fast ? [{ id: 'fast', value: fastest ? 'true' : 'false' }] : [])] };
}

const OPAQUE_ITEM_TYPES = new Set(['compaction', 'compaction_summary', 'context_compaction', 'encrypted_content', 'reasoning']);
const MEDIA_PART_TYPES = new Set(['input_audio', 'audio', 'input_file', 'file']);
const OMITTED_MEDIA = { type: 'input_text', text: '[attachment omitted: Cursor accepts text and inline images only]' };
const isOpaque = (value: JsonRecord): boolean => OPAQUE_ITEM_TYPES.has(String(value.type)) || typeof value.encrypted_content === 'string';
// Inline PNG/JPEG/GIF/WebP data URLs are sent to Cursor as message images (the same path the Cursor app
// uses for pasted screenshots). Share the prompt's typed/MCP/legacy-computer recognition; ordinary tool
// metadata containing image_url or file_id is text, not an attachment.
const isInlineImage = (value: JsonRecord, legacyComputerOutput: boolean): boolean => !value.file_id && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(imageUrl(value, legacyComputerOutput) ?? '');

/**
 * Cursor cannot replay OpenAI-encrypted reasoning, compaction summaries or non-image attachments. Rather
 * than refusing the whole turn (which breaks mid-thread model switches from a GPT backend), drop the opaque
 * history items and replace unsupported media parts with a short text placeholder so the model knows
 * something was omitted. Inline images survive untouched. Returns the sanitized input plus a count of what
 * changed for logging.
 */
export function sanitizeCursorInput(input: unknown): { input: unknown; dropped: number; replaced: number } {
  const stats = { dropped: 0, replaced: 0 };
  const walk = (value: unknown, legacyComputerOutput = false): unknown => {
    if (Array.isArray(value)) return value.map(item => walk(item, legacyComputerOutput));
    if (!isRecord(value)) return value;
    if (isImagePart(value, legacyComputerOutput)) {
      if (isInlineImage(value, legacyComputerOutput)) return value;
      stats.replaced++; return OMITTED_MEDIA;
    }
    if (MEDIA_PART_TYPES.has(String(value.type))) { stats.replaced++; return OMITTED_MEDIA; }
    if (isOpaque(value)) { stats.replaced++; return { type: 'input_text', text: '[encrypted or compacted content from a previous model; unreadable here]' }; }
    const out: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) out[key] = walk(child, value.type === 'computer_call_output' && key === 'output');
    return out;
  };
  if (!Array.isArray(input)) return { input: walk(input), ...stats };
  const items: unknown[] = [];
  for (const item of input) {
    if (isRecord(item) && isOpaque(item)) { stats.dropped++; continue; }
    items.push(walk(item));
  }
  return { input: items, ...stats };
}

// Native tool calls: Codex's tools are the only callable tools, so the prompt only says who runs them.
const nativeRules = (raw: string[]) => `You are the model inside a Codex agent loop. Your tools are the Codex tools on the "${CUSTOM_TOOLS_PROVIDER}" MCP server; Codex executes every call on the user's machine and returns the result to you. Their input schemas are listed in <tool_schemas>, so call them directly through the MCP tool call without a discovery step, with arguments exactly matching each schema.${raw.length ? ` Only ${raw.join(', ')} ${raw.length === 1 ? 'takes' : 'take'} one raw string, in the field "input"; every other tool takes the fields of its own schema.` : ''} You have no other tools. Independent calls may be made in parallel. When the task is done or you need the user, reply with plain text. Never claim an action ran before its result appears.`;

function readCursorKey(options: CursorOptions): string {
  const info = statSync(options.authFile);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new CursorError('Cursor SDK credential file must be owner-only');
  let value: unknown;
  try { value = JSON.parse(readFileSync(options.authFile, 'utf8')); } catch { throw new CursorError('Cursor SDK credential file is unreadable or invalid'); }
  if (!isRecord(value) || typeof value.apiKey !== 'string' || !value.apiKey || value.email !== options.expectedEmail || value.backendUrl !== 'https://api2.cursor.sh' || (typeof value.apiKeyExpiresAtMs === 'number' && value.apiKeyExpiresAtMs <= Date.now())) throw new CursorError('Cursor SDK login is missing, expired or belongs to another account');
  return value.apiKey;
}

/**
 * An SDK failure as the router's error. A network failure is an outage (the shared offline policy
 * keeps the request pending); Cursor's own refusal keeps its short message, which never contains the
 * request or the key; only what Cursor marks retryable gets the one fresh attempt.
 */
export function cursorFailure(error: unknown): Error {
  if (error instanceof BackendError || error instanceof ProxyTransportError) return error;
  const record = isRecord(error) ? error : {};
  const name = error instanceof Error ? error.name : String(record.name ?? '');
  const message = short(error instanceof Error ? error.message : String(record.message ?? ''));
  if (CONTEXT_OVERFLOW_TEXT.test(message)) return contextOverflowError('Cursor');
  if (name === 'NetworkError' || transportError(error)?.reconnectable) return new ProxyTransportError();
  const status = typeof record.status === 'number' ? `HTTP ${record.status}` : '';
  const code = typeof record.code === 'string' ? record.code.replace(/[^a-z_]/gi, '').slice(0, 64) : '';
  const detail = [status, code].filter(Boolean).join(', ');
  logSafe('cursor-refused', { name: name.replace(/[^A-Za-z]/g, '').slice(0, 40), status: record.status ?? null, code: code || null, retryable: record.isRetryable === true });
  if (name === 'AuthenticationError') return new CursorError(`Cursor rejected the SDK login${detail ? ` (${detail})` : ''}; sign in again`);
  if (name === 'RateLimitError') return new CursorError(`Cursor usage limit reached${detail ? ` (${detail})` : ''}${message ? `: ${message}` : ''}`);
  return new CursorError(`Cursor refused the request${detail ? ` (${detail})` : ''}${message ? `: ${message}` : ''}`, record.isRetryable === true || (typeof record.status === 'number' && record.status >= 500));
}

export function assertCursorIdentity(value: unknown, options: Pick<CursorOptions, 'expectedEmail' | 'expectedUserId'>): void {
  if (!isRecord(value) || value.userEmail !== options.expectedEmail || String(value.userId) !== options.expectedUserId) throw new CursorError('Cursor authenticated account differs from the pinned identity');
}

// Account/catalog lookups have a much lower rate limit than agent inference. Validate once per
// credential and pins, share concurrent lookups, and refresh after five minutes. A rotated key or
// changed identity pin never reuses another account's proof. Server access policy remains decisive.
type CursorLookups = { me(): Promise<unknown>; models(): Promise<unknown> };
type CursorProfileProof = { expires: number; value: Promise<unknown[]>; cancelled: boolean };
const profileCache = new Map<string, CursorProfileProof>();
export async function verifyCursorProfile(options: Pick<CursorOptions, 'expectedEmail' | 'expectedUserId'>, key: string, lookups: CursorLookups, signal?: AbortSignal): Promise<unknown[]> {
  signal?.throwIfAborted();
  const cacheKey = sha256(Buffer.from(key)) + '|' + options.expectedEmail + '|' + options.expectedUserId;
  const previous = profileCache.get(cacheKey);
  let entry: CursorProfileProof;
  if (previous && previous.expires > Date.now()) entry = previous;
  else {
    const value = (async () => {
      assertCursorIdentity(await lookups.me(), options);
      const models = await lookups.models();
      if (!Array.isArray(models)) throw new CursorError('Cursor returned an invalid model catalog');
      return models;
    })().catch((error: unknown) => {
      // A cancelled lookup owner's request must not poison uncancelled waiters. Only an actual abort
      // qualifies: identity/auth/quota/backend refusals retain their original terminal behaviour,
      // even if the owner also happened to cancel before the rejection was observed.
      entry.cancelled = !!signal?.aborted && !(error instanceof BackendError)
        && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'));
      if (profileCache.get(cacheKey) === entry) profileCache.delete(cacheKey);
      throw error;
    });
    entry = { expires: Date.now() + 300_000, value, cancelled: false };
    if (profileCache.size >= 32) profileCache.delete(profileCache.keys().next().value!);
    profileCache.set(cacheKey, entry);
  }
  try {
    const result = await abortable(entry.value, signal);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (entry.cancelled) return verifyCursorProfile(options, key, lookups, signal);
    throw error;
  }
}

/**
 * A finished run with the requested model and parameters. Anything else throws a named CursorError,
 * retryable only for a provider-side transient failure or a failure Cursor gave no reason for
 * (nothing has executed, so one fresh attempt is safe).
 */
export function finishedRun(result: unknown, selection: JsonRecord): JsonRecord {
  const run = isRecord(result) ? result : {};
  if (run.status !== 'finished') {
    const error = isRecord(run.error) ? run.error : {};
    const reason = typeof error.message === 'string' && error.message.trim() ? short(error.message) : undefined;
    if (reason && CONTEXT_OVERFLOW_TEXT.test(reason)) throw contextOverflowError('Cursor');
    const cancelled = run.status === 'cancelled';
    const transient = !cancelled && (!reason || TRANSIENT_RUN_ERROR.test(reason));
    logSafe('cursor-unfinished', { status: String(run.status ?? 'missing').slice(0, 20), code: typeof error.code === 'string' ? error.code.slice(0, 40) : null, reason_bytes: reason?.length ?? 0, transient });
    throw new CursorError(`Cursor did not finish successfully (run status ${String(run.status ?? 'missing')}${reason ? `: ${reason}` : ' with no reason from Cursor'})`, transient);
  }
  const params = (value: unknown) => JSON.stringify((Array.isArray(value) ? [...value] : []).sort((a, b) => String(isRecord(a) ? a.id : '').localeCompare(String(isRecord(b) ? b.id : ''))));
  if (!isRecord(run.model) || run.model.id !== selection.id || params(run.model.params) !== params(selection.params)) throw new CursorError('Cursor reported a different model or reasoning setting; request refused');
  return run;
}

/** Prompt and output tokens a Cursor usage record describes. */
function usageTokens(usage: JsonRecord | undefined): { input: number; output: number } | undefined {
  if (!usage) return undefined;
  const input = Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0) + Number(usage.cacheWriteTokens ?? 0), output = Number(usage.outputTokens ?? 0);
  return [input, output].every(n => Number.isSafeInteger(n) && n >= 0) ? { input, output } : undefined;
}

/** An agent with its own working directory; the SDK keeps its state and transcripts per directory. */
type Spare = { agent: SdkAgent; dir: string };
/** A Cursor run that may span several Codex turns while it waits on their tool results. */
type RunSession = {
  run: NativeRun; spare: Spare; key: string; sdkRun?: SdkRun; signature: string; historyHash: string; historyLength: number;
  lastEvent: number; done: boolean; heldSince?: number; expiry?: ReturnType<typeof setTimeout>; ended?: Promise<void>;
};
export type CursorBackend = SubscriptionBackend & { close(): Promise<void> };

/** Bind a continuation to the exact text and images Cursor can read. Responses metadata
 * (IDs, status, annotations, input_text vs output_text) can be reserialized by Codex. */
function historyHash(items: unknown[]): string {
  return sha256(JSON.stringify(preparePrompt({ model: '', input: items as ResponsesRequest['input'] })));
}
function sessionSignature(request: ResponsesRequest, selection: JsonRecord): string {
  return JSON.stringify({ selection, instructions: request.instructions, tools: requestTools(request), toolChoice: request.tool_choice, outputLimit: request.max_output_tokens });
}
const TOOL_RESULTS = new Set(['function_call_output', 'custom_tool_call_output', 'computer_call_output', 'tool_search_output']);
/** Cursor's project folder for a working directory, as the SDK names it. */
const projectDir = (dir: string) => join(homedir(), '.cursor', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, ''));

class CursorRuntime {
  private readonly heldRuns = new Map<string, RunSession>();
  private readonly sessions = new Set<RunSession>();
  private readonly spares = new Map<string, Promise<Spare>>();
  private sdkLoad?: Promise<CursorSdk>;
  /** The model the next ready agent starts with; each send names its own, so this only spares a switch. */
  private lastSelection = cursorSelection('kimi-k3');
  readonly options: Readonly<CursorOptions>;
  constructor(options: CursorOptions) { this.options = Object.freeze({ ...options }); }

  private sdk(): Promise<CursorSdk> {
    this.sdkLoad ??= (this.options.sdk ?? (() => import('@cursor/sdk') as unknown as Promise<CursorSdk>))();
    return this.sdkLoad;
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions].map(session => this.endRun(session, 'Router shutting down')));
    const spares = [...this.spares.values()];
    this.spares.clear();
    await Promise.all(spares.map(spare => spare.then(value => this.dispose(value), () => {})));
  }

  /** Readies an agent when a chat opens, so its first turn skips agent setup. Never throws. */
  prewarm(): void {
    try { void this.spare(readCursorKey(this.options)).catch(() => {}); } catch {}
  }

  /** A new agent with no tools of its own; each turn chooses the model and Codex's tools when it sends. */
  private async createAgent(key: string): Promise<Spare> {
    const sdk = await this.sdk();
    const started = performance.now();
    const dir = await mkdtemp(join(this.options.cwd, 'agent-'));
    try {
      const agent = await sdk.Agent.create({
        apiKey: key, model: this.lastSelection,
        // Only the MCP group is allowed, and its only tools are Codex's: no shell, edit, read, web or
        // subagent tool exists for this agent, and its file tree is empty and in memory.
        tools: ['mcp'], disallowedTools: ['task'],
        local: { cwd: dir, settingSources: [], fs: sdk.emptyFs(), store: new sdk.JsonlLocalAgentStore(join(dir, 'store')) },
      }).catch((error: unknown) => { throw cursorFailure(error); });
      logSafe('cursor-agent-created', { ms: Math.round(performance.now() - started) });
      return { agent, dir };
    } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  }

  /** The ready agent for this login, created ahead of its turn. */
  private spare(key: string): Promise<Spare> {
    let spare = this.spares.get(key);
    if (!spare) {
      spare = this.createAgent(key);
      this.spares.set(key, spare);
      spare.catch(() => { if (this.spares.get(key) === spare) this.spares.delete(key); });
    }
    return spare;
  }

  /** Takes the ready agent and readies the next one. */
  private async takeAgent(key: string, signal: AbortSignal): Promise<Spare> {
    for (const stale of this.spares.keys()) if (stale !== key) { const old = this.spares.get(stale)!; this.spares.delete(stale); void old.then(value => this.dispose(value), () => {}); }
    const spare = this.spare(key);
    this.spares.delete(key);
    const taken = await abortable(spare, signal).catch((error: unknown) => {
      if (signal.aborted) void spare.then(value => this.dispose(value), () => {});
      throw error;
    });
    if (nonNegativeInt('CURSOR_SPARE_AGENTS', 1)) void this.spare(key).catch(() => {});
    return taken;
  }

  private async dispose(spare: Spare): Promise<void> {
    try { spare.agent.close(); } catch {}
    await Promise.all([rm(spare.dir, { recursive: true, force: true }), rm(projectDir(spare.dir), { recursive: true, force: true })]).catch(() => logSafe('cursor-cleanup-failed', { stage: 'directory' }));
  }

  /**
   * One Codex turn. A request that carries the results of calls a live run is holding continues that
   * run; anything else starts a fresh agent with the full history. The turn ends when the model has
   * issued its calls (they go to Codex) or the run finishes.
   */
  async run(request: ResponsesRequest, signal?: AbortSignal, sink?: OutputSink): Promise<ProxyOutput> {
    const started = performance.now();
    const sanitized = sanitizeCursorInput(request.input);
    if (sanitized.dropped || sanitized.replaced) logSafe('cursor-input-sanitized', { dropped: sanitized.dropped, replaced: sanitized.replaced });
    request = { ...request, input: sanitized.input as ResponsesRequest['input'] };
    const selection = cursorSelection(request.model, request.reasoning?.effort, this.options.fastest);
    const signature = sessionSignature(request, selection);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const idleMs = positiveInt('CURSOR_TIMEOUT_MS', 300_000);
    let session: RunSession | undefined, timedOut = false, setupMs = 0, calls = 0, success = false;
    const continuation = this.continuation(request, signature);
    // Silence is measured from the request start until the run streams, so a hung setup is cut too.
    const idle = setInterval(() => { if (performance.now() - (session?.lastEvent ?? started) > idleMs) { timedOut = true; controller.abort(); } }, Math.min(1000, idleMs));
    try {
      if (continuation) {
        session = continuation.session;
        clearTimeout(session.expiry);
        for (const id of continuation.results.keys()) this.heldRuns.delete(id);
        session.lastEvent = performance.now();
        session.run.attach(sink);
        session.run.answer(continuation.results);
      } else {
        session = await this.startRun(request, selection, signature, combined, sink);
      }
      setupMs = performance.now() - started;
      const step = await session.run.next(combined);
      calls = step.calls.length;
      const inputTokens = Math.max(estimateVisibleTokens(requestToPrompt(request)), usageTokens(step.usage)?.input ?? 0);
      const outputTokens = Math.max(estimateVisibleTokens(step.text + JSON.stringify(step.calls)), usageTokens(step.usage)?.output ?? 0);
      const output: ProxyOutput = { text: step.text, toolCalls: step.calls, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
      if (step.calls.length && Array.isArray(request.input)) this.holdRun(session, request, output, signature);
      else void this.endRun(session, 'Cursor turn finished');
      success = true;
      return output;
    } catch (error) {
      if (session) await this.endRun(session, 'Cursor turn failed');
      if (timedOut) throw new CursorError(`Cursor request timed out after ${Math.round(idleMs / 1000)}s without output`, true);
      throw error;
    } finally {
      clearInterval(idle);
      logSafe('cursor-turn', { model: request.model, continued: !!continuation, success, calls, setup_ms: Math.round(setupMs), elapsed_ms: Math.round(performance.now() - started) });
    }
  }

  /** The held run this request continues: its history is unchanged and it answers exactly the held calls. */
  private continuation(request: ResponsesRequest, signature: string): { session: RunSession; results: Map<string, ToolResult> } | undefined {
    if (!Array.isArray(request.input)) return undefined;
    let session: RunSession | undefined;
    for (let index = request.input.length - 1; index >= 0 && !session; index--) {
      const callId = request.input[index]?.call_id;
      if (callId) session = this.heldRuns.get(callId);
    }
    if (!session) return undefined;
    // A rotated or unreadable credential never continues a run started under another login.
    let key: string | undefined;
    try { key = readCursorKey(this.options); } catch (error) { void this.endRun(session, 'The Cursor credential changed'); throw error; }
    const pending = session.run.pending();
    const suffix = request.input.slice(session.historyLength);
    const answers = suffix.every(item => TOOL_RESULTS.has(item.type ?? '') && item.type !== 'tool_search_output' && pending.includes(item.call_id ?? ''));
    const matches = key === session.key && session.signature === signature && suffix.length > 0 && answers && pending.every(id => suffix.some(item => item.call_id === id))
      && historyHash(request.input.slice(0, session.historyLength)) === session.historyHash;
    if (!matches) {
      // A changed history, a tool search (new tools) or a user message mid-run: replay instead.
      logSafe('cursor-replay', { signature: session.signature === signature, answers });
      void this.endRun(session, 'The conversation changed; this run was replaced');
      return undefined;
    }
    return { session, results: new Map(suffix.map(item => [item.call_id!, toolResult(item)])) };
  }

  private async startRun(request: ResponsesRequest, selection: JsonRecord, signature: string, signal: AbortSignal, sink: OutputSink | undefined): Promise<RunSession> {
    await this.reclaimHeld();
    const key = readCursorKey(this.options);
    const sdk = await this.sdk();
    const lookups = { me: () => sdk.Cursor.me({ apiKey: key }).catch((error: unknown) => { throw cursorFailure(error); }), models: () => sdk.Cursor.models.list({ apiKey: key }).catch((error: unknown) => { throw cursorFailure(error); }) };
    this.lastSelection = selection;
    // The identity check (usually cached) and the agent run side by side; a failed check closes the agent.
    const [proof, taken] = await Promise.allSettled([verifyCursorProfile(this.options, key, lookups, signal), this.takeAgent(key, signal)]);
    if (proof.status === 'rejected' || taken.status === 'rejected') {
      if (taken.status === 'fulfilled') await this.dispose(taken.value);
      throw proof.status === 'rejected' ? proof.reason : (taken as PromiseRejectedResult).reason;
    }
    const [models, spare] = [proof.value, taken.value];
    let session: RunSession | undefined;
    try {
      const discovered = models.find(item => isRecord(item) && item.id === request.model);
      if (!isRecord(discovered) || !Array.isArray(discovered.parameters)) throw new CursorError('Requested model is unavailable on the pinned Cursor account');
      const definitions = discovered.parameters;
      if ((selection.params as Array<{ id: string; value: string }>).some(param => !definitions.some(def => isRecord(def) && def.id === param.id && Array.isArray(def.values) && def.values.some(v => isRecord(v) && v.value === param.value)))) throw new CursorError('Requested Cursor parameters are unavailable');
      // Cursor has no way to forbid calls, so a turn that allows none gets no tools.
      const tools = functionTools(request.tool_choice === 'none' ? [] : toolDescriptors(requestTools(request)));
      const run = new NativeRun(tools.byKey, nonNegativeInt('CURSOR_TOOL_SETTLE_MS', 350));
      // Attached before the send, so the first thinking reaches Codex too.
      run.attach(sink);
      session = { run, spare, key, signature, historyHash: '', historyLength: 0, lastEvent: performance.now(), done: false };
      this.sessions.add(session);
      const customTools = Object.fromEntries(Object.entries(tools.definitions).map(([name, tool]) => [name, {
        description: tool.description, inputSchema: tool.inputSchema, execute: (args: unknown) => run.call(name, args),
      }]));
      const prepared = preparePrompt(request);
      const images = prepared.images.map(image => ({ data: image.source.data, mimeType: image.source.media_type }));
      if (images.length) logSafe('cursor-images-attached', { count: images.length });
      const text = [nativeRules(rawInputTools(tools.byKey)), nativeToolList(tools.definitions), prepared.prompt].filter(Boolean).join('\n\n');
      const current = session;
      const onDelta = ({ update }: { update: unknown }) => {
        current.lastEvent = performance.now();
        if (!isRecord(update)) return;
        if (update.type === 'text-delta' && typeof update.text === 'string') run.appendText(update.text);
        else if (update.type === 'thinking-delta' && typeof update.text === 'string') run.appendReasoning(update.text);
        else if (update.type === 'tool-call-started' && !isCodexTool(update.toolCall)) run.fail(new CursorError('Cursor attempted a native action; it was stopped and no Codex actions were returned'));
        else if (update.type === 'summary-started') run.fail(contextOverflowError('Cursor'));
      };
      signal.throwIfAborted();
      current.sdkRun = await spare.agent.send(images.length ? { text, images } : text, { model: selection, local: { customTools }, onDelta })
        .catch((error: unknown) => { throw cursorFailure(error); });
      void this.readRun(current, selection);
      return current;
    } catch (error) {
      if (session) await this.endRun(session, 'Cursor turn failed');
      else await this.dispose(spare);
      throw error;
    }
  }

  /** Watches a run's messages for anything but Codex's tools, records usage, and settles its result. */
  private async readRun(session: RunSession, selection: JsonRecord): Promise<void> {
    const { run } = session;
    try {
      for await (const message of session.sdkRun!.stream()) {
        session.lastEvent = performance.now();
        if (!isRecord(message)) continue;
        if (message.type === 'tool_call' && !(message.name === 'mcp' && isRecord(message.args) && message.args.providerIdentifier === CUSTOM_TOOLS_PROVIDER)) throw new CursorError('Cursor attempted a native action; it was stopped and no Codex actions were returned');
        // Cursor summarizes its own context only near the model's limit: Codex compacts instead.
        if (message.type === 'summary') throw contextOverflowError('Cursor');
        if (message.type === 'task') throw new CursorError('Cursor attempted a subagent; it was stopped and no Codex actions were returned');
        if (message.type === 'usage' && isRecord(message.usage)) run.usage = message.usage;
      }
      const result = finishedRun(await session.sdkRun!.wait(), selection);
      if (isRecord(result.usage) && !run.usage) run.usage = result.usage;
      session.done = true;
      run.finish();
    } catch (error) {
      session.done = true;
      run.fail(cursorFailure(error));
    }
  }

  /** Keeps the run until Codex returns these calls' results, or the session expires. */
  private holdRun(session: RunSession, request: ResponsesRequest, output: ProxyOutput, signature: string): void {
    const prior = [...(request.input as unknown[]), ...responseObject(request, output).output];
    session.signature = signature;
    session.historyHash = historyHash(prior);
    session.historyLength = prior.length;
    session.heldSince = Date.now();
    for (const call of output.toolCalls) if (call.callId) this.heldRuns.set(call.callId, session);
    session.expiry = setTimeout(() => void this.endRun(session, 'Codex did not return the tool results in time'), positiveInt('CURSOR_SESSION_IDLE_MS', 900_000));
    session.expiry.unref?.();
  }

  /** Held runs wait on Codex; past the cap, the one waiting longest is ended and replays if continued. */
  private async reclaimHeld(): Promise<void> {
    const held = [...new Set(this.heldRuns.values())].filter(session => session.heldSince !== undefined && !session.ended);
    if (held.length < positiveInt('CURSOR_MAX_HELD_RUNS', 16)) return;
    const oldest = held.reduce((a, b) => (a.heldSince! <= b.heldSince! ? a : b));
    logSafe('cursor-reclaimed', { held: held.length, held_ms: Date.now() - oldest.heldSince! });
    await this.endRun(oldest, 'Too many Cursor runs were waiting on Codex; this run will be replayed if continued');
  }

  /** Ends a run: held callbacks are released, an unfinished run is cancelled, the agent is closed. */
  private endRun(session: RunSession, reason: string): Promise<void> {
    if (session.ended) return session.ended;
    clearTimeout(session.expiry);
    for (const [callId, owner] of this.heldRuns) if (owner === session) this.heldRuns.delete(callId);
    session.run.close(reason);
    session.ended = (async () => {
      if (!session.done && session.sdkRun) await session.sdkRun.cancel().catch(() => logSafe('cursor-cleanup-failed', { stage: 'cancel' }));
      await this.dispose(session.spare);
      this.sessions.delete(session);
    })();
    return session.ended;
  }
}

/** A tool call aimed at Codex's tools: the SDK's custom-tools MCP provider, and nothing else. */
function isCodexTool(call: unknown): boolean {
  return isRecord(call) && call.type === 'mcp' && isRecord(call.args) && call.args.providerIdentifier === CUSTOM_TOOLS_PROVIDER;
}

export function createCursorBackend(options: CursorOptions): CursorBackend {
  if (![options.authFile, options.cwd].every(isAbsolute) || !/^[a-z][a-z0-9-]*$/.test(options.prefix) || ['gpt', 'grok', 'claude'].includes(options.prefix) || !options.expectedEmail || !options.expectedUserId) throw new Error('Cursor requires absolute paths, account identity and a model namespace');
  const exposed: CursorModel[] = ['kimi-k3', 'grok-4.7', 'claude-opus-5-5', 'muse-wonder-1.0'];
  const runtime = new CursorRuntime(options);
  return {
    name: `Cursor (${options.label})`, reservedPrefix: `${options.prefix}-`,
    models: Object.fromEntries(exposed.map(model => [`${options.prefix}-${model}`, model])),
    catalog: exposed.map(model => ({ slug: `${options.prefix}-${model}`, displayName: `${CURSOR_MODELS[model].name} (${options.label})`, description: 'Your subscription through Cursor; Codex executes tools.', efforts: CURSOR_MODELS[model].efforts, defaultEffort: 'high', inputModalities: CURSOR_MODELS[model].vision ? ['text', 'image'] : ['text'], contextWindow: CURSOR_MODELS[model].window })),
    // Transient provider failures (an errored run, a dropped stream) get one fresh attempt.
    run: (request, signal, sink) => retryOnce('Cursor', signal, () => runtime.run(request, signal, sink), sink),
    prewarm: () => runtime.prewarm(),
    close: () => runtime.close(),
  };
}

export function configuredCursorBackend(env: Readonly<Record<string, string | undefined>> = process.env): CursorBackend | undefined {
  if (!env.CURSOR_AUTH_FILE) return undefined;
  return createCursorBackend({ authFile: env.CURSOR_AUTH_FILE, cwd: env.CURSOR_CWD ?? '', expectedEmail: env.CURSOR_EXPECTED_EMAIL ?? '', expectedUserId: env.CURSOR_EXPECTED_USER_ID ?? '', prefix: env.CURSOR_MODEL_PREFIX || 'cursor', label: env.CURSOR_LABEL || 'Cursor', fastest: env.CURSOR_SPEED_POLICY === 'fastest' });
}
