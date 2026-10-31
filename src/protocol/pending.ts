import { randomId } from '../json';
import { logSafe } from '../log';
import { itemEvents, responseObject } from './output';
import { EMPTY_OUTPUT, type OutputItem, type OutputSink, type ResponsesBody, type ResponseObject, type ToolCall } from './types';
type Event = Record<string, unknown>;

/** The placeholder envelope progress frames carry before any backend output exists. */
export function pendingEnvelope(request: ResponsesBody): Record<string, unknown> {
  return { ...responseObject(request, EMPTY_OUTPUT), status: 'in_progress', output: [], usage: null };
}

/**
 * Emits `response.in_progress` every `heartbeatMs` so Codex's stream idle watchdog stays quiet while
 * the router waits out an outage. Native ignores the event itself. Returns the stop function; an
 * emitter that throws (closed socket) stops the timer on its own.
 */
export function startHeartbeat(emit: (event: Event) => void, pending: Record<string, unknown>, heartbeatMs = 10_000): () => void {
  let sequence = 0;
  const timer = setInterval(() => {
    try { emit({ type: 'response.in_progress', sequence_number: sequence++, response: pending }); }
    catch { clearInterval(timer); }
  }, heartbeatMs);
  return () => clearInterval(timer);
}

const textOf = (item: OutputItem | undefined): string => {
  const part = Array.isArray(item?.content) ? item.content[0] : undefined;
  return typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '';
};

type Streamed = { index: number; kind: 'message' | 'reasoning' | 'call'; item: OutputItem; text: string };

// Local backends stream the turn into Codex as it is written, the way OpenAI streams it: thinking as a
// reasoning item, text as message items, and each tool call as soon as it is complete (Codex starts it
// at once). Whatever the backend did not stream follows when it finishes. Native progress events keep
// the client stream alive during generation and reconnection.
export async function pendingResponse(request: ResponsesBody,
  generate: (signal: AbortSignal, sink: OutputSink) => Promise<ResponseObject>, signal: AbortSignal,
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

  const streamed: Streamed[] = [];
  let open: Streamed | undefined;
  let reached = false;
  const at = (entry: Streamed) => ({ item_id: entry.item.id, output_index: entry.index });
  const close = () => {
    const entry = open;
    if (!entry) return;
    open = undefined;
    if (entry.kind === 'message') {
      const part = { type: 'output_text', annotations: [], text: entry.text };
      entry.item = { ...entry.item, status: 'completed', content: [part] };
      send({ type: 'response.output_text.done', ...at(entry), content_index: 0, text: entry.text });
      send({ type: 'response.content_part.done', ...at(entry), content_index: 0, part });
    } else {
      const part = { type: 'summary_text', text: entry.text };
      entry.item = { ...entry.item, summary: [part] };
      send({ type: 'response.reasoning_summary_text.done', ...at(entry), summary_index: 0, text: entry.text });
      send({ type: 'response.reasoning_summary_part.done', ...at(entry), summary_index: 0, part });
    }
    send({ type: 'response.output_item.done', output_index: entry.index, item: entry.item });
  };
  const begin = (kind: 'message' | 'reasoning'): Streamed => {
    close();
    const entry: Streamed = kind === 'message'
      ? { index: streamed.length, kind, text: '', item: { id: randomId('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] } }
      : { index: streamed.length, kind, text: '', item: { id: randomId('rs'), type: 'reasoning', summary: [] } };
    streamed.push(entry);
    open = entry;
    send({ type: 'response.output_item.added', output_index: entry.index, item: entry.item });
    if (kind === 'message') send({ type: 'response.content_part.added', ...at(entry), content_index: 0, part: { type: 'output_text', annotations: [], text: '' } });
    else send({ type: 'response.reasoning_summary_part.added', ...at(entry), summary_index: 0, part: { type: 'summary_text', text: '' } });
    return entry;
  };
  const appendText = (delta: string) => {
    const entry = open?.kind === 'message' ? open : begin('message');
    reached = true;
    entry.text += delta;
    send({ type: 'response.output_text.delta', ...at(entry), content_index: 0, delta });
  };
  // A closed socket stops the turn; the backend sees it through the signal.
  const guarded = <T extends unknown[]>(fn: (...args: T) => void) => (...args: T) => {
    if (signal.aborted) return;
    try { fn(...args); } catch (error) { heartbeatAbort.abort(error); }
  };
  const sink: OutputSink = {
    get started() { return reached; },
    text: guarded((delta: string) => { if (delta) appendText(delta); }),
    reasoning: guarded((delta: string) => {
      if (!delta) return;
      const entry = open?.kind === 'reasoning' ? open : begin('reasoning');
      entry.text += delta;
      send({ type: 'response.reasoning_summary_text.delta', ...at(entry), summary_index: 0, delta });
    }),
    call: guarded((call: ToolCall) => {
      let item: OutputItem | undefined;
      // A call the router cannot render (bad computer or search arguments) waits for the final output, which reports it.
      try { item = responseObject(request, { ...EMPTY_OUTPUT, toolCalls: [call] }).output[0]; } catch { return; }
      if (!item) return;
      close();
      const entry: Streamed = { index: streamed.length, kind: 'call', item, text: '' };
      streamed.push(entry);
      reached = true;
      for (const event of itemEvents(item, entry.index)) send(event);
    }),
  };

  try {
    const generated = await generate(signal, sink);
    signal.throwIfAborted();
    let output = generated.output;
    if (streamed.length) {
      const final = output.find(item => item.type === 'message');
      const shown = streamed.filter(entry => entry.kind === 'message').map(entry => entry.text).join('');
      if (!final && generated.status === 'incomplete' && open?.kind === 'message') {
        // Interrupted mid-text: the partial message is closed as interrupted, like an OpenAI stream.
        send({ type: 'response.output_item.interrupted', response_id: empty.id, item_id: open.item.id, output_index: open.index });
        streamed.splice(streamed.indexOf(open), 1);
        open = undefined;
      } else {
        const text = textOf(final);
        if (text.startsWith(shown)) { if (text.length > shown.length) appendText(text.slice(shown.length)); }
        else logSafe('stream-text-diverged', { streamed: shown.length, final: text.length });
      }
      close();
      const calls = new Set(streamed.filter(entry => entry.kind === 'call').map(entry => entry.item.call_id));
      const rest = output.filter(item => item.type !== 'message' && !(item.call_id !== undefined && calls.has(item.call_id)));
      output = [...streamed.map(entry => entry.item), ...rest];
    }
    const response = { ...generated, output, id: empty.id, created_at: empty.created_at };
    remember?.(response);
    for (let index = streamed.length; index < output.length; index++) for (const event of itemEvents(output[index]!, index)) send(event);
    send({ type: response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', response });
    return response;
  } finally {
    clearInterval(timer);
    signal.removeEventListener('abort', cancel);
  }
}

export function pendingStream(request: ResponsesBody,
  generate: (signal: AbortSignal, sink: OutputSink) => Promise<ResponseObject>, signal: AbortSignal,
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

/**
 * A GPT turn that went offline before OpenAI answered. The SSE response opens at once with progress
 * frames; when `connect` resolves, the upstream stream is piped through verbatim (nothing had reached
 * Codex, so the turn simply starts late). An upstream refusal after reconnecting is delivered as a
 * `response.failed` built by `refused`, since the HTTP status is already committed. Codex cancelling
 * aborts the pending connection.
 */
export function pendingRelay(request: ResponsesBody,
  connect: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal,
  failure: (error: unknown) => Event, refused: (response: Response) => Promise<Event>,
  heartbeatMs = 10_000): Response {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(outgoing) {
      const frame = (event: Event) => outgoing.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      const done = () => outgoing.enqueue(encoder.encode('data: [DONE]\n\n'));
      const stop = startHeartbeat(frame, pendingEnvelope(request), heartbeatMs);
      void (async () => {
        try {
          const upstream = await connect(combined);
          stop();
          if (!upstream.ok) { frame(await refused(upstream)); done(); return; }
          const reader = upstream.body?.getReader();
          if (!reader) { frame(failure(new Error('Missing upstream response'))); done(); return; }
          try {
            for (;;) { const { value, done: ended } = await reader.read(); if (ended) break; if (value) outgoing.enqueue(value); }
          } finally { await reader.cancel().catch(() => {}); }
        } catch (error) {
          stop();
          if (combined.aborted) throw combined.reason;
          frame(failure(error)); done();
        }
      })().then(
        () => { if (!combined.aborted) outgoing.close(); else { try { outgoing.error(combined.reason); } catch {} } },
        (error) => { stop(); try { outgoing.error(error); } catch {} },
      );
    },
    cancel(reason) { controller.abort(reason); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
}
