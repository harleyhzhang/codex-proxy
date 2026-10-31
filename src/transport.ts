import { positiveInt } from './env';
import { isRecord, randomId } from './json';

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
// Message text, because subscription CLIs and bridges report the same failures as prose or as the
// code word inside stderr rather than as an `error.code` property.
const NETWORK_MESSAGE =
  /fetch failed|unable to connect|cannot connect|network (?:error|connection|is unreachable)|socket connection.*closed|socket hang up|connection (?:reset|refused|closed)|getaddrinfo|connectionerror|\bE(?:CONNRESET|CONNREFUSED|NOTFOUND|AI_AGAIN|NETUNREACH|HOSTUNREACH|PIPE)\b|\bUND_ERR_(?:SOCKET|CONNECT_TIMEOUT)\b/i;

/** A dropped or timed-out connection. Codex retries these on its own. */
export class ProxyTransportError extends Error {
  constructor(readonly timedOut = false, readonly reconnectable = !timedOut) {
    super(
      timedOut
        ? 'Model connection timed out. Retrying.'
        : 'Network connection interrupted. Reconnect to the internet; Codex will retry.',
    );
    this.name = 'ProxyTransportError';
  }
}

/**
 * Recognises network failures anywhere in an error's cause chain. The result carries a fixed
 * message, so raw CLI stderr, request bodies and credentials are never forwarded.
 */
export function transportError(error: unknown): ProxyTransportError | undefined {
  if (error instanceof ProxyTransportError) return error;
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (isErrorLike(current) && !seen.has(current)) {
    seen.add(current);
    const code = typeof current.code === 'string' ? current.code : '';
    const message = typeof current.message === 'string' ? current.message : '';
    if (current.name === 'TimeoutError') return new ProxyTransportError(true);
    if (TIMEOUT_CODES.has(code)) return new ProxyTransportError(true, true);
    if (NETWORK_CODES.has(code) || NETWORK_MESSAGE.test(message)) return new ProxyTransportError();
    current = current.cause;
  }
  return undefined;
}

function isErrorLike(value: unknown): value is { code?: unknown; message?: unknown; name?: unknown; cause?: unknown } {
  return value instanceof Error || isRecord(value);
}

/** `server_error` stays retryable in Codex's native Responses stream parser. */
export function transportFailureEvent(error: ProxyTransportError) {
  return {
    type: 'response.failed',
    sequence_number: 0,
    response: { id: randomId('resp'), status: 'failed', error: { code: 'server_error', message: error.message } },
  };
}

/** A complete SSE stream holding a single `response.failed` event. */
export function failureStream(event: unknown): Response {
  return new Response(`event: response.failed\ndata: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return abortable(new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => clearTimeout(timer), { once: true }); }), signal);
}

/**
 * Awaits `promise`, but rejects with the signal's reason as soon as this caller aborts. The promise
 * itself keeps running, so one cancelled waiter on shared work never fails the others.
 */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Nothing has reached Codex yet (a buffered backend, or an upstream connection that never opened).
// Keep the same request pending through an outage instead of consuming Codex's finite
// stream-reconnect budget. A real model timeout, auth/quota refusal or cancellation still follows
// its existing terminal/retry path. `onRetry` fires before each wait so callers can start
// heartbeats and log; it never receives the error.
export async function reconnectTransport<T>(attempt: () => Promise<T>, signal?: AbortSignal,
  options: { initialDelayMs?: number; maxDelayMs?: number; onRetry?: (attempt: number, delayMs: number) => void } = {}): Promise<T> {
  // OFFLINE_RETRY_BASE_MS exists for test suites that script outages; production keeps 1 s.
  let delay = options.initialDelayMs ?? positiveInt('OFFLINE_RETRY_BASE_MS', 1000);
  const maxDelay = options.maxDelayMs ?? 30_000;
  for (let attempts = 1; ; attempts++) {
    signal?.throwIfAborted();
    try { return await attempt(); }
    catch (error) {
      if (signal?.aborted) throw transportError(error) ? signal.reason : error;
      const network = transportError(error);
      if (!network || !network.reconnectable) throw error;
      options.onRetry?.(attempts, delay);
      await sleep(delay, signal);
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}
