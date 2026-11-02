import { isRecord } from '../json';
import { cancelReader, MAX_BODY_BYTES, SseParser } from '../protocol/stream';
import type { OutputItem, ResponseObject, StreamEvent } from '../protocol/types';

/** Items can finish in a different order than their position in the response. Keep malformed
 * unindexed events too; assigning a synthetic index could overwrite a later explicit one. */
export class CompletedItems {
  private readonly indexed = new Map<number, OutputItem>();
  private readonly unindexed: OutputItem[] = [];
  add(item: OutputItem, index: unknown): void {
    if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0) this.indexed.set(index, item);
    else this.unindexed.push(item);
  }
  snapshot(): OutputItem[] {
    return [...this.indexed].sort(([a], [b]) => a - b).map(([, item]) => item).concat(this.unindexed);
  }
}

/** One completion observer for HTTP and WS. Never cache a failed/incomplete turn or an
 * unverified DONE marker. Completed item events fill sparse native terminal envelopes. */
export function completionObserver(remember: (response: ResponseObject) => void): (event: StreamEvent) => void {
  const items = new CompletedItems();
  let bytes = 0;
  return event => {
    if (event.type === 'response.output_item.done' && isRecord(event.item)) {
      bytes += Buffer.byteLength(JSON.stringify(event.item));
      if (bytes > MAX_BODY_BYTES) throw new Error('Upstream response too large');
      items.add(event.item as OutputItem, event.output_index);
    }
    if (event.type !== 'response.completed' || !isRecord(event.response)) return;
    const response = event.response;
    if (typeof response.id !== 'string' || response.status !== 'completed') return;
    remember({ ...response, output: Array.isArray(response.output) && response.output.length
      ? response.output as OutputItem[] : items.snapshot() } as ResponseObject);
  };
}

/** Observe successful HTTP replies as the client pulls them; never tee/eagerly drain or change
 * status, headers or raw framing. JSON buffering and retained item output both have hard caps. */
export function observeResponse(response: Response, remember: (response: ResponseObject) => void): Response {
  if (!response.ok || !response.body) return response;
  const type = response.headers.get('content-type') ?? '';
  const observe = completionObserver(remember);
  const sse = type.includes('text/event-stream') ? new SseParser(observe) : undefined;
  const json = type.includes('application/json');
  if (!sse && !json) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(out) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (sse) sse.finish();
          else {
            let parsed: unknown;
            try { parsed = JSON.parse(Buffer.concat(chunks, bytes).toString()); } catch {}
            if (isRecord(parsed)) observe({ type: 'response.completed', response: parsed });
          }
          reader.releaseLock(); out.close(); return;
        }
        if (sse) sse.feed(next.value);
        else { bytes += next.value.byteLength; if (bytes > MAX_BODY_BYTES) throw new Error('Upstream response too large'); chunks.push(next.value); }
        out.enqueue(next.value);
      } catch (error) { void cancelReader(reader, error); out.error(error); }
    },
    cancel(reason) { cancelReader(reader, reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
