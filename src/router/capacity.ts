import { nonNegativeInt, positiveInt } from '../env';
import { isRecord, type JsonRecord } from '../json';
import { logSafe } from '../log';
import { pendingEnvelope } from '../protocol/pending';
import { cancelReader, MAX_EVENT_BYTES, SseParser } from '../protocol/stream';
import type { ResponsesBody, StreamEvent } from '../protocol/types';
import { abortable, retryDelayMs, sleep } from '../transport';

type Failure = { error: JsonRecord; capacity: boolean };
const failures = new WeakMap<Response, Failure>();
const encoder = new TextEncoder();
const frame = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

function errorOf(value: JsonRecord): JsonRecord {
  return isRecord(value.error) ? value.error : isRecord(value.response) && isRecord(value.response.error) ? value.response.error : {};
}

function capacity(error: JsonRecord): boolean {
  // A quota/auth/policy error must never become a capacity retry, even with conflicting metadata.
  const terminal = /quota|usage_limit|usage_not_included|authentication|permission|policy|invalid_request|context_length/;
  if (terminal.test(String(error.type ?? '')) || terminal.test(String(error.code ?? ''))) return false;
  return error.code === 'server_is_overloaded' || error.type === 'overloaded_error';
}

/** Inspect only error bodies, retaining their original bytes/status for normal native handling. */
export async function inspectCapacity(response: Response, signal: AbortSignal): Promise<Response> {
  if (response.ok || !response.body || failures.has(response)) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_EVENT_BYTES) throw new Error('Upstream error too large');
      chunks.push(next.value);
    }
  } finally { cancelReader(reader); }
  const raw = Buffer.concat(chunks, bytes);
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString()); } catch {}
  const error = isRecord(parsed) ? errorOf(parsed) : {};
  const headers = new Headers(response.headers);
  headers.delete('content-length'); headers.delete('content-encoding');
  const result = new Response(raw, { status: response.status, statusText: response.statusText, headers });
  failures.set(result, { error, capacity: response.status >= 500 && capacity(error) });
  return result;
}

export const isCapacityResponse = (response: Response): boolean => failures.get(response)?.capacity === true;

export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms');
  const seconds = headers.get('retry-after');
  const value = ms !== null ? Number(ms) : seconds !== null
    ? /^\s*\d+(?:\.\d+)?\s*$/.test(seconds) ? Number(seconds) * 1000 : Date.parse(seconds) - now : NaN;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** One online recovery window, starting at the first overload, shared across HTTP and stream errors. */
export class CapacityBudget {
  private deadline?: number;
  private attempts = 0;
  constructor(private readonly windowMs = nonNegativeInt('UPSTREAM_CAPACITY_RECOVERY_MS', 120_000),
    private readonly baseMs = positiveInt('UPSTREAM_CAPACITY_RETRY_BASE_MS', 1000), private readonly now = Date.now) {}
  delay(headers: Headers): number | undefined {
    const now = this.now();
    this.deadline ??= now + this.windowMs;
    const hint = retryAfterMs(headers, now);
    const delay = Math.max(1, hint ?? Math.min(15_000, retryDelayMs(this.baseMs, Math.min(this.attempts, 20))));
    if (now + delay >= this.deadline) return undefined;
    this.attempts++;
    logSafe('upstream-capacity-retry', { attempt: this.attempts, delay_ms: delay, provider_hint: hint !== undefined });
    return delay;
  }
}

/** Empty scaffolding can be discarded with its failed response id. Everything else commits it. */
function provisional(event: StreamEvent): boolean {
  if (event.type === 'response.created' || event.type === 'response.in_progress' || event.type === 'response.queued') {
    return !isRecord(event.response) || !Array.isArray(event.response.output) || event.response.output.length === 0;
  }
  if (event.type === 'response.output_item.added' && isRecord(event.item)) {
    const item = event.item;
    return (item.type === 'message' || item.type === 'reasoning') && !item.encrypted_content
      && (!Array.isArray(item.content) || item.content.length === 0) && (!Array.isArray(item.summary) || item.summary.length === 0);
  }
  if ((event.type === 'response.content_part.added' || event.type === 'response.reasoning_summary_part.added') && isRecord(event.part)) {
    return (event.part.type === 'output_text' || event.part.type === 'summary_text') && event.part.text === '';
  }
  return false;
}

function eventHeaders(event: StreamEvent, response: Response): Headers {
  const headers = new Headers(response.headers);
  if (isRecord(event.headers)) for (const [key, value] of Object.entries(event.headers)) {
    if (typeof value === 'string' && /^retry-after(?:-ms)?$/i.test(key)) headers.set(key, value);
  }
  return headers;
}

/** Retry only this inference, before any output/tool event is exposed. Prior tool receipts stay in
 * the immutable request. Failed attempt ids never escape; raw successful SSE framing is preserved.
 * Pull-driven reads and bounded metadata prevent recovery from draining a slow client's stream. */
export async function recoverCapacity(open: (signal: AbortSignal) => Promise<Response>, request: ResponsesBody, signal: AbortSignal, progress?: () => void): Promise<Response> {
  const budget = new CapacityBudget();
  let response = await open(signal);
  if (!request.stream) {
    while (isCapacityResponse(response)) {
      const delay = budget.delay(response.headers);
      if (delay === undefined) return response;
      void response.body?.cancel().catch(() => {});
      await sleep(delay, signal);
      response = await open(signal);
    }
  }
  if (!isCapacityResponse(response) && (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream'))) return response;
  const cancel = new AbortController();
  // open() uses the caller's signal. Body cancellation also releases that attempt's reader;
  // each read/open/wait below races our own cancellation so no further retry can start.
  const live = AbortSignal.any([signal, cancel.signal]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let parser: SseParser;
  let prefix: Uint8Array[] = [], bytes = 0, committed = false, overloaded: StreamEvent | undefined;
  let recovering = false;
  let events: StreamEvent[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { clearInterval(timer); timer = undefined; };
  const release = () => { if (reader) { cancelReader(reader, live.reason); reader = undefined; } };
  const reset = () => {
    prefix = []; events = []; bytes = 0; overloaded = undefined;
    parser = new SseParser(event => {
      if (!committed && (event.type === 'error' || event.type === 'response.failed') && capacity(errorOf(event))) overloaded = event;
      else {
        if (!provisional(event)) committed = true;
        if (recovering && event.type !== 'response.created') events.push(event);
      }
    });
    reader = response.body?.getReader();
  };
  if (response.ok) reset();
  const pending = pendingEnvelope(request);
  let sequence = 0;
  const visible = (event: StreamEvent) => frame({ ...event, sequence_number: sequence++,
    ...(event.response_id !== undefined ? { response_id: pending.id } : {}),
    ...(isRecord(event.response) ? { response: { ...event.response, id: pending.id, created_at: pending.created_at } } : {}),
  });
  const flush = () => recovering ? Buffer.concat(events.map(visible)) : Buffer.concat(prefix, bytes);
  const stream = new ReadableStream<Uint8Array>({
    async pull(out) {
      const abort = () => { stop(); release(); try { out.error(live.reason); } catch {} };
      live.addEventListener('abort', abort, { once: true });
      // This progress event is ignored by native Codex and carries no output or attempt identity.
      if (!committed) timer = setInterval(() => {
        if ((out.desiredSize ?? -1) >= 0) out.enqueue(frame({ type: 'response.in_progress', sequence_number: sequence++, response: pending }));
      }, positiveInt('UPSTREAM_CAPACITY_HEARTBEAT_MS', 10_000));
      try {
        for (;;) {
          live.throwIfAborted();
          let retryHeaders: Headers | undefined;
          if (!response.ok) {
            response = await inspectCapacity(response, live);
            if (isCapacityResponse(response)) retryHeaders = response.headers;
          } else if (reader) {
            const next = await abortable(reader.read(), live);
            if (!next.done) progress?.();
            if (next.done) parser.finish();
            else parser.feed(next.value);
            if (overloaded) retryHeaders = eventHeaders(overloaded, response);
            else {
              if (!next.done) { if (!recovering) prefix.push(next.value); bytes += next.value.byteLength; }
              // Never retain unbounded metadata. Flushing it commits this attempt too.
              if (committed || bytes >= 1024 * 1024 || next.done) {
                if (prefix.length || events.length) out.enqueue(flush());
                prefix = []; events = []; bytes = 0; committed = true;
                if (next.done) { release(); out.close(); }
                return;
              }
              continue;
            }
          } else { out.close(); return; }
          const delay = retryHeaders && budget.delay(retryHeaders);
          if (delay === undefined) {
            if (overloaded) {
              if (recovering) { events.push(overloaded); out.enqueue(flush()); }
              else { prefix.push(frame(overloaded)); out.enqueue(Buffer.concat(prefix)); }
            } else {
              const failure = failures.get(response);
              out.enqueue(visible({ type: 'response.failed', status: response.status, response: { ...pending, status: 'failed', error: {
                code: response.status >= 500 ? 'server_error' : 'invalid_prompt', ...failure?.error,
              } } }));
            }
            release(); out.close(); return;
          }
          release();
          void response.body?.cancel().catch(() => {});
          if (!recovering) {
            recovering = true;
            // A stable logical id lets Codex interrupt during backoff. Subsequent upstream
            // attempts are rebound to it; their item/call ids and successful output stay intact.
            out.enqueue(visible({ type: 'response.created', response: pending }));
          }
          await sleep(delay, live);
          live.throwIfAborted();
          // A cancelled body must also cancel a transport which is still waiting for headers.
          const opening = open(live);
          void opening.then(value => { if (live.aborted) void value.body?.cancel(live.reason).catch(() => {}); }, () => {});
          response = await abortable(opening, live);
          prefix = []; events = []; bytes = 0; overloaded = undefined;
          if (response.ok) reset();
        }
      } catch (error) { release(); try { out.error(error); } catch {} }
      finally { stop(); live.removeEventListener('abort', abort); }
    },
    cancel(reason) { cancel.abort(reason); stop(); release(); },
  }, { highWaterMark: 0 });
  const headers = new Headers(response.ok ? response.headers : { 'content-type': 'text/event-stream' });
  headers.delete('content-length'); headers.delete('content-encoding');
  return new Response(stream, { headers });
}
