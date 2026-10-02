// Claude through the official Claude Code CLI. Each turn is one `claude -p` stream-json session
// with every native tool disabled; Codex's tools are described in the prompt and requested
// through structured output. A session that returned tool calls stays alive briefly so the next
// turn only has to send the tool results.
import { positiveInt } from '../env';
import { isRecord, randomId } from '../json';
import { continuationRequest, type ImageBlock, outputSchema, preparePrompt, requestToPrompt, toolDescriptors } from '../protocol/prompt';
import type { ProxyOutput, ResponsesRequest } from '../protocol/types';
import { transportError } from '../transport';
import { claudeLimits, ClaudeUsageLimitError } from './claude-limits';
import { estimateVisibleTokens, type SubscriptionBackend } from './contract';

const MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  'claude-opus': 'opus',
  'claude-sonnet': 'sonnet',
  'claude-haiku': 'haiku',
};
const EFFORTS = ['low', 'medium', 'high'] as const;

/** Variables that would let the CLI bypass the signed-in subscription or leak another credential. */
const BLOCKED_ENV = new Set([
  'CLAUDECODE',
  'PROXY_API_KEY',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]);

const SYSTEM_PROMPT = `You are running inside a Codex agent loop. Tools described in <available_tools> are real, available Codex tools even though they are not present in Claude Code's native tool registry. Invoke them by returning their exact name and arguments in the required structured tool_calls output. Never claim that a listed Codex tool is unavailable merely because it is absent from the native registry. When a Codex browser, node_repl, cua_repl, or computer tool is listed, use it for browser requests instead of substituting WebFetch, web search, curl, or another native tool.`;

const USAGE_LIMIT_TEXT = /you['’]ve hit your (?:session|weekly|usage) limit|usage limit reached/i;

type ClaudeResult = {
  type: 'result';
  subtype?: string;
  is_error: boolean;
  result?: string;
  structured_output?: StructuredOutput;
};
type StructuredOutput = { text: string; tool_calls: Array<{ name: string; arguments: string }> };

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

function claudeEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BLOCKED_ENV.has(key)) env[key] = value;
  }
  return env;
}

// Receives the CLI's plan-usage snapshot (`rate_limit_event.rate_limit_info`) after each turn.
let rateLimitSink: ((info: unknown) => void) | undefined;
export function onClaudeRateLimit(sink: (info: unknown) => void): void {
  rateLimitSink = sink;
}

/** Live sessions that can continue a turn, keyed by the tool call ids they issued. */
const workersByCallId = new Map<string, ClaudeWorker>();

type PendingTurn = { resolve: (result: ClaudeResult) => void; reject: (error: Error) => void };

class ClaudeWorker {
  readonly model: string;
  readonly signature: string;
  readonly callIds = new Set<string>();
  private readonly process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  private pending?: PendingTurn;
  private stderr = '';
  private idleTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(request: ResponsesRequest) {
    this.model = request.model;
    this.signature = sessionSignature(request);
    this.process = Bun.spawn([process.env.CLAUDE_BIN ?? 'claude', ...buildClaudeArgs(request)], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: process.env.CLAUDE_CWD || process.cwd(),
      env: claudeEnvironment(),
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
    const timeoutMs = positiveInt('CLAUDE_TIMEOUT_MS', 900_000);

    return new Promise<ClaudeResult>((resolve, reject) => {
      const settle = (error: Error) => {
        const pending = this.pending;
        this.pending = undefined;
        this.abort();
        pending?.reject(error);
      };
      const timeout = setTimeout(() => settle(new Error(`Claude CLI timed out after ${timeoutMs}ms`)), timeoutMs);
      const cancel = () => settle(new Error('Claude request cancelled'));
      const cleanup = () => {
        clearTimeout(timeout);
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
      workersByCallId.set(callId, this);
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
      if (workersByCallId.get(callId) === this) workersByCallId.delete(callId);
    }
    this.callIds.clear();
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of this.process.stdout) {
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
      claudeLimits.update(record.rate_limit_info);
      try {
        rateLimitSink?.(record.rate_limit_info);
      } catch {}
      return;
    }
    if (record.type === 'assistant' && record.error === 'rate_limit') {
      this.fail(claudeLimits.blocked(this.model) ?? new ClaudeUsageLimitError());
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

/** The live session that issued the newest tool call in this request, if it can continue. */
function continuationWorker(request: ResponsesRequest): ClaudeWorker | undefined {
  if (typeof request.input === 'string') return undefined;
  for (let index = request.input.length - 1; index >= 0; index--) {
    const callId = request.input[index]?.call_id;
    const worker = callId ? workersByCallId.get(callId) : undefined;
    if (worker?.model !== request.model) continue;
    if (worker.signature === sessionSignature(request)) return worker;
    worker.close();
    return undefined;
  }
  return undefined;
}

async function runTurn(request: ResponsesRequest, signal?: AbortSignal): Promise<{ worker: ClaudeWorker; result: ClaudeResult }> {
  const continuing = continuationWorker(request);
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
  const worker = new ClaudeWorker(request);
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
  signal?.throwIfAborted();
  claudeLimits.assertAvailable(request.model);
  const { worker, result } = await runTurn(request, signal);

  try {
    if (result.is_error) {
      if (USAGE_LIMIT_TEXT.test(result.result ?? '')) {
        throw claudeLimits.blocked(request.model) ?? new ClaudeUsageLimitError();
      }
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

    // Claude Code's own usage counts its hidden system prompt, tool schemas and cache activity.
    // Reporting that overhead makes Codex think its conversation exceeds the context window, so
    // only the content Codex can see and compact is counted.
    const inputTokens = estimateVisibleTokens(requestToPrompt(request));
    const outputTokens = estimateVisibleTokens(structured.text + JSON.stringify(toolCalls));
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
