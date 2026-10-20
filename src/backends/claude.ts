import { realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, isAbsolute } from 'node:path';
// Claude through the official Claude Code CLI. Each turn is one `claude -p` stream-json session
// with every native tool disabled; Codex's tools are described in the prompt and requested
// through structured output. A session that returned tool calls stays alive briefly so the next
// turn only has to send the tool results.
import { positiveInt } from '../env';
import { isRecord, randomId } from '../json';
import { logSafe } from '../log';
import { continuationRequest, type ImageBlock, outputSchema, preparePrompt, requestToPrompt, toolDescriptors } from '../protocol/prompt';
import type { ProxyOutput, ResponsesRequest } from '../protocol/types';
import { transportError } from '../transport';
import { claudeLimits, ClaudeUsageLimits, ClaudeUsageLimitError } from './claude-limits';
import { BackendError, CONTEXT_OVERFLOW_TEXT, contextOverflowError, estimateVisibleTokens, OVERLOADED_TEXT, overloadedError, type SubscriptionBackend } from './contract';

const MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  'claude-opus': 'opus',
  'claude-sonnet': 'sonnet',
  'claude-haiku': 'haiku',
};
// Every level the pinned Claude CLI accepts (`claude --help`: low, medium, high, xhigh, max).
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const SYSTEM_PROMPT = `You are running inside a Codex agent loop. Tools described in <available_tools> are real, available Codex tools even though they are not present in Claude Code's native tool registry. Invoke them by returning their exact name and arguments in the required structured tool_calls output. Never claim that a listed Codex tool is unavailable merely because it is absent from the native registry. When a Codex browser, node_repl, cua_repl, or computer tool is listed, use it for browser requests instead of substituting WebFetch, web search, curl, or another native tool.`;

const USAGE_LIMIT_TEXT = /you['’]ve hit your (?:session|weekly|usage) limit|usage limit reached/i;

type ClaudeResult = {
  type: 'result';
  subtype?: string;
  is_error: boolean;
  result?: string;
  structured_output?: StructuredOutput;
  usage?: unknown;
};
type StructuredOutput = { text: string; tool_calls: Array<{ name: string; arguments: string }> };

/**
 * Token counts of the last API call behind a CLI result. Anthropic's `input_tokens` excludes cached
 * tokens, so the prompt the model actually held is input + cache creation + cache reads; the per-call
 * breakdown lives in `usage.iterations` and the top level is the turn total. Each `result` is one
 * turn, not the session, so this never accumulates across a worker's continuation turns.
 */
export function reportedUsage(usage: unknown): { promptTokens: number; outputTokens: number } | undefined {
  if (!isRecord(usage)) return undefined;
  const iterations = Array.isArray(usage.iterations) ? usage.iterations.filter(isRecord) : [];
  const last = iterations.length ? iterations[iterations.length - 1] : usage;
  const count = (key: string): number => (typeof last[key] === 'number' && last[key] > 0 ? last[key] : 0);
  const promptTokens = count('input_tokens') + count('cache_creation_input_tokens') + count('cache_read_input_tokens');
  return promptTokens > 0 ? { promptTokens, outputTokens: count('output_tokens') } : undefined;
}

export function resolveEffort(request: ResponsesRequest): string {
  const effort = request.reasoning?.effort ?? 'high';
  if (!(EFFORTS as readonly string[]).includes(effort)) throw new Error(`Unsupported staged effort: ${effort}`);
  return effort;
}

export function resolveModel(model: string): string {
  const resolved = MODEL_ALIASES[model] ?? model;
  const known = resolved.startsWith('claude-') || ['opus', 'sonnet', 'haiku'].includes(resolved);
  if (!/^[a-zA-Z0-9._-]+$/.test(resolved) || !known) throw new Error(`Unsupported Claude model: ${model}`);
  return resolved;
}

/** CLI flags for an isolated session: no tools, MCP, hooks, settings, slash commands or history. */
export function buildClaudeArgs(request: ResponsesRequest): string[] {
  return [
    '-p',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--settings',
    '{"disableAllHooks":true,"fastMode":false}',
    '--no-chrome',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // Partial chunks keep stdout live while the model thinks, so the turn can be bounded by
    // silence (native Codex's 300 s stream idle timeout) instead of a total deadline that
    // cuts long xhigh turns. `acceptLine` ignores every record type it does not settle on.
    '--include-partial-messages',
    '--verbose',
    '--model',
    resolveModel(request.model),
    '--effort',
    resolveEffort(request),
    '--append-system-prompt',
    SYSTEM_PROMPT,
    '--json-schema',
    JSON.stringify(outputSchema(request.tools ?? [])),
  ];
}

export type ClaudeAccountOptions = {
  configDir?: string; binary?: string; cwd?: string;
  expectedEmail?: string; expectedOrg?: string;
};

/**
 * Wall-clock budget for one `claude auth status` probe. The CLI answers in well under a second on an
 * idle machine, but under swap pressure or a busy router its startup and teardown each stretch past
 * twenty seconds (observed 20.1-23.4 s on October 11-15, 2026). The budget only bounds a probe that
 * never answers; a probe whose answer arrived is accepted even if its teardown ran past the budget.
 */
const IDENTITY_PROBE_TIMEOUT_MS = 45_000;

/**
 * How long a verified identity vouches for a probe that stalled without answering. Under heavy load
 * (October 17, 2026: load average 13 during a disk cleanup) `claude auth status` printed nothing for
 * the full 45 s budget and a healthy Poly turn was refused. A stall says nothing about the login; only
 * a parsed answer can show a mismatch or a logout, and either one clears the verification.
 */
const IDENTITY_STALL_GRACE_MS = 6 * 60 * 60_000;

/** Each login owns its warm workers, quota snapshot and usage sink. */
export class ClaudeAccount {
  readonly workers = new Map<string, ClaudeWorker>();
  rateLimitSink?: (info: unknown) => void;
  readonly options: Readonly<ClaudeAccountOptions>;
  private verifiedAt = 0;
  constructor(options: ClaudeAccountOptions = {}, readonly limits = new ClaudeUsageLimits()) { this.options = Object.freeze({...options}); }
  onRateLimit(sink: (info: unknown) => void): void { this.rateLimitSink = sink; }
  environment(): Record<string, string> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined &&
      !['CLAUDECODE', 'PROXY_API_KEY', 'CLAUDE_CODE_EFFORT_LEVEL', 'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
        'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_HOST_GATEWAY', 'CLAUDE_CODE_HOST_GATEWAY_LINEAGE'].includes(key))) as Record<string, string>;
    if (this.options.configDir) env.CLAUDE_CONFIG_DIR = this.options.configDir;
    return env;
  }
  binary(): string { return this.options.binary ?? process.env.CLAUDE_BIN ?? 'claude'; }
  async verifyIdentity(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.options.expectedEmail && !this.options.expectedOrg) return;
    const started = Date.now();
    const child = Bun.spawn([this.binary(), 'auth', 'status'], {env: this.environment(), stdout: 'pipe', stderr: 'pipe', timeout: IDENTITY_PROBE_TIMEOUT_MS, signal});
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited, new Response(child.stderr).text()]);
    // A cancelled turn kills the probe (SIGTERM, exit 143); that is the caller's abort, not an account problem.
    signal?.throwIfAborted();
    let status: unknown;
    try { status = JSON.parse(output); } catch {}
    const info = isRecord(status) ? status : undefined;
    const emailMatch = !this.options.expectedEmail || info?.email === this.options.expectedEmail;
    const orgMatch = !this.options.expectedOrg || info?.orgId === this.options.expectedOrg;
    const answered = !!info?.loggedIn && emailMatch && orgMatch;
    if (exitCode === 0 && answered) { this.verifiedAt = Date.now(); return; }
    // Bun reports the spawn-timeout SIGTERM as exit 143 and leaves `signalCode` null, so both spellings
    // mean "our own deadline killed it". When the full answer had already been written before that kill
    // (stdout parsed, logged in, email and org match), the account is verified: the CLI's slow teardown
    // under machine stall is not evidence about the login, and refusing it fails a healthy turn.
    const killed = child.signalCode !== null || exitCode === 143;
    if (killed && answered) {
      this.verifiedAt = Date.now();
      logSafe('claude-identity-check-slow', { ms: Date.now() - started, exit: exitCode });
      return;
    }
    // A probe killed before it wrote anything is a machine stall. A recent verification of this same
    // login still stands; any parsed answer that is not a match means the login changed and clears it.
    if (info) this.verifiedAt = 0;
    else if (killed && this.verifiedAt && Date.now() - this.verifiedAt < IDENTITY_STALL_GRACE_MS) {
      logSafe('claude-identity-check-stale', { ms: Date.now() - started, exit: exitCode, verified_ago_ms: Date.now() - this.verifiedAt });
      return;
    }
    // Content-free diagnostics: which condition failed and how long the probe took, never the identity values.
    logSafe('claude-identity-check-failed', { exit: exitCode, killed, ms: Date.now() - started, parsed: !!info, logged_in: !!info?.loggedIn, email_match: emailMatch, org_match: orgMatch });
    // Only a parsed, logged-in answer with the wrong email/org is an identity mismatch. A killed probe (the
    // spawn timeout under machine stall), a non-zero exit or unreadable output is a probe failure and
    // must say so, or a transient stall reads as a login problem.
    if (killed) throw new BackendError(`Claude identity check was killed before it answered (claude auth status exceeded ${IDENTITY_PROBE_TIMEOUT_MS / 1000}s); retry the turn`);
    // The CLI exits 1 for a parsed logged-out answer, including when its credential store cannot be
    // read. Retrying the turn cannot repair that state; preserve the answer before the generic exit error.
    if (info?.loggedIn === false) throw new BackendError('Claude account is not logged in for this configuration, or its credential store is inaccessible; restore credential access or sign in again');
    if (exitCode !== 0) throw new BackendError(`Claude identity check failed (claude auth status exited ${exitCode}); retry the turn`);
    if (!info) throw new BackendError('Claude identity check returned unreadable output; retry the turn');
    if (!info.loggedIn) throw new BackendError('Claude account is not logged in for this configuration');
    throw new BackendError('Claude account identity does not match its configured login');
  }
  run(request: ResponsesRequest, signal?: AbortSignal): Promise<ProxyOutput> {
    // One attempt. A dropped connection surfaces as a transport error and the router's shared
    // offline policy (`localResponse`) keeps the request pending and retries it.
    return runClaudeOnce(request, signal, this);
  }
}

export const primaryClaudeAccount = new ClaudeAccount({expectedEmail: process.env.CLAUDE_EXPECTED_EMAIL, expectedOrg: process.env.CLAUDE_EXPECTED_ORG}, claudeLimits);
export function onClaudeRateLimit(sink: (info: unknown) => void): void { primaryClaudeAccount.onRateLimit(sink); }

type PendingTurn = { resolve: (result: ClaudeResult) => void; reject: (error: Error) => void };

class ClaudeWorker {
  readonly model: string;
  readonly signature: string;
  readonly callIds = new Set<string>();
  private readonly process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  private pending?: PendingTurn;
  private stderr = '';
  private idleTimer?: ReturnType<typeof setTimeout>;
  private touch?: () => void;
  private closed = false;

  constructor(request: ResponsesRequest, readonly account: ClaudeAccount) {
    this.model = request.model;
    this.signature = sessionSignature(request);
    this.process = Bun.spawn([account.binary(), ...buildClaudeArgs(request)], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: account.options.cwd ?? process.env.CLAUDE_CWD ?? process.cwd(),
      env: account.environment(),
    });
    const stdoutDone = this.readStdout().catch((cause: unknown) => this.fail(cause));
    void this.readStderr();
    void this.process.exited.then(async (exitCode) => {
      // Drain terminal rate-limit and result frames before treating the exit as a failure;
      // otherwise an exited CLI can race the reader and trigger an unsafe continuation replay.
      await stdoutDone;
      this.closed = true;
      this.detach();
      const pending = this.pending;
      this.pending = undefined;
      pending?.reject(new Error(this.stderr.trim() || `Claude CLI exited with code ${exitCode}`));
    });
  }

  run(prompt: string, images: ImageBlock[], signal?: AbortSignal): Promise<ClaudeResult> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Claude CLI worker is closed');
    if (this.pending) throw new Error('Claude CLI worker is already processing a turn');
    clearTimeout(this.idleTimer);
    // Bound the turn by silence, like native Codex (DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300 s): any
    // stdout byte restarts the window, and the idle timeout is retried like a dropped stream.
    const idleMs = positiveInt('CLAUDE_TIMEOUT_MS', 300_000);

    return new Promise<ClaudeResult>((resolve, reject) => {
      const settle = (error: Error) => {
        const pending = this.pending;
        this.pending = undefined;
        this.abort();
        pending?.reject(error);
      };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timeout);
        timeout = setTimeout(
          () => settle(new BackendError(`Claude CLI timed out after ${Math.round(idleMs / 1000)}s without output`, { retryable: true })),
          idleMs,
        );
      };
      this.touch = arm;
      arm();
      const cancel = () => settle(new Error('Claude request cancelled'));
      const cleanup = () => {
        clearTimeout(timeout);
        this.touch = undefined;
        signal?.removeEventListener('abort', cancel);
      };
      this.pending = {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      signal?.addEventListener('abort', cancel, { once: true });

      const message = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }, ...images] } };
      // The CLI can exit between the closed check and this write. A broken pipe must fail only this
      // turn: left uncaught, EPIPE takes down the whole router and every open chat with it.
      const brokenPipe = (cause: unknown) => this.fail(transportError(cause) ?? cause);
      try {
        for (const result of [this.process.stdin.write(`${JSON.stringify(message)}\n`), this.process.stdin.flush()]) {
          if (result instanceof Promise) result.catch(brokenPipe);
        }
      } catch (cause) {
        brokenPipe(cause);
      }
    });
  }

  /** Keeps the session for the turn that will carry these calls' results, until it idles out. */
  retainFor(callIds: string[]): void {
    this.detach();
    for (const callId of callIds) {
      this.callIds.add(callId);
      this.account.workers.set(callId, this);
    }
    this.idleTimer = setTimeout(() => this.close(), positiveInt('CLAUDE_SESSION_IDLE_MS', 900_000));
    this.idleTimer.unref?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.detach();
    try {
      this.process.stdin.end();
    } catch {}
  }

  private abort(): void {
    this.close();
    try {
      this.process.kill();
    } catch {}
  }

  private fail(cause: unknown): void {
    const pending = this.pending;
    this.pending = undefined;
    this.abort();
    pending?.reject(cause instanceof Error ? cause : new Error(String(cause)));
  }

  private detach(): void {
    for (const callId of this.callIds) {
      if (this.account.workers.get(callId) === this) this.account.workers.delete(callId);
    }
    this.callIds.clear();
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of this.process.stdout) {
      this.touch?.();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) this.acceptLine(line);
    }
    if (buffer) this.acceptLine(buffer);
  }

  private acceptLine(line: string): void {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return; // Non-JSON diagnostics from the CLI.
    }
    if (!isRecord(record)) return;
    if (record.type === 'rate_limit_event' && record.rate_limit_info) {
      this.account.limits.update(record.rate_limit_info);
      try {
        this.account.rateLimitSink?.(record.rate_limit_info);
      } catch {}
      return;
    }
    if (record.type === 'assistant' && record.error === 'rate_limit') {
      this.fail(this.account.limits.blocked(this.model) ?? new ClaudeUsageLimitError());
      return;
    }
    if (record.type !== 'result' || !this.pending) return;
    const pending = this.pending;
    this.pending = undefined;
    pending.resolve(record as ClaudeResult);
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.process.stderr) {
      this.stderr = (this.stderr + decoder.decode(chunk, { stream: true })).slice(-65_536);
    }
  }
}

/**
 * A session can only continue a turn whose tools, effort, instructions and compaction anchors are
 * unchanged. Anything else would leave the model working from stale context.
 */
function sessionSignature(request: ResponsesRequest): string {
  const anchors =
    typeof request.input === 'string'
      ? []
      : request.input
          .flatMap((item) =>
            typeof item.content === 'string' ? [item.content] : (item.content ?? []).map((part) => part.text ?? ''),
          )
          .filter(
            (text) =>
              text.startsWith('Earlier conversation context summary:') ||
              text.startsWith('VERBATIM_HISTORICAL_USER_REQUEST:'),
          );
  return JSON.stringify({
    tools: toolDescriptors(request.tools ?? []),
    effort: resolveEffort(request),
    instructions: request.instructions,
    anchors,
  });
}

async function startClaudeWorker(request: ResponsesRequest, account: ClaudeAccount, signal?: AbortSignal): Promise<ClaudeWorker> {
  await account.verifyIdentity(signal);
  signal?.throwIfAborted();
  return new ClaudeWorker(request, account);
}

/** The live session from this account that issued the newest tool call, if it can continue. */
function continuationWorker(request: ResponsesRequest, account: ClaudeAccount): ClaudeWorker | undefined {
  if (typeof request.input === 'string') return undefined;
  for (let index = request.input.length - 1; index >= 0; index--) {
    const callId = request.input[index]?.call_id;
    const worker = callId ? account.workers.get(callId) : undefined;
    if (worker?.model !== request.model) continue;
    if (worker.signature === sessionSignature(request)) return worker;
    worker.close();
    return undefined;
  }
  return undefined;
}

async function runTurn(request: ResponsesRequest, signal: AbortSignal | undefined, account: ClaudeAccount): Promise<{ worker: ClaudeWorker; result: ClaudeResult }> {
  const continuing = continuationWorker(request, account);
  const delta = continuing ? continuationRequest(request, continuing.callIds) : undefined;
  if (continuing && delta) {
    const prepared = preparePrompt(delta);
    try {
      return { worker: continuing, result: await continuing.run(prepared.prompt, prepared.images, signal) };
    } catch (error) {
      continuing.close();
      // A failed continuation is replayed in full, unless replaying cannot help.
      if (signal?.aborted || error instanceof ClaudeUsageLimitError || transportError(error)) {
        throw transportError(error) ?? error;
      }
    }
  } else {
    continuing?.close();
  }

  const prepared = preparePrompt(request);
  const worker = await startClaudeWorker(request, account, signal);
  try {
    return { worker, result: await worker.run(prepared.prompt, prepared.images, signal) };
  } catch (error) {
    worker.close();
    throw transportError(error) ?? error;
  }
}

function parseStructured(result: ClaudeResult): StructuredOutput {
  let value: unknown = result.structured_output;
  if (value === undefined) {
    try {
      value = JSON.parse(result.result ?? '{}');
    } catch {
      value = undefined;
    }
  }
  if (!isRecord(value) || typeof value.text !== 'string' || !Array.isArray(value.tool_calls)) {
    throw new Error('Claude CLI returned invalid structured output');
  }
  return value as StructuredOutput;
}

export async function runClaude(request: ResponsesRequest, signal?: AbortSignal): Promise<ProxyOutput> {
  return primaryClaudeAccount.run(request, signal);
}

async function runClaudeOnce(request: ResponsesRequest, signal: AbortSignal | undefined, account: ClaudeAccount): Promise<ProxyOutput> {
  signal?.throwIfAborted();
  account.limits.assertAvailable(request.model);
  const { worker, result } = await runTurn(request, signal, account);

  try {
    if (result.is_error) {
      if (USAGE_LIMIT_TEXT.test(result.result ?? '')) {
        throw account.limits.blocked(request.model) ?? new ClaudeUsageLimitError();
      }
      // Retrying the same oversized prompt can never succeed; give Codex its native overflow code.
      if (CONTEXT_OVERFLOW_TEXT.test(result.result ?? '')) throw contextOverflowError('Claude');
      if (OVERLOADED_TEXT.test(result.result ?? '')) throw overloadedError('Claude');
      const error = new Error(result.result || 'Claude CLI returned an error');
      throw transportError(error) ?? error;
    }
    const structured = parseStructured(result);
    const descriptors = new Map(toolDescriptors(request.tools ?? []).map((tool) => [tool.proxyName, tool.type]));
    for (const call of structured.tool_calls) {
      if (!descriptors.has(call.name)) throw new Error(`Claude CLI requested unavailable tool: ${call.name}`);
    }
    const toolCalls = structured.tool_calls.map((call) => ({ ...call, callId: randomId('call') }));

    // Tool search results change the tool list, so that session cannot continue.
    const canContinue = toolCalls.length > 0 && toolCalls.every((call) => descriptors.get(call.name) !== 'tool_search');
    if (canContinue) worker.retainFor(toolCalls.map((call) => call.callId));
    else worker.close();

    // Codex decides when to compact from this number, so it must be what Claude actually held: the
    // CLI's own count of the last call (cache reads included). The byte estimate of the visible
    // conversation undercounts JSON-heavy tool output and images by up to half, which let a thread
    // grow past the real window before Codex thought it was near the limit; it is now only a floor
    // for a CLI result that carries no usage. With every native tool disabled the CLI's hidden
    // overhead is about 2K tokens, immaterial against the advertised window.
    const reported = reportedUsage(result.usage);
    const inputTokens = Math.max(estimateVisibleTokens(requestToPrompt(request)), reported?.promptTokens ?? 0);
    const outputTokens = Math.max(estimateVisibleTokens(structured.text + JSON.stringify(toolCalls)), reported?.outputTokens ?? 0);
    return {
      text: structured.text,
      toolCalls,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    };
  } catch (error) {
    worker.close();
    throw error;
  }
}

const claudeModel = (slug: string, displayName: string) => ({
  slug,
  displayName,
  description: `${displayName} through your signed-in Claude account`,
  efforts: EFFORTS,
  defaultEffort: 'high',
  inputModalities: ['text', 'image'] as const,
  // The pinned Claude CLI reports contextWindow 1000000 for Opus 5.5 and Fable 5.1; advertise it so
  // Codex compacts at the real limit instead of the 200K default.
  contextWindow: 1_000_000,
});

export const claudeBackend: SubscriptionBackend = {
  name: 'Claude',
  models: {
    'claude-opus-5-5': 'claude-opus-5-5',
    'claude-fable-5-1': 'claude-fable-5-1',
    opus: 'claude-opus-5-5',
    sonnet: 'sonnet',
    haiku: 'haiku',
  },
  reservedPrefix: 'claude-',
  catalog: [claudeModel('claude-opus-5-5', 'Opus 5.5'), claudeModel('claude-fable-5-1', 'Fable 5.1')],
  assertAvailable: (model) => claudeLimits.assertAvailable(model),
  run: runClaude,
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
    run: (request, signal) => account.run(request, signal),
  };
  return { account, backend };
}

export function configuredClaudeAccount(env: Readonly<Record<string, string | undefined>> = process.env) {
  if (!env.CLAUDE_ACCOUNT_CONFIG_DIR) return undefined;
  return createClaudeAccountBackend({
    configDir: env.CLAUDE_ACCOUNT_CONFIG_DIR, prefix: env.CLAUDE_ACCOUNT_MODEL_PREFIX || 'secondary',
    label: env.CLAUDE_ACCOUNT_LABEL || 'Secondary', binary: env.CLAUDE_ACCOUNT_BIN || env.CLAUDE_BIN,
    cwd: env.CLAUDE_ACCOUNT_CWD, expectedEmail: env.CLAUDE_ACCOUNT_EXPECTED_EMAIL,
    expectedOrg: env.CLAUDE_ACCOUNT_EXPECTED_ORG,
    models: env.CLAUDE_ACCOUNT_MODELS?.split(',').map(model => model.trim()).filter(Boolean),
  });
}
