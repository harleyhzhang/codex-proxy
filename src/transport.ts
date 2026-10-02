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
const NETWORK_MESSAGE =
  /fetch failed|unable to connect|cannot connect|network (?:error|connection)|socket connection.*closed|connection (?:reset|refused)|getaddrinfo|connectionerror/i;

/** A dropped or timed-out connection. Codex retries these on its own. */
export class ProxyTransportError extends Error {
  constructor(timedOut = false) {
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
    if (current.name === 'TimeoutError' || TIMEOUT_CODES.has(code)) return new ProxyTransportError(true);
    if (NETWORK_CODES.has(code) || NETWORK_MESSAGE.test(message)) return new ProxyTransportError();
    if (message.startsWith('Claude CLI timed out after')) return new ProxyTransportError(true);
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
