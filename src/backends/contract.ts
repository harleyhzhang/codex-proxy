// The contract every subscription CLI backend implements. The router owns history, compaction,
// handoff restoration and error delivery; a backend only turns a validated request into output.
import { randomId } from '../json';
import { logSafe } from '../log';
import { CLIENT_TOOL_TYPES } from '../protocol/prompt';
import type { ProxyOutput, ResponsesBody, ResponsesRequest } from '../protocol/types';

/** One entry in the model picker. */
export type CatalogModel = {
  slug: string;
  displayName: string;
  description: string;
  efforts: readonly string[];
  defaultEffort: string;
  inputModalities: readonly ('text' | 'image')[];
};

export interface SubscriptionBackend {
  /** Shown in refusals and in the hosted-tool notice, e.g. "Claude" or "Grok". */
  readonly name: string;
  /** Public slug → model id passed to the CLI. Only these slugs route locally. */
  readonly models: Readonly<Record<string, string>>;
  /** Slugs under this prefix belong to the backend even if unlisted, so typos never reach GPT. */
  readonly reservedPrefix: string;
  /** Models listed in Codex's model picker. */
  readonly catalog: readonly CatalogModel[];
  /** Pre-generation gate, e.g. a known exhausted quota. Throws a BackendError to refuse. */
  assertAvailable?(model: string): void;
  run(request: ResponsesRequest, signal?: AbortSignal): Promise<ProxyOutput>;
}

export type FailureOptions = {
  /** The code Codex receives. Refusals default to `invalid_request_error`. */
  code?: string;
  /** A content-free event the router logs when it delivers this refusal. */
  logEvent?: Record<string, unknown>;
  /** True only when the backend refused before anything reached Codex, so one more attempt is safe. */
  retryable?: boolean;
  /** How many fresh attempts this refusal earns (default 1). Model-output refusals that a stronger note usually fixes may ask for 2. */
  retries?: number;
  /**
   * True when the refusal is about what the model wrote (unparseable reply, bad tool arguments, unknown
   * tool). After the one retry, such a refusal is delivered as a chat message instead of a failed turn.
   * Process crashes, transport failures and native-tool attempts must leave this false.
   */
  modelOutput?: boolean;
};

/**
 * A deliberate refusal. Codex shows the message and never falls back to another model. Only the
 * backend itself may retry, once, and only when the refusal is marked retryable.
 */
export class BackendError extends Error {
  readonly code: string;
  readonly logEvent?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly modelOutput: boolean;
  readonly retries: number;

  constructor(message: string, options: FailureOptions = {}) {
    super(message);
    this.name = 'BackendError';
    this.code = options.code ?? 'invalid_request_error';
    this.logEvent = options.logEvent;
    this.retryable = options.retryable ?? false;
    this.modelOutput = options.modelOutput ?? false;
    this.retries = Math.max(1, options.retries ?? 1);
  }
}

export const RETRY_MARKER = 'rejected before anything ran';

/**
 * The one retry policy every backend shares. A retryable refusal means nothing reached Codex, so a
 * second attempt is safe and is told why the first was rejected. Cancellation, timeouts, auth and
 * quota failures are never retryable and surface immediately.
 *
 * When the retry is also refused and the refusal is about the model's own output (`modelOutput`),
 * the turn is not failed. The refusal is delivered as an ordinary assistant message: Codex keeps the
 * turn open, the user sees what went wrong in the chat, and can reply naturally instead of hitting an
 * error card and typing "continue". No tool call is emitted. Crashes and transport failures still fail.
 */
export async function retryOnce(
  backend: string,
  signal: AbortSignal | undefined,
  attempt: (retryNote: string, lastAttempt: boolean) => Promise<ProxyOutput>,
): Promise<ProxyOutput> {
  // The first refusal decides how many fresh attempts follow (usually one). Each attempt is told
  // whether it is the last so a backend can relax a recoverable check (e.g. accept bare prose as a
  // chat message) only when nothing else is left to try. Non-retryable errors propagate unchanged.
  let error: BackendError | undefined;
  let budget = 1;
  for (let index = 0; index <= budget; index++) {
    const last = index === budget;
    try {
      const note = error ? ` Your previous answer was ${RETRY_MARKER}: ${error.message}. Follow the output rules exactly this time.` : '';
      return await attempt(note, last);
    } catch (caught) {
      if (!(caught instanceof BackendError) || !caught.retryable || signal?.aborted) throw caught;
      if (index === 0) budget = caught.retries;
      if (last) {
        if (!caught.modelOutput) throw caught;
        logSafe('backend-refusal-as-message', { backend, reason: caught.message });
        return refusalMessage(backend, caught);
      }
      logSafe('backend-retry', { backend, reason: caught.message, attempt: index + 1, budget });
      error = caught;
    }
  }
  throw error;
}

/** A text-only output that explains a refusal in the chat instead of failing the turn. */
export function refusalMessage(backend: string, error: BackendError): ProxyOutput {
  const text = `${backend} could not produce a valid action for this turn, even after one retry: ${error.message}. Nothing was executed. Reply to continue, or rephrase the request.`;
  return { text, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
}

export type CliFailure =
  | 'subscription usage limit reached'
  | 'authentication failed'
  | 'structured output failed'
  | 'connection failed'
  | 'process failed';

/**
 * Classifies a failed CLI run. Pass only stderr and the CLI's own status records: model text can
 * mention any word, so it must never decide the category.
 */
export function classifyCliFailure(diagnostics: string): { category: CliFailure; retryable: boolean } {
  const category: CliFailure = /429|rate.?limit|usage limit|quota/i.test(diagnostics)
    ? 'subscription usage limit reached'
    : /401|unauthori[sz]ed|not authenticated|token expired|sign.in|log.in/i.test(diagnostics)
      ? 'authentication failed'
      : /structured.?output|json.?schema|schema validation/i.test(diagnostics)
        ? 'structured output failed'
        : /network|connection|timeout|timed out|dns|socket|request failed|fetch|\b5\d\d\b/i.test(diagnostics)
          ? 'connection failed'
          : 'process failed';
  // A retry cannot fix the account itself.
  const retryable = category !== 'subscription usage limit reached' && category !== 'authentication failed';
  return { category, retryable };
}

/**
 * Codex treats unknown `response.failed` codes as retryable stream failures. `invalid_prompt` is
 * its terminal refusal code and renders the message verbatim.
 */
export function terminalEvent(error: BackendError) {
  return {
    type: 'response.failed',
    sequence_number: 0,
    response: { id: randomId('resp'), status: 'failed', error: { code: NATIVE_TERMINAL_CODES.has(error.code) ? error.code : 'invalid_prompt', message: error.message } },
  };
}

/**
 * Codes native Codex classifies itself (codex-api sse/responses.rs): `context_length_exceeded` becomes
 * ContextWindowExceeded, which stops retrying and tells the user to compact instead of looping.
 */
export const NATIVE_TERMINAL_CODES = new Set(['context_length_exceeded']);

/** Subscription CLIs report a prompt over the model window in prose; match it so Codex sees the native code. */
export const CONTEXT_OVERFLOW_TEXT = /prompt is too long|context (?:window|length)(?: limit)? (?:exceeded|reached)|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|too many (?:input )?tokens/i;

/**
 * Prepares a body for a backend: maps the public slug to the CLI model id and removes
 * OpenAI-hosted tools, telling the model they are unavailable this turn.
 */
export function adaptRequest(body: ResponsesBody, backend: SubscriptionBackend): ResponsesBody {
  const model = typeof body.model === 'string' && Object.hasOwn(backend.models, body.model)
    ? backend.models[body.model]
    : undefined;
  if (!model) throw new BackendError(`Unsupported ${backend.name} model`);

  const allTools = body.tools ?? [];
  const hosted = allTools.filter((tool) => !CLIENT_TOOL_TYPES.has(tool.type));
  const tools = allTools.filter((tool) => CLIENT_TOOL_TYPES.has(tool.type));
  const instructions = hosted.length
    ? `${body.instructions ?? ''}\nOpenAI server-hosted tools (${hosted.map((tool) => tool.type).join(', ')}) are unavailable for this ${backend.name} turn. Use the supplied Codex browser/computer tools when appropriate. If a requested feature requires one of those hosted tools, explain that limitation accurately.`
    : body.instructions;

  const { type: _type, previous_response_id: _previous, service_tier: _tier, ...rest } = body;
  return { ...rest, model, tools, instructions };
}

/** A rough token count for text the model can see: four UTF-8 bytes per token. */
export function estimateVisibleTokens(value: string): number {
  return value ? Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 4)) : 0;
}
