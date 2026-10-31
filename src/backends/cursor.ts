// Optional Cursor transport through the vendor's pinned SDK bridge. The proxy has no runtime
// package dependency: it speaks sdk.v1 Connect JSON to an exclusively leased loopback process.
// Agents get no setting sources and no subagents. Codex's tools are the agent's only tools (SDK custom
// tools behind the `mcp` group, answered over a router callback; see cursor-native.ts), so Cursor
// never owns execution: every call is validated and executed by Codex.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { childEnvironment, nonNegativeInt, positiveInt } from '../env';
import { isRecord, pinnedFileHash, randomId, sha256, type JsonRecord } from '../json';
import { imageUrl, isImagePart, preparePrompt, requestToPrompt, requestTools, toolDescriptors } from '../protocol/prompt';
import type { ProxyOutput, ResponsesRequest } from '../protocol/types';
import { BackendError, CONTEXT_OVERFLOW_TEXT, contextOverflowError, estimateVisibleTokens, retryOnce, type SubscriptionBackend } from './contract';
import { logSafe } from '../log';
import { abortable, ProxyTransportError, sleep, transportError } from '../transport';
import { CursorBridgePool, type CursorLease } from './cursor-pool';
import { responseObject } from '../protocol/output';
import { CUSTOM_TOOLS_PROVIDER, NativeCallbackServer, NativeRun, nativeToolList, nativeTools, rawInputTools, toolResult, type ToolResult } from './cursor-native';

const CURSOR_MODELS = {
  // `context` is the Cursor model parameter requested (the largest each model offers); `window` is what
  // the catalog advertises to Codex so compaction happens at the real limit, not an artificial 200K.
  // Kimi exposes no context parameter and its limit is unverified, so it keeps the 200K default.
  // Kimi K3 is not a vision model on Cursor: a probed image arrives as an on-disk asset path only (2026-10-13).
  'kimi-k3': { name: 'Kimi K3', efforts: ['low', 'high', 'max'], parameter: 'reasoning', context: '', window: 200_000, vision: false, fast: false },
  // Grok 4.7: Cursor discovery lists a 500k context, but a run requested at 500k never reaches
  // RUN_LIFECYCLE_STATUS_FINISHED (probed 2026-10-13, text-only prompt); 256k is the largest that works.
  'grok-4.7': { name: 'Grok 4.7', efforts: ['low', 'medium', 'high', 'xhigh'], parameter: 'reasoning_effort', context: '256k', window: 256_000 , vision: true, fast: true },
  'claude-opus-5-5': { name: 'Opus 5.5 via Cursor', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], parameter: 'effort', context: '1m', window: 1_000_000 , vision: true, fast: true },
  // Cursor advertises 1m, but currently rejects that selection as invalid parameters; 300k is verified.
  'muse-wonder-1.0': { name: 'Muse Wonder', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], parameter: 'reasoning_effort', context: '300k', window: 300_000, vision: true, fast: false },
} as const;
type CursorModel = keyof typeof CURSOR_MODELS;
export type CursorOptions = {
  binary: string; binaryHash: string; authFile: string; cwd: string;
  expectedEmail: string; expectedUserId: string; prefix: string; label: string; fastest?: boolean;
};
export class CursorError extends BackendError {
  constructor(message: string, retryable = false) { super(message, { retryable }); this.name = 'CursorError'; }
}

const MAX_BYTES = 32 * 1024 * 1024;
const FINISHED = 'RUN_LIFECYCLE_STATUS_FINISHED';
// Provider-side failures that native Codex would retry with backoff (429/5xx/overload). Matched
// against the short reason Cursor attaches to an errored run, never against model output.
const TRANSIENT_RUN_ERROR = /rate.?limit|too many requests|\b429\b|\b50[234]\b|overload|capacity|temporar|unavailable|internal error|try again|timed? ?out|upstream|gateway/i;

/** Cursor's own reason for an unfinished run: a short provider string, or undefined when absent. */
function cursorRunReason(result: JsonRecord | undefined, run: JsonRecord | undefined, done: unknown): string | undefined {
  const candidates: unknown[] = [run?.error, run?.errorMessage, run?.message, result?.error, result?.errorMessage, isRecord(done) ? done.error : undefined];
  if (run && run.status !== FINISHED && typeof run.result === 'string') candidates.push(run.result);
  for (const value of candidates) {
    const text = typeof value === 'string' ? value : isRecord(value) && typeof value.message === 'string' ? value.message : undefined;
    if (text && text.trim()) return text.replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  return undefined;
}
const PRIVATE_ENV = /^(CURSOR_|AGENT_|OPENAI_|ANTHROPIC_|CLAUDE_CODE_|XAI_|GROK_|PROXY_|NODE_OPTIONS$|BUN_OPTIONS$)/;
export function cursorEnvironment(apiKey: string): Record<string, string> {
  return { ...childEnvironment((key) => PRIVATE_ENV.test(key)), CURSOR_API_KEY: apiKey, CURSOR_SDK_CLIENT_LANGUAGE: 'typescript' };
}

export function cursorSelection(model: string, effort = 'high', fastest = false): JsonRecord {
  if (!Object.hasOwn(CURSOR_MODELS, model)) throw new CursorError('Unsupported Cursor model');
  const spec = CURSOR_MODELS[model as CursorModel];
  if (!(spec.efforts as readonly string[]).includes(effort)) throw new CursorError('Unsupported Cursor reasoning effort');
  return { id: model, params: [{ id: spec.parameter, value: effort }, ...(spec.context ? [{ id: 'context', value: spec.context }] : []), ...(spec.fast ? [{ id: 'fast', value: fastest ? 'true' : 'false' }] : [])] };
}

// An unfinished run's raw terminal frames are kept privately (owner-only file in the runtime state) so
// the failure can be read afterwards instead of guessed from a category. The log never carries the body.
function captureInvalidOutput(dir: string | undefined, category: string, text: string): string | undefined {
  if (!dir) return undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${category}.txt`);
    writeFileSync(file, text, { mode: 0o600 });
    return file;
  } catch { return undefined; }
}

const OPAQUE_ITEM_TYPES = new Set(['compaction', 'compaction_summary', 'context_compaction', 'encrypted_content', 'reasoning']);
const MEDIA_PART_TYPES = new Set(['input_audio', 'audio', 'input_file', 'file']);
const isOpaque = (value: JsonRecord): boolean => OPAQUE_ITEM_TYPES.has(String(value.type)) || typeof value.encrypted_content === 'string';
// Inline PNG/JPEG/GIF/WebP data URLs are forwarded to the bridge as SelectedImages (the same path the
// Cursor app uses for pasted screenshots). Share the prompt's typed/MCP/legacy-computer recognition;
// ordinary tool metadata containing image_url or file_id is text, not an attachment.
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
      stats.replaced++; return { type: 'input_text', text: '[attachment omitted: the Cursor bridge accepts text and inline images only]' };
    }
    if (MEDIA_PART_TYPES.has(String(value.type))) { stats.replaced++; return { type: 'input_text', text: '[attachment omitted: the Cursor bridge accepts text and inline images only]' }; }
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
  let value:unknown;
  try {value=JSON.parse(readFileSync(options.authFile,'utf8'));} catch {throw new CursorError('Cursor SDK credential file is unreadable or invalid');}
  if (!isRecord(value) || typeof value.apiKey !== 'string' || !value.apiKey || value.email !== options.expectedEmail || value.backendUrl !== 'https://api2.cursor.sh' || (typeof value.apiKeyExpiresAtMs === 'number' && value.apiKeyExpiresAtMs <= Date.now())) throw new CursorError('Cursor SDK login is missing, expired or belongs to another account');
  return value.apiKey;
}

/** Decode Connect server frames incrementally; partial frames and keepalives are valid. */
export async function* connectFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<JsonRecord> {
  let pending = new Uint8Array(0), total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new CursorError('Cursor output exceeded safety limit');
    const joined = new Uint8Array(pending.length + chunk.length); joined.set(pending); joined.set(chunk, pending.length); pending = joined;
    while (pending.length >= 5) {
      const flags = pending[0]!; const length = new DataView(pending.buffer, pending.byteOffset + 1, 4).getUint32(0);
      if (length > MAX_BYTES || (flags !== 0 && flags !== 2)) throw new CursorError('Cursor returned an invalid Connect frame');
      if (pending.length < 5 + length) break;
      let value: unknown;
      try { value = JSON.parse(new TextDecoder().decode(pending.subarray(5, 5 + length))); } catch { throw new CursorError('Cursor returned invalid stream JSON'); }
      pending = pending.slice(5 + length);
      if (!isRecord(value)) throw new CursorError('Cursor returned an invalid stream record');
      if (flags === 2) {
        if (value.error) {
          if (CONTEXT_OVERFLOW_TEXT.test(JSON.stringify(value.error))) throw contextOverflowError('Cursor');
          // Connect `unavailable` (or a network message) means the bridge could not reach Cursor's
          // servers: the router's shared offline policy keeps the request pending and retries it.
          if (connectUnavailable(value.error)) throw new ProxyTransportError();
          const code = isRecord(value.error) && typeof value.error.code === 'string' ? value.error.code : 'unknown';
          const transient = ['internal', 'unknown', 'aborted', 'deadline_exceeded'].includes(code);
          logSafe('cursor-stream-refused', { code, transient });
          throw new CursorError('Cursor stream failed; no automatic supplier fallback', transient);
        }
      } else yield value;
    }
  }
  if (pending.length) throw new CursorError('Cursor stream ended with a partial frame');
}

/** A Connect error whose code or message says the upstream service could not be reached. */
function connectUnavailable(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  const message = isRecord(error) && typeof error.message === 'string' ? error.message : '';
  return code === 'unavailable' || transportError(new Error(message))?.reconnectable === true;
}

/**
 * Whether Cursor's API answers at all from this machine. The bridge reports its own failure to reach
 * Cursor as a bare 500 `internal` (2026-10-19: `Me` 500 while every OpenAI request was also failing
 * with status 0), so a persistent 5xx alone cannot tell an outage from a Cursor-side fault. Any HTTP
 * answer means the network is up; only a transport failure counts as unreachable.
 */
async function cursorUnreachable(): Promise<boolean> {
  try { await fetch(process.env.CURSOR_REACHABILITY_URL || 'https://api2.cursor.sh', { method: 'HEAD', signal: AbortSignal.timeout(5000) }); return false; }
  catch (error) { return !!transportError(error); }
}

export function assertCursorIdentity(value: unknown, options: Pick<CursorOptions, 'expectedEmail' | 'expectedUserId'>): void {
  const user = isRecord(value) && isRecord(value.user) ? value.user : undefined;
  if (!user || user.userEmail !== options.expectedEmail || String(user.userId) !== options.expectedUserId) throw new CursorError('Cursor authenticated account differs from the pinned identity');
}

// Account/catalog lookups have a much lower rate limit than agent inference. Validate once per
// credential and pins, share concurrent lookups, and refresh after five minutes. A rotated key or
// changed identity pin never reuses another account's proof. Server access policy remains decisive.
type CursorRpc = (service:string, method:string, body:JsonRecord) => Promise<Response>;
type CursorProfileProof = { expires:number; value:Promise<JsonRecord>; cancelled:boolean };
const profileCache = new Map<string, CursorProfileProof>();
export async function verifyCursorProfile(options:Pick<CursorOptions,'expectedEmail'|'expectedUserId'|'binaryHash'>, key:string, rpc:CursorRpc, signal?:AbortSignal):Promise<JsonRecord> {
  signal?.throwIfAborted();
  const cacheKey = sha256(Buffer.from(key))+'|'+options.expectedEmail+'|'+options.expectedUserId+'|'+options.binaryHash;
  const previous = profileCache.get(cacheKey);
  let entry: CursorProfileProof;
  if (previous && previous.expires > Date.now()) entry = previous;
  else {
    const value = (async () => {
      assertCursorIdentity(await (await rpc('SdkCursorService','Me',{options:{apiKey:key}})).json(),options);
      const models:unknown = await (await rpc('SdkCursorService','ListModels',{options:{apiKey:key}})).json();
      if (!isRecord(models) || !Array.isArray(models.items)) throw new CursorError('Cursor returned an invalid model catalog');
      return models;
    })().catch((error: unknown) => {
      // A cancelled lookup owner's fetch must not poison uncancelled waiters. Only an actual abort
      // qualifies: identity/auth/quota/backend refusals retain their original terminal behaviour,
      // even if the owner also happened to cancel before the rejection was observed.
      entry.cancelled = !!signal?.aborted && !(error instanceof BackendError)
        && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'));
      if (profileCache.get(cacheKey) === entry) profileCache.delete(cacheKey);
      throw error;
    });
    entry = {expires:Date.now()+300_000,value,cancelled:false};
    if (profileCache.size >= 32) profileCache.delete(profileCache.keys().next().value!);
    profileCache.set(cacheKey,entry);
  }
  try {
    const result = await abortable(entry.value, signal);
    signal?.throwIfAborted();
    return result;
  } catch(error) {
    signal?.throwIfAborted();
    if (entry.cancelled) return verifyCursorProfile(options,key,rpc,signal);
    throw error;
  }
}

/**
 * The run record of a Cursor run that finished cleanly with the requested model and parameters.
 * Anything else throws a named CursorError, retryable only for provider-side transient failures.
 */
export function finishedRun(events: JsonRecord[], selection: JsonRecord, captureDir?: string): JsonRecord {
  const terminal = events.filter(event => isRecord(event.result));
  const result = terminal.length === 1 && isRecord(terminal[0]?.result) ? terminal[0].result : undefined;
  const run = result && isRecord(result.result) ? result.result : undefined;
  const done = events.at(-1)?.done;
  if (!result || result.status !== FINISHED || !run || run.status !== FINISHED || !isRecord(done) || done.runId !== result.runId || typeof run.result !== 'string') {
    // Name the lifecycle state so a failed run is diagnosable from the router log, and retry once
    // when Cursor itself reports a transient provider error, which is what native Codex does for
    // 429/5xx. The reason is Cursor's provider string, not model output, so it is safe to surface.
    const status = String(result?.status ?? 'missing').replace(/^RUN_LIFECYCLE_STATUS_/, '');
    const runStatus = String(run?.status ?? 'missing').replace(/^RUN_LIFECYCLE_STATUS_/, '');
    const reason = cursorRunReason(result, run, done);
    // An errored run that carries no reason at all (2026-10-15: status ERROR, every reason field
    // empty) is indistinguishable from a provider hiccup, and nothing has executed, so it gets the
    // same single fresh attempt. A run that names a non-transient reason is not retried. The raw
    // terminal frames are kept owner-only so the next opaque failure can be read, not guessed.
    const errored = runStatus !== 'FINISHED' || status !== 'FINISHED';
    const opaque = errored && !reason;
    const cancelled = /CANCELLED|CANCELED/.test(`${status} ${runStatus}`);
    const transient = !cancelled && (opaque || (!!reason && TRANSIENT_RUN_ERROR.test(reason)));
    const captured = captureInvalidOutput(captureDir, 'unfinished', JSON.stringify({ result, done, events }, null, 1).slice(0, 262_144));
    const keysOf = (value: unknown) => isRecord(value) ? Object.keys(value).sort().slice(0, 32) : [];
    logSafe('cursor-unfinished', { events: events.length, terminal: terminal.length, status, runStatus, hasDone: isRecord(done), doneMatches: isRecord(done) && !!result && done.runId === result.runId, resultType: typeof run?.result, reasonBytes: reason?.length ?? 0, opaque, transient, resultKeys: keysOf(result), runKeys: keysOf(run), doneKeys: keysOf(done), captured: !!captured });
    if (reason && CONTEXT_OVERFLOW_TEXT.test(reason)) throw contextOverflowError('Cursor');
    const detail = status === 'FINISHED' && runStatus === 'FINISHED' ? 'the run finished without a result' : `run status ${runStatus}${reason ? `: ${reason}` : opaque ? ' with no reason from Cursor' : ''}`;
    throw new CursorError(`Cursor did not finish successfully (${detail}); no automatic supplier fallback`, transient);
  }
  const sameModel = isRecord(run.model) && run.model.id === selection.id && Array.isArray(run.model.params) && Array.isArray(selection.params) && JSON.stringify([...run.model.params].sort((a,b) => String(isRecord(a) ? a.id : '').localeCompare(String(isRecord(b) ? b.id : '')))) === JSON.stringify([...selection.params].sort((a,b) => String(isRecord(a) ? a.id : '').localeCompare(String(isRecord(b) ? b.id : ''))));
  if (!sameModel) throw new CursorError('Cursor reported a different model or reasoning setting; request refused');
  return run;
}

type CursorBridge = {
  process: Bun.Subprocess<'ignore', 'ignore', 'pipe'>; dir: string; url: string; token: string;
  id: string; startupMs: number; dead: boolean; agentDirs: Map<string, string>; dispose(): Promise<void>;
};
/** A Cursor run that issued tool calls and holds its bridge until Codex returns their results. */
type RunSession = {
  run: NativeRun; lease: CursorLease<CursorBridge>; bridge: CursorBridge; key: string; agentId: string; runId: string;
  signature: string; historyHash: string; historyLength: number; lastEvent: number; done: boolean;
  events: JsonRecord[]; stream: AbortController; heldSince?: number; expiry?: ReturnType<typeof setTimeout>; ended?: Promise<void>;
};

/** Prompt and output tokens of the latest model call a Cursor usage record describes. */
function usageTokens(usage: JsonRecord | undefined): { input: number; output: number } | undefined {
  if (!usage) return undefined;
  const input = Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0) + Number(usage.cacheWriteTokens ?? 0), output = Number(usage.outputTokens ?? 0);
  return [input, output].every(n => Number.isSafeInteger(n) && n >= 0) ? { input, output } : undefined;
}
export type CursorBackend = SubscriptionBackend & { close(): Promise<void> };
// A normal process.exit must not orphan parked bridges. Track immediately after spawn, including
// children still waiting for their handshake; asynchronous directory cleanup is handled in dispose.
const residentBridges = new Set<CursorBridge['process']>();
process.once('exit', () => {
  for (const child of residentBridges) { try { child.kill(); } catch {} }
});

/** Bind a continuation to the exact text and images the bridge can read. Responses metadata
 * (IDs, status, annotations, input_text vs output_text) can be reserialized by Codex. */
function historyHash(items: unknown[]): string {
  const prepared = preparePrompt({ model: '', input: items as ResponsesRequest['input'] });
  return sha256(JSON.stringify(prepared));
}
function sessionSignature(request: ResponsesRequest, selection: JsonRecord): string {
  return JSON.stringify({ selection, instructions: request.instructions, tools: requestTools(request), toolChoice: request.tool_choice, outputLimit: request.max_output_tokens });
}
const TOOL_RESULTS = new Set(['function_call_output', 'custom_tool_call_output', 'computer_call_output', 'tool_search_output']);

class CursorRuntime {
  private readonly pool: CursorBridgePool<CursorBridge>;
  private readonly callbacks = new NativeCallbackServer();
  private readonly heldRuns = new Map<string, RunSession>();
  readonly options: Readonly<CursorOptions>;
  constructor(options: CursorOptions) {
    this.options = Object.freeze({ ...options });
    this.pool = new CursorBridgePool(
      Math.min(32, positiveInt('CURSOR_MAX_BRIDGES', 8)), positiveInt('CURSOR_BRIDGE_IDLE_MS', 120_000),
      (key, signal) => this.startBridge(key, signal), bridge => bridge.dispose(),
      bridge => !bridge.dead && bridge.process.exitCode === null,
      // One idle bridge per login outlives the short window, so a pause between messages reuses it.
      nonNegativeInt('CURSOR_WARM_BRIDGES', 1), positiveInt('CURSOR_WARM_BRIDGE_IDLE_MS', 900_000),
    );
  }
  async close(): Promise<void> {
    await Promise.all([...new Set(this.heldRuns.values())].map(session => this.endRun(session, 'Router shutting down', true)));
    this.callbacks.stop();
    return this.pool.close();
  }
  /** Starts a bridge when a chat opens, so its first turn skips the cold start. Never throws. */
  prewarm(): void {
    try { this.pool.prewarm(readCursorKey(this.options)); } catch {}
  }
  private async startBridge(key: string, signal?: AbortSignal): Promise<CursorBridge> {
    const options = this.options;
    const started = performance.now();
    if (pinnedFileHash(options.binary) !== options.binaryHash) throw new CursorError('Cursor pinned bridge changed; backend paused');
    const dir = await mkdtemp(join(options.cwd, 'request-')); await chmod(dir, 0o700);
    let process: CursorBridge['process'];
    try {
      signal?.throwIfAborted();
      process = Bun.spawn([options.binary, '--host', '127.0.0.1', '--port', '0', '--workspace', dir, '--state-root', join(dir, 'store'), '--local-store', JSON.stringify({ type: 'jsonl', rootDir: join(dir, 'store') })], { cwd: dir, env: cursorEnvironment(key), stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
      residentBridges.add(process);
      const remove = () => { residentBridges.delete(process); };
      void process.exited.then(remove, remove);
    } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
    const bridge: CursorBridge = {
      process, dir, url: '', token: '', id: randomId('bridge'), startupMs: 0, dead: false, agentDirs: new Map(),
      dispose: () => {
        if (disposal) return disposal;
        bridge.dead = true;
        disposal = (async () => {
          try { process.kill(); } catch { logSafe('cursor-cleanup-failed', { bridge_id: bridge.id, stage: 'kill' }); }
          try { await process.exited; } catch { logSafe('cursor-cleanup-failed', { bridge_id: bridge.id, stage: 'exit' }); }
          try { await rm(dir, { recursive: true, force: true }); } catch { logSafe('cursor-cleanup-failed', { bridge_id: bridge.id, stage: 'directory' }); }
        })();
        return disposal;
      },
    };
    let disposal: Promise<void> | undefined;
    const abort = () => { void bridge.dispose(); };
    signal?.addEventListener('abort', abort, { once: true });
    let startup: ReturnType<typeof setTimeout> | undefined;
    try {
      const info = await new Promise<JsonRecord>((resolve, reject) => {
        const startupMs = positiveInt('CURSOR_STARTUP_TIMEOUT_MS', 60_000);
        startup = setTimeout(() => { logSafe('cursor-startup-timeout', { startupMs }); void bridge.dispose(); reject(new CursorError('Cursor bridge startup timed out', true)); }, startupMs);
        void (async () => {
          let line = '', bytes = 0, found = false;
          try {
            for await (const chunk of process.stderr) {
              bytes += chunk.length;
              if (bytes > MAX_BYTES) throw new CursorError('Cursor diagnostics exceeded safety limit');
              line += new TextDecoder().decode(chunk);
              let boundary: number;
              while ((boundary = line.indexOf('\n')) >= 0) {
                const current = line.slice(0, boundary); line = line.slice(boundary + 1);
                if (!found && current.startsWith('cursor-sdk-bridge ready ')) {
                  const value: unknown = JSON.parse(current.slice(24));
                  if (!isRecord(value)) throw new Error('invalid handshake');
                  found = true; clearTimeout(startup); resolve(value);
                }
              }
              if (line.length > 65536) throw new Error('diagnostic line exceeded limit');
            }
            if (!found) reject(new CursorError('Cursor bridge exited before ready'));
          } catch { void bridge.dispose(); reject(new CursorError('Cursor bridge startup or diagnostics failed')); }
        })();
      });
      signal?.throwIfAborted();
      if (info.schemaVersion !== 1 || info.host !== '127.0.0.1' || info.protocol !== 'connect' || info.transport !== 'tcp' || typeof info.port !== 'number' || typeof info.authTokenFile !== 'string' || typeof info.url !== 'string' || info.url !== `http://127.0.0.1:${info.port}`) throw new CursorError('Cursor returned an invalid local handshake');
      bridge.url = info.url; bridge.token = (await readFile(info.authTokenFile, 'utf8')).trim();
      // Every bridge sends custom tool calls to this login's callback endpoint.
      await this.rpc(bridge, 'SdkBridgeControlService', 'SetToolCallback', { url: this.callbacks.url(), authToken: this.callbacks.token }, signal ?? AbortSignal.timeout(10_000));
      const exited = () => { bridge.dead = true; };
      void process.exited.then(exited, exited);
      bridge.startupMs = performance.now() - started;
      logSafe('cursor-bridge-started', { bridge_id: bridge.id, startup_ms: Math.round(bridge.startupMs) });
      return bridge;
    } catch (error) { await bridge.dispose(); signal?.throwIfAborted(); throw error; }
    finally { clearTimeout(startup); signal?.removeEventListener('abort', abort); }
  }
  private async rpc(bridge: CursorBridge, service: string, method: string, body: JsonRecord, signal: AbortSignal, stream = false): Promise<Response> {
    const json = Buffer.from(JSON.stringify(body));
    const header = Buffer.alloc(5); header.writeUInt32BE(json.length, 1);
    const backoff = positiveInt('CURSOR_RPC_RETRY_MS', 1000);
    for (let tries = 1; ; tries++) {
      let response: Response;
      try {
        response = await fetch(`${bridge.url}/sdk.v1.${service}/${method}`, { method: 'POST', signal, headers: { authorization: `Bearer ${bridge.token}`, 'content-type': stream ? 'application/connect+json' : 'application/json', 'connect-protocol-version': '1' }, body: stream ? Buffer.concat([header, json]) : json });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new CursorError('Cursor bridge connection failed; no automatic supplier fallback', true);
      }
      if (response.ok) return response;
      const detail: unknown = await response.json().catch(() => undefined);
      const code = isRecord(detail) && typeof detail.code === 'string' ? detail.code.replace(/[^a-z_]/g, '').slice(0, 64) : 'unknown';
      if (isRecord(detail) && typeof detail.message === 'string' && CONTEXT_OVERFLOW_TEXT.test(detail.message)) throw contextOverflowError('Cursor');
      if (connectUnavailable(detail)) throw new ProxyTransportError();
      const transient = response.status >= 500;
      if (transient && !stream && tries < 3) {
        logSafe('cursor-rpc-retry', { service, method, status: response.status, code, attempt: tries });
        await sleep(backoff * 2 ** (tries - 1), signal);
        continue;
      }
      const offline = transient && await cursorUnreachable();
      logSafe('cursor-rpc-refused', { service, method, status: response.status, code, transient, offline, tries });
      if (offline) throw new ProxyTransportError();
      throw new CursorError(`Cursor SDK request refused (HTTP ${response.status}, ${code}); no automatic supplier fallback`, transient);
    }
  }
  private async closeAgent(bridge: CursorBridge, agentId: string): Promise<void> {
    if (!agentId) return;
    const response = await fetch(`${bridge.url}/sdk.v1.SdkAgentService/CloseAgent`, { method: 'POST', signal: AbortSignal.timeout(2000), headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agentId }) });
    if (!response.ok) throw new CursorError('Cursor agent cleanup failed', true);
    const dir = bridge.agentDirs.get(agentId);
    if (dir) { await rm(dir, { recursive: true, force: true }); bridge.agentDirs.delete(agentId); }
  }

  /**
   * One Codex turn on the native path. A request that carries the results of calls a live run is
   * holding continues that run; anything else starts a fresh agent with the full history. The turn
   * ends when the model has issued its calls (they go to Codex) or the run finishes.
   */
  async run(request: ResponsesRequest, signal?: AbortSignal): Promise<ProxyOutput> {
    const started = performance.now(), requestId = randomId('cursor');
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
        session.run.answer(continuation.results);
      } else {
        session = await this.startRun(request, selection, signature, combined);
      }
      setupMs = performance.now() - started;
      const step = await session.run.next(combined);
      calls = step.calls.length;
      const inputTokens = Math.max(estimateVisibleTokens(requestToPrompt(request, { tools: false })), usageTokens(step.usage)?.input ?? 0);
      const outputTokens = Math.max(estimateVisibleTokens(step.text + JSON.stringify(step.calls)), usageTokens(step.usage)?.output ?? 0);
      const output: ProxyOutput = { text: step.text, toolCalls: step.calls, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
      if (step.calls.length && Array.isArray(request.input)) this.holdRun(session, request, output, signature);
      // Output returns at once; the lease stays held until CloseAgent finishes, so nothing races it.
      else void this.endRun(session, 'Cursor turn finished', false);
      success = true;
      return output;
    } catch (error) {
      if (session) await this.endRun(session, 'Cursor turn failed', true);
      if (timedOut) throw new CursorError(`Cursor request timed out after ${Math.round(idleMs / 1000)}s without output; no automatic supplier fallback`, true);
      throw error;
    } finally {
      clearInterval(idle);
      logSafe('cursor-turn', { request_id: requestId, bridge_id: session?.bridge.id, model: request.model, continued: !!continuation, success, calls, setup_ms: Math.round(setupMs), elapsed_ms: Math.round(performance.now() - started) });
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
    try { key = readCursorKey(this.options); } catch (error) { void this.endRun(session, 'The Cursor credential changed', false); throw error; }
    const pending = session.run.pending();
    const suffix = request.input.slice(session.historyLength);
    const answers = suffix.every(item => TOOL_RESULTS.has(item.type ?? '') && item.type !== 'tool_search_output' && pending.includes(item.call_id ?? ''));
    const matches = key === session.key && session.signature === signature && suffix.length > 0 && answers && pending.every(id => suffix.some(item => item.call_id === id))
      && historyHash(request.input.slice(0, session.historyLength)) === session.historyHash;
    if (!matches) {
      // A changed history, a tool search (new tools) or a user message mid-run: replay instead.
      logSafe('cursor-replay', { signature: session.signature === signature, answers });
      void this.endRun(session, 'The conversation changed; this run was replaced', false);
      return undefined;
    }
    return { session, results: new Map(suffix.map(item => [item.call_id!, toolResult(item)])) };
  }

  private async startRun(request: ResponsesRequest, selection: JsonRecord, signature: string, signal: AbortSignal): Promise<RunSession> {
    await this.reclaimHeld();
    const key = readCursorKey(this.options);
    const lease = await this.pool.acquire(key, signal);
    const bridge = lease.value;
    let agentId = '';
    try {
      signal.throwIfAborted();
      if (lease.reused && pinnedFileHash(this.options.binary) !== this.options.binaryHash) throw new CursorError('Cursor pinned bridge changed; backend paused');
      if (readCursorKey(this.options) !== key) throw new CursorError('Cursor credential changed while queued; retry the turn', true);
      const rpc = (service: string, method: string, body: JsonRecord) => this.rpc(bridge, service, method, body, signal);
      const models = await verifyCursorProfile(this.options, key, rpc, signal);
      const discovered = isRecord(models) && Array.isArray(models.items) ? models.items.find(item => isRecord(item) && item.id === request.model) : undefined;
      if (!isRecord(discovered) || !Array.isArray(discovered.parameters)) throw new CursorError('Requested model is unavailable on the pinned Cursor account');
      const definitions = discovered.parameters;
      if ((selection.params as Array<{ id: string; value: string }>).some(param => !definitions.some(def => isRecord(def) && def.id === param.id && Array.isArray(def.values) && def.values.some(v => isRecord(v) && v.value === param.value)))) throw new CursorError('Requested Cursor parameters are unavailable');
      const tools = nativeTools(toolDescriptors(requestTools(request)));
      const hasTools = tools.byKey.size > 0;
      const agentDir = await mkdtemp(join(bridge.dir, 'agent-')); await chmod(agentDir, 0o700);
      // Only the MCP group is allowed, and the only MCP server is the router's: no shell, edit, read,
      // web or subagent tool exists for this agent. Without Codex tools even that group is off.
      const created: unknown = await (await rpc('SdkAgentService', 'CreateAgent', { options: { apiKey: key, model: selection, tools: { names: hasTools ? ['mcp'] : [] }, disallowedTools: ['task'], local: { cwd: [agentDir], settingSources: [], ...(hasTools ? { customTools: tools.definitions } : {}) } } })).json();
      if (!isRecord(created) || typeof created.agentId !== 'string') throw new CursorError('Cursor agent creation failed');
      agentId = created.agentId;
      bridge.agentDirs.set(agentId, agentDir);
      const run = new NativeRun(tools.byKey, nonNegativeInt('CURSOR_TOOL_SETTLE_MS', 350));
      const session: RunSession = { run, lease, bridge, key, agentId, runId: '', signature, historyHash: '', historyLength: 0, lastEvent: performance.now(), done: false, events: [], stream: new AbortController() };
      this.callbacks.register(agentId, run);
      const prepared = preparePrompt(request, { tools: false });
      const images = prepared.images.map(image => ({ data: { data: image.source.data, mimeType: image.source.media_type } }));
      if (images.length) logSafe('cursor-images-attached', { count: images.length });
      const text = [nativeRules(rawInputTools(tools.byKey)), nativeToolList(tools.definitions), prepared.prompt].filter(Boolean).join('\n\n');
      // The stream outlives this request when the run holds tool calls, so only ending the session
      // cuts it; this request's cancellation ends the session (and so the stream) in runNative.
      const cancel = () => session.stream.abort(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      let response: Response;
      try { response = await this.rpc(bridge, 'SdkAgentService', 'Send', { agentId, message: images.length ? { text, images } : { text }, options: { enableSteps: true } }, session.stream.signal, true); }
      finally { signal.removeEventListener('abort', cancel); }
      if (!response.body) throw new CursorError('Cursor returned an empty stream');
      void this.readRun(session, response.body, selection);
      return session;
    } catch (error) {
      if (agentId) await this.closeAgent(bridge, agentId).catch(() => {});
      await lease.discard();
      throw error;
    }
  }

  /** Feeds a run's stream into its NativeRun: text, guarded tool events, usage and the terminal result. */
  private async readRun(session: RunSession, body: ReadableStream<Uint8Array>, selection: JsonRecord): Promise<void> {
    const { run } = session;
    try {
      for await (const event of connectFrames(body)) {
        session.lastEvent = performance.now();
        const sdk = isRecord(event.sdkMessage) ? event.sdkMessage : undefined;
        const message = sdk && isRecord(sdk.message) ? sdk.message : undefined;
        if (message && typeof message.run_id === 'string') session.runId = message.run_id;
        if (isRecord(event.result) || isRecord(event.done)) session.events.push(event);
        const step = isRecord(event.step) && isRecord(event.step.step) ? event.step.step : undefined;
        const stepType = String(step?.type ?? '');
        // Only calls to the router's own MCP server are allowed; anything else is a native action.
        const containsNative = (v: unknown): boolean => Array.isArray(v) ? v.some(containsNative) : isRecord(v) ? v.type === 'tool_use' || Object.values(v).some(containsNative) : false;
        if (sdk && containsNative(sdk.message)) throw new CursorError('Cursor attempted a native tool; it was stopped and no Codex actions were returned');
        if (message?.type === 'tool_call') {
          const args = isRecord(message.args) ? message.args : {};
          if (message.name !== 'mcp' || args.providerIdentifier !== CUSTOM_TOOLS_PROVIDER) throw new CursorError('Cursor attempted a native action; it was stopped and no Codex actions were returned');
        } else if (sdk && /^(task|compaction|summary)/.test(String(sdk.type))) throw new CursorError('Cursor attempted native subagents or compaction; no Codex actions were returned');
        if (stepType === 'toolCall' ? !(isRecord(step?.message) && step.message.type === 'mcp') : /shell|task|summary|compact/i.test(stepType)) throw new CursorError('Cursor attempted a native action; it was stopped and no Codex actions were returned');
        if (message?.type === 'assistant' && isRecord(message.message) && Array.isArray(message.message.content)) {
          for (const part of message.message.content) if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') run.appendText(part.text);
        }
        if (message?.type === 'usage' && isRecord(message.usage)) run.usage = message.usage;
      }
      const record = finishedRun(session.events, selection, join(dirname(this.options.cwd), 'invalid-output'));
      if (isRecord(record.usage) && !run.usage) run.usage = record.usage;
      session.done = true;
      run.finish();
    } catch (error) {
      session.done = true;
      if (error instanceof ProxyTransportError || error instanceof BackendError) run.fail(error);
      else run.fail(transportError(error) ? new CursorError('Cursor bridge stream dropped; no automatic supplier fallback', true) : error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Keeps the run and its bridge until Codex returns these calls' results, or the session expires. */
  private holdRun(session: RunSession, request: ResponsesRequest, output: ProxyOutput, signature: string): void {
    const prior = [...(request.input as unknown[]), ...responseObject(request, output).output];
    session.signature = signature;
    session.historyHash = historyHash(prior);
    session.historyLength = prior.length;
    session.heldSince = Date.now();
    for (const call of output.toolCalls) if (call.callId) this.heldRuns.set(call.callId, session);
    session.expiry = setTimeout(() => void this.endRun(session, 'Codex did not return the tool results in time', false), positiveInt('CURSOR_SESSION_IDLE_MS', 900_000));
    session.expiry.unref?.();
  }

  /**
   * Held runs wait on Codex, not on Cursor. When they occupy every bridge the cap allows, the one
   * waiting longest gives its bridge to new work; if Codex later returns its results, they replay.
   */
  private async reclaimHeld(): Promise<void> {
    const max = Math.min(32, positiveInt('CURSOR_MAX_BRIDGES', 8));
    const held = [...new Set(this.heldRuns.values())].filter(session => session.heldSince !== undefined && !session.ended);
    if (held.length < max) return;
    const oldest = held.reduce((a, b) => (a.heldSince! <= b.heldSince! ? a : b));
    logSafe('cursor-reclaimed', { held: held.length, held_ms: Date.now() - oldest.heldSince! });
    await this.endRun(oldest, 'Its bridge was needed for another turn; this run will be replayed if continued', false);
  }

  /** Ends a run: held callbacks are released, an unfinished run is cancelled, the bridge is returned. */
  private endRun(session: RunSession, reason: string, discard: boolean): Promise<void> {
    if (session.ended) return session.ended;
    clearTimeout(session.expiry);
    for (const [callId, owner] of this.heldRuns) if (owner === session) this.heldRuns.delete(callId);
    session.run.close(reason);
    this.callbacks.unregister(session.agentId, session.run);
    const { bridge, lease, agentId } = session;
    session.ended = (async () => {
      try {
        if (!session.done && session.runId) await fetch(`${bridge.url}/sdk.v1.SdkAgentService/CancelRun`, { method: 'POST', signal: AbortSignal.timeout(2000), headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agentId, runId: session.runId }) });
        session.stream.abort();
        if (discard || bridge.dead) { await lease.discard(); return; }
        await this.closeAgent(bridge, agentId);
        lease.release();
      } catch {
        logSafe('cursor-cleanup-failed', { stage: 'native-end' });
        await lease.discard();
      }
    })();
    return session.ended;
  }
}

export function createCursorBackend(options: CursorOptions): CursorBackend {
  if (![options.binary, options.authFile, options.cwd].every(isAbsolute) || !/^[a-z][a-z0-9-]*$/.test(options.prefix) || ['gpt','grok','claude'].includes(options.prefix) || !options.expectedEmail || !options.expectedUserId || !/^[a-f0-9]{64}$/.test(options.binaryHash)) throw new Error('Cursor requires absolute paths, a pinned bridge, account identity and a model namespace');
  const exposed: CursorModel[] = ['kimi-k3', 'grok-4.7', 'claude-opus-5-5', 'muse-wonder-1.0'];
  const runtime = new CursorRuntime(options);
  return {
    name: `Cursor (${options.label})`, reservedPrefix: `${options.prefix}-`,
    models: Object.fromEntries(exposed.map(model => [`${options.prefix}-${model}`, model])),
    catalog: exposed.map(model => ({ slug: `${options.prefix}-${model}`, displayName: `${CURSOR_MODELS[model].name} (${options.label})`, description: `Your subscription through Cursor; Codex executes tools.`, efforts: CURSOR_MODELS[model].efforts, defaultEffort: 'high', inputModalities: CURSOR_MODELS[model].vision ? ['text', 'image'] : ['text'], contextWindow: CURSOR_MODELS[model].window })),
    // Transient provider failures (an errored run, a dropped stream, a slow startup) get one fresh attempt.
    run: (request, signal) => retryOnce('Cursor', signal, () => runtime.run(request, signal)),
    prewarm: () => runtime.prewarm(),
    close: () => runtime.close(),
  };
}
export function configuredCursorBackend(env: Readonly<Record<string, string | undefined>> = process.env): CursorBackend | undefined {
  if (!env.CURSOR_BRIDGE_BIN) return undefined;
  return createCursorBackend({ binary: env.CURSOR_BRIDGE_BIN, binaryHash: env.CURSOR_BRIDGE_SHA256 ?? '', authFile: env.CURSOR_AUTH_FILE ?? '', cwd: env.CURSOR_CWD ?? '', expectedEmail: env.CURSOR_EXPECTED_EMAIL ?? '', expectedUserId: env.CURSOR_EXPECTED_USER_ID ?? '', prefix: env.CURSOR_MODEL_PREFIX || 'cursor', label: env.CURSOR_LABEL || 'Cursor', fastest: env.CURSOR_SPEED_POLICY === 'fastest' });
}
