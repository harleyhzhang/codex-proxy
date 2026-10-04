import { responseEvents, responseObject } from './output';
import { EMPTY_OUTPUT, type ResponsesBody, type ResponseObject } from './types';
type Event = Record<string, unknown>;

// Local backends buffer output until it is validated. Native progress events keep the client
// stream alive during generation/reconnection; no text or tool call is exposed before success.
export async function pendingResponse(request: ResponsesBody,
  generate: (signal: AbortSignal) => Promise<ResponseObject>, signal: AbortSignal,
  emit: (event: Event) => void, remember?: (response: ResponseObject) => void,
  heartbeatMs = 10_000): Promise<ResponseObject> {
  const heartbeatAbort = new AbortController();
  signal = AbortSignal.any([signal, heartbeatAbort.signal]);
  signal.throwIfAborted();
  const empty = responseObject(request, EMPTY_OUTPUT);
  const pending = { ...empty, status: 'in_progress', output: [], usage: null };
  let sequence = 0;
  const send = (event: Event) => {
    signal.throwIfAborted();
    emit({ ...event, sequence_number: sequence++ });
  };
  send({ type: 'response.created', response: pending });
  const timer = setInterval(() => {
    if (!signal.aborted) {
      try { send({ type: 'response.in_progress', response: pending }); }
      catch (error) { heartbeatAbort.abort(error); }
    }
  }, heartbeatMs);
  const cancel = () => clearInterval(timer);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const generated = await generate(signal);
    signal.throwIfAborted();
    const response = { ...generated, id: empty.id, created_at: empty.created_at };
    remember?.(response);
    // Reuse the output protocol, omitting the already-sent response.created frame.
    for (const event of responseEvents(response)) {
      if (event.type !== 'response.created') send(event);
    }
    return response;
  } finally {
    clearInterval(timer);
    signal.removeEventListener('abort', cancel);
  }
}

export function pendingStream(request: ResponsesBody,
  generate: (signal: AbortSignal) => Promise<ResponseObject>, signal: AbortSignal,
  failure: (error: unknown) => Event, remember?: (response: ResponseObject) => void,
  heartbeatMs = 10_000): Response {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(outgoing) {
      const emit = (event: Event) => outgoing.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      void pendingResponse(request, generate, combined, emit, remember, heartbeatMs)
        .catch(error => { if (!combined.aborted) emit(failure(error)); })
        .finally(() => {
          if (!combined.aborted) { outgoing.enqueue(encoder.encode('data: [DONE]\n\n')); outgoing.close(); }
          else { try { outgoing.error(combined.reason); } catch {} }
        }).catch(error => controller.abort(error));
    },
    cancel(reason) { controller.abort(reason); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
}
