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

export const RETRY_MARKER = 'rejected before anything ran';

/**
 * The one retry policy every backend shares. A retryable refusal means nothing reached Codex, so a
 * second attempt is safe and is told why the first was rejected. Cancellation, timeouts, auth and
 * quota failures are never retryable and surface immediately.
 */
export async function retryOnce<T>(
  backend: string,
  signal: AbortSignal | undefined,
  attempt: (retryNote: string) => Promise<T>,
): Promise<T> {
  try {
    return await attempt('');
  } catch (error) {
    if (!(error instanceof BackendError) || !error.retryable || signal?.aborted) throw error;
    logSafe('backend-retry', { backend, reason: error.message });
    return attempt(
      ` Your previous answer was ${RETRY_MARKER}: ${error.message}. Follow the output rules exactly this time.`,
    );
  }
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
    response: { id: randomId('resp'), status: 'failed', error: { code: 'invalid_prompt', message: error.message } },
  };
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
