import { Admission } from '../backends/admission';
import { positiveInt } from '../env';
import { requestJson } from './json-request';
import { cancelReader } from '../protocol/stream';
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
    const signal = init.signal ?? undefined;
    const release = await gate.acquire(signal, continued ? 1 : 0);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const done = () => { signal?.removeEventListener('abort', abort); release(); };
    const abort = () => { done(); if (reader) void cancelReader(reader, signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      const response = await transport(url, init);
      // Injected transports may resolve after cancellation instead of rejecting like fetch.
      if (signal?.aborted) { void response.body?.cancel(signal.reason).catch(() => {}); signal.throwIfAborted(); }
      if (!response.body) { done(); return response; }
      const source = response.body.getReader();
      reader = source;
      const stream = new ReadableStream<Uint8Array>({
        async pull(out) {
          try { const next = await source.read(); if (next.done) { done(); source.releaseLock(); out.close(); } else out.enqueue(next.value); }
          catch (error) { done(); source.releaseLock(); out.error(error); }
        },
        cancel(reason) { done(); cancelReader(source, reason); },
      });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { done(); throw error; }
  };
}
