// The contract every subscription CLI backend implements. The router owns history, compaction,
// handoff restoration and error delivery; a backend only turns a validated request into output.
import { randomId } from '../json';
import { logSafe } from '../log';
import { CLIENT_TOOL_TYPES } from '../protocol/prompt';
import type { ProxyOutput, ResponsesBody, ResponsesRequest, OutputSink } from '../protocol/types';

/** One entry in the model picker. */
export type CatalogModel = {
  slug: string;
  displayName: string;
  description: string;
  efforts: readonly string[];
  defaultEffort: string;
  inputModalities: readonly ('text' | 'image')[];
  /** Tokens Codex may keep before compacting. Omit to advertise the 200K default. */
  contextWindow?: number;
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
  /** `sink`, when given, receives the turn's assistant text as it arrives. */
  run(request: ResponsesRequest, signal?: AbortSignal, sink?: OutputSink): Promise<ProxyOutput>;
  /**
   * Optional, best effort: readies a process or login check for the turn a `generate: false` warmup
   * announces (Codex sends one when a chat opens). Must never start a generation, send a prompt or throw.
   */
  prewarm?(request: ResponsesRequest): void;
}

type FailureOptions = {
  /** The code Codex receives. Refusals default to `invalid_request_error`. */
  code?: string;
  /** A content-free event the router logs when it delivers this refusal. */
  logEvent?: Record<string, unknown>;
  /** A provider-side transient failure before anything reached Codex, so one more attempt is safe. */
  retryable?: boolean;
};

/**
 * A deliberate refusal. Codex shows the message and never falls back to another model. Only the
 * backend itself may retry, once, and only when the refusal is marked retryable.
 */
export class BackendError extends Error {
  readonly code: string;
  readonly logEvent?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(message: string, options: FailureOptions = {}) {
    super(message);
    this.name = 'BackendError';
    this.code = options.code ?? 'invalid_request_error';
    this.logEvent = options.logEvent;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * The one retry policy every backend shares. A retryable refusal is a provider-side transient failure
 * before anything reached Codex, so one fresh attempt is safe; text Codex already shows rules it out.
 * Whatever happens next reaches Codex with its real reason.
 */
export async function retryOnce(backend: string, signal: AbortSignal | undefined, attempt: () => Promise<ProxyOutput>, sink?: OutputSink): Promise<ProxyOutput> {
  try { return await attempt(); } catch (error) {
    if (!(error instanceof BackendError) || !error.retryable || signal?.aborted || sink?.started) throw error;
    logSafe('backend-retry', { backend, reason: error.message });
  }
  return attempt();
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
const NATIVE_TERMINAL_CODES = new Set(['context_length_exceeded', 'server_is_overloaded']);

/** Subscription CLIs report a prompt over the model window in prose; match it so Codex sees the native code. */
export const CONTEXT_OVERFLOW_TEXT = /prompt is too long|context (?:window|length)(?: limit)? (?:exceeded|reached)|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|too many (?:input )?tokens/i;

/** Retrying an oversized prompt can never succeed, so it is terminal with the native overflow code. */
export function contextOverflowError(backend: string): BackendError {
  return new BackendError(`${backend}: the conversation is longer than the model's context window. Compact the conversation or start a new thread.`, { code: 'context_length_exceeded' });
}

/**
 * Subscription CLIs already retry provider overload internally (Claude Code retries 529s), so once one
 * reports it, another full turn is wasted work. Native Codex treats `server_is_overloaded` as
 * ServerOverloaded: not retried, shown to the user.
 */
export const OVERLOADED_TEXT = /\boverloaded(?:_error)?\b|\b529\b/i;

export function overloadedError(backend: string): BackendError {
  return new BackendError(`${backend} is overloaded right now. Try again in a moment or switch models.`, { code: 'server_is_overloaded' });
}

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
