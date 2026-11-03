// Talking to the ChatGPT Codex backend on the user's behalf, with the user's own credentials.
import { nonNegativeInt } from '../env';
import { isRecord } from '../json';
import { logSafe } from '../log';
import type { ResponsesBody, StreamEvent } from '../protocol/types';
import { reconnectTransport, retryDelayMs, sleep, transportError } from '../transport';
import { inspectCapacity, isCapacityResponse, recoverCapacity } from './capacity';

export const UPSTREAM_URL = 'https://chatgpt.com/backend-api/codex';

export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * An upstream HTTP failure that keeps OpenAI's status, so Codex applies its own retry policy:
 * 5xx is retryable, 4xx is not. Reporting every failure as 400 would suppress that retry.
 */
export class UpstreamStatusError extends Error {
  constructor(message: string, readonly status: number, readonly fields: UpstreamErrorFields = {}) {
    super(message);
    this.name = 'UpstreamStatusError';
  }
}

/** Hop-by-hop and browser headers that must never be forwarded. */
const STRIPPED = /^(host|connection|upgrade|sec-websocket(?:-.*)?|content-length|origin)$/i;

export function upstreamHeaders(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  for (const name of Array.from(headers.keys())) if (STRIPPED.test(name)) headers.delete(name);
  return headers;
}

/**
 * Headers for a JSON body the router re-serialised itself. Router-initiated calls (compaction and
 * bridge requests) drop Codex's per-turn metadata headers, which describe a different request.
 */
export function jsonHeaders(
  incoming: Headers,
  options: { eventStream?: boolean; stripCodexMetadata?: boolean } = {},
): Headers {
  const headers = upstreamHeaders(incoming);
  if (options.stripCodexMetadata) {
    for (const name of Array.from(headers.keys())) {
      if (/compaction|x-codex-turn-metadata/i.test(name)) headers.delete(name);
    }
  }
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json');
  if (options.eventStream !== false) headers.set('accept', 'text/event-stream');
  return headers;
}

/** Passes an upstream response through, minus encodings Bun has already undone. */
export function relay(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Codex sends `store: false`, so OpenAI keeps no items and an input item's `id` can only name an
 * item that does not exist. Native Codex never sends them; the router's own history replays do,
 * because they reuse OpenAI's previous output and other models' output verbatim. Some ChatGPT
 * backends ignore such ids, others refuse the whole request ("Supplied input item IDs require
 * persisted-item lookup"), so they never leave the router. `item_reference` is only an id and is
 * left for OpenAI to judge.
 */
export function withoutItemId<T>(item: T): T {
  if (!isRecord(item) || !('id' in item) || item.type === 'item_reference') return item;
  const { id: _id, ...rest } = item;
  return rest as T;
}

export function withoutItemIds<T extends { input?: unknown; store?: unknown }>(body: T): T {
  if (body.store === true || !Array.isArray(body.input) || !body.input.some(item => withoutItemId(item) !== item)) return body;
  return { ...body, input: body.input.map(withoutItemId) };
}

export { idleDeadline, watchBody } from '../protocol/idle';

/**
 * The upstream `error` fields native Codex classifies on (codex-api api_bridge.rs): `type`
 * (`usage_limit_reached`, `usage_not_included`), `code` (`cyber_policy`, `server_is_overloaded`,
 * `slow_down`), and the reset hints shown with a usage limit. Relaying them keeps a capped or
 * flagged request terminal with native's own message instead of a generic retry-limit error.
 */
export type UpstreamErrorFields = Partial<Record<'type' | 'code' | 'plan_type' | 'resets_at' | 'resets_in_seconds', string | number>>;
const CLASSIFYING_FIELDS = ['type', 'code', 'plan_type', 'resets_at', 'resets_in_seconds'] as const;
const QUOTA_CODES = new Set(['usage_limit_reached', 'rate_limit_exceeded', 'insufficient_quota']);
const REQUEST_FAULT_CODES = new Set(['context_length_exceeded', 'invalid_prompt', 'cyber_policy', 'invalid_request_error']);

/** An error inside a successful HTTP stream still owns its native classification. */
export function upstreamStreamFailure(event: StreamEvent, operation: string): UpstreamStatusError {
  const response = isRecord(event.response) ? event.response : {};
  const error = isRecord(event.error) ? event.error : isRecord(response.error) ? response.error : {};
  const fields: UpstreamErrorFields = {};
  for (const key of CLASSIFYING_FIELDS) {
    const value = error[key];
    if (typeof value === 'string' || typeof value === 'number') fields[key] = value;
  }
  const code = String(fields.code ?? fields.type ?? '');
  const status = typeof event.status === 'number' && event.status >= 400 && event.status <= 599 ? event.status
    : QUOTA_CODES.has(code) ? 429 : REQUEST_FAULT_CODES.has(code) ? 400 : 502;
  const detail = typeof error.message === 'string' ? error.message.slice(0, 300) : '';
  return new UpstreamStatusError(`OpenAI ${operation} failed${detail ? `: ${detail}` : ''}`, status, fields);
}

/**
 * Native Codex shows this for a 403 whose body mentions a Cloudflare block (codex-api api_bridge.rs
 * `api_error_user_message`). That body is an HTML page, so keep the signal native keys on.
 */
const CLOUDFLARE_BLOCKED_MESSAGE = 'Access blocked by Cloudflare. This usually happens when connecting from a restricted region';

/** The message (never more than 300 chars) and classifying fields of an upstream error body. */
export async function upstreamFailure(response: Response): Promise<{ detail: string; fields: UpstreamErrorFields }> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: Record<string, unknown>; detail?: unknown };
    const fields: UpstreamErrorFields = {};
    for (const key of CLASSIFYING_FIELDS) {
      const value = parsed?.error?.[key];
      if (typeof value === 'string' || typeof value === 'number') fields[key] = value;
    }
    return { detail: String(parsed?.error?.message ?? parsed?.detail ?? '').slice(0, 300), fields };
  } catch {
    if (response.status === 403 && text.includes('Cloudflare') && text.includes('blocked')) {
      return { detail: `${CLOUDFLARE_BLOCKED_MESSAGE} (status 403 Forbidden)`, fields: {} };
    }
    // A plain-text body (not an HTML error page) is the only explanation upstream gave.
    if (text && !/^\s*</.test(text)) return { detail: text.trim().slice(0, 300), fields: {} };
    return { detail: '', fields: {} };
  }
}

/** The error message from an upstream error body, if it has one. Never more than 300 chars. */
export async function upstreamErrorDetail(response: Response): Promise<string> {
  return (await upstreamFailure(response)).detail;
}

/**
 * Native Codex retries 5xx responses and dropped connections 4 times with a 200ms doubling backoff
 * (codex-rs core/src/util.rs `backoff`), each delay jittered by 0.9-1.1 so concurrent turns do not
 * retry in lockstep.
 */
export { retryDelayMs } from '../transport';

/**
 * Native Codex retries 5xx responses and dropped connections 4 times with a 200ms doubling backoff
 * (429 is never retried at this layer). Matching it means a transient 5xx (such as 507) or a reset
 * socket never surfaces as a failed turn or compaction. The body is a string, so resending it is
 * safe, and nothing has reached Codex before the status is known.
 */
export async function postJson(
  upstreamFetch: UpstreamFetch,
  path: string,
  headers: Headers,
  body: ResponsesBody,
  signal: AbortSignal,
  progress?: () => void,
): Promise<Response> {
  const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(withoutItemIds(body)), redirect: 'error' };
  const retries = nonNegativeInt('UPSTREAM_5XX_RETRIES', 4);
  const baseDelayMs = nonNegativeInt('UPSTREAM_RETRY_BASE_MS', 200);
  return recoverCapacity(async signal => {
    const attemptInit = { ...init, signal };
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try { response = await upstreamFetch(UPSTREAM_URL + path, attemptInit); }
      catch (error) {
        const network = transportError(error);
        if (!network || network.timedOut || attempt >= retries || signal.aborted) throw error;
        logSafe('upstream-retry', { path, status: 0, attempt: attempt + 1 });
        await sleep(retryDelayMs(baseDelayMs, attempt), signal);
        continue;
      }
      if (response.status >= 500) response = await inspectCapacity(response, signal);
      // Explicit capacity errors belong to the single longer recovery window, not nested bursts.
      if (isCapacityResponse(response)) return response;
      if (response.status < 500 || attempt >= retries || signal.aborted) return response;
      logSafe('upstream-retry', { path, status: response.status, attempt: attempt + 1 });
      await response.body?.cancel().catch(() => {});
      await sleep(retryDelayMs(baseDelayMs, attempt), signal);
    }
  }, body, signal, progress);
}

/**
 * The connect phase of an upstream call during an outage. Nothing has reached Codex yet, so the
 * same body is resent with 1-30 s backoff until OpenAI answers or Codex cancels; `postJson`'s own
 * 4x/200 ms loop still absorbs blips inside each attempt, and a real 5xx answer still returns so
 * native retry policy applies to it. The idle window restarts per attempt so the outage itself
 * never counts as upstream silence. `onRetry` fires before every wait so callers can start
 * heartbeats toward Codex. This is the GPT half of the one offline policy every backend shares
 * (`localResponse` is the other half).
 */
export function connectUpstream(
  upstreamFetch: UpstreamFetch,
  path: string,
  headers: Headers,
  body: ResponsesBody,
  idle: { signal: AbortSignal; touch(): void },
  cancel: AbortSignal,
  onRetry?: (attempt: number, delayMs: number) => void,
): Promise<Response> {
  return reconnectTransport(
    () => { idle.touch(); return postJson(upstreamFetch, path, headers, body, idle.signal, idle.touch); },
    cancel,
    { onRetry: (attempt, delayMs) => { logSafe('upstream-offline-retry', { path, attempt, delay_ms: delayMs }); onRetry?.(attempt, delayMs); } },
  );
}
