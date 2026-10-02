// Talking to the ChatGPT Codex backend on the user's behalf, with the user's own credentials.
import type { ResponsesBody } from '../protocol/types';

export const UPSTREAM_URL = 'https://chatgpt.com/backend-api/codex';

export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;

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

/** The error message from an upstream error body, if it has one. Never more than 300 chars. */
export async function upstreamErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; detail?: unknown };
    return String(parsed?.error?.message ?? parsed?.detail ?? '').slice(0, 300);
  } catch {
    return '';
  }
}

export function postJson(
  upstreamFetch: UpstreamFetch,
  path: string,
  headers: Headers,
  body: ResponsesBody,
  signal: AbortSignal,
): Promise<Response> {
  return upstreamFetch(UPSTREAM_URL + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
    redirect: 'error',
  });
}
