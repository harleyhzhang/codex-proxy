import { Admission } from '../backends/admission';
import { positiveInt } from '../env';
import { requestJson } from './json-request';
import type { UpstreamFetch } from './upstream';

/** Native HTTP and WebSocket transports use the same account gates. The lease lasts through
 * body consumption/cancellation, not merely until response headers arrive. Hosted tools bypass it. */
export function upstreamAdmission(): (transport: UpstreamFetch) => UpstreamFetch {
  const accounts = new Map<string, Admission>();
  return transport => async (url, init) => {
    if (!new URL(url).pathname.startsWith('/backend-api/codex/responses')) return transport(url, init);
    const account = new Headers(init.headers).get('chatgpt-account-id') ?? 'primary';
    let gate = accounts.get(account);
    if (!gate) { gate = new Admission('GPT', positiveInt('GPT_MAX_ACTIVE', 8), positiveInt('PROVIDER_MAX_QUEUED', 64)); accounts.set(account, gate); }
    const body = requestJson(init);
    const input = body?.input;
    const continued = typeof body?.previous_response_id === 'string' || Array.isArray(input) && typeof input.at(-1)?.type === 'string' && String(input.at(-1).type).endsWith('_output');
    const release = await gate.acquire(init.signal ?? undefined, continued ? 1 : 0);
    const done = () => { init.signal?.removeEventListener('abort', done); release(); };
    init.signal?.addEventListener('abort', done, { once: true });
    try {
      init.signal?.throwIfAborted();
      const response = await transport(url, init);
      if (!response.body) { done(); return response; }
      const reader = response.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(out) {
          try { const next = await reader.read(); if (next.done) { done(); out.close(); } else out.enqueue(next.value); }
          catch (error) { done(); out.error(error); }
        },
        async cancel(reason) { done(); await reader.cancel(reason).catch(() => {}); },
      });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { done(); throw error; }
  };
}
