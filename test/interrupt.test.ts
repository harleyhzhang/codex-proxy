// Codex's InstantInterrupt: `response.interrupt` stops a running WebSocket turn, which finishes as
// `response.incomplete` (reason `interrupted`) and stays continuable by `previous_response_id`.
import { describe, expect, test } from 'bun:test';
import type { SubscriptionBackend } from '../src/backends/contract';
import { BACKENDS } from '../src/backends/registry';
import type { ResponsesBody } from '../src/protocol/types';
import { EMPTY_OUTPUT } from '../src/protocol/types';
import { responseObject, streamResponse } from '../src/protocol/output';
import { AUTH_HEADERS, fixtureRouter } from './support';

const GPT = 'gpt-6.1-sol';
const request = (model: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'response.create', model, stream: true, input: [{ role: 'user', content: 'hello' }], ...extra });
const frame = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const DONE_ITEM = { id: 'msg_done', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'KEPT', annotations: [] }] };

/** An OpenAI stream that sends one finished item, opens a second, then waits until aborted. */
function stalledUpstream(signal: AbortSignal | null | undefined): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(out) {
      out.enqueue(encoder.encode([
        frame({ type: 'response.created', response: { id: 'resp_up', object: 'response', status: 'in_progress', output: [] } }),
        frame({ type: 'response.output_item.added', output_index: 0, item: { ...DONE_ITEM, status: 'in_progress', content: [] } }),
        frame({ type: 'response.output_item.done', output_index: 0, item: DONE_ITEM }),
        frame({ type: 'response.output_item.added', output_index: 1, item: { id: 'rs_partial', type: 'reasoning', summary: [] } }),
      ].join('')));
      signal?.addEventListener('abort', () => { try { out.error(signal.reason); } catch {} }, { once: true });
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function socket(app: Awaited<ReturnType<typeof fixtureRouter>>) {
  const Socket = WebSocket as unknown as { new (url: string, options: { headers: Record<string, string> }): WebSocket };
  const ws = new Socket(app.url('/v1/responses').replace('http:', 'ws:'), { headers: AUTH_HEADERS });
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('socket failed')); });
  const events: any[] = [];
  const waiters: Array<{ type: string; resolve: (event: any) => void }> = [];
  ws.onmessage = (e) => {
    const event = JSON.parse(String(e.data));
    events.push(event);
    for (const waiter of waiters.splice(0)) { if (waiter.type === event.type) waiter.resolve(event); else waiters.push(waiter); }
  };
  const next = (type: string) => new Promise<any>((resolve, reject) => {
    const found = events.find(e => e.type === type);
    if (found) { events.splice(events.indexOf(found), 1); return resolve(found); }
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 4000);
    waiters.push({ type, resolve: (event) => { clearTimeout(timer); events.splice(events.indexOf(event), 1); resolve(event); } });
  });
  return { ws, events, next };
}

describe('response.interrupt', () => {
  for (const local of [true, false]) for (const lateSuccess of [true, false]) test(`compaction interruption preserves original continuable history: local=${local}, lateSuccess=${lateSuccess}`, async () => {
    const backend = BACKENDS[0]!; const original = backend.run;
    const model = local ? Object.keys(backend.models)[0]! : GPT;
    const bodies: ResponsesBody[] = [];
    let aborted = false;
    const summary = { ...EMPTY_OUTPUT, text: 'This summary must never replace the original history.' };
    backend.run = async (body, signal) => {
      bodies.push(body);
      if (bodies.length > 1) return { ...EMPTY_OUTPUT, text: 'continued' };
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => { aborted = true; if (lateSuccess) resolve(summary); else reject(signal.reason); }, { once: true });
      });
    };
    const app = await fixtureRouter({ summaryKey: Buffer.alloc(32, 3), upstreamFetch: async (_url, init) => {
      const body = JSON.parse(String(init.body)) as ResponsesBody; bodies.push(body);
      if (bodies.length > 1) return streamResponse(responseObject(body, { ...EMPTY_OUTPUT, text: 'continued' }));
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => { aborted = true; if (lateSuccess) resolve(streamResponse(responseObject(body, summary))); else reject(init.signal?.reason); }, { once: true });
      });
    } });
    const { ws, next } = await socket(app);
    try {
      ws.send(JSON.stringify(request(model, { input: [{ role: 'user', content: 'ORIGINAL_HISTORY' }, { type: 'compaction_trigger' }] })));
      const created = await next('response.created');
      ws.send(JSON.stringify({ type: 'response.interrupt', response_id: created.response.id }));
      await next('response.interrupt.accepted');
      const incomplete = await next('response.incomplete');
      expect(aborted).toBe(true);
      expect(incomplete.response).toMatchObject({ id: created.response.id, status: 'incomplete', incomplete_details: { reason: 'interrupted' }, output: [] });
      ws.send(JSON.stringify(request(model, { previous_response_id: created.response.id, input: [{ role: 'user', content: 'continue original' }] })));
      await next('response.completed');
      expect(bodies).toHaveLength(2);
      const replay = JSON.stringify(bodies[1]?.input);
      expect(replay).toContain('ORIGINAL_HISTORY'); expect(replay).toContain('continue original');
      expect(replay).not.toContain('compaction_trigger'); expect(replay).not.toContain('This summary must never'); expect(replay).not.toContain('encrypted_content');
    } finally { backend.run = original; ws.close(); await app.close(); }
  });
  test('a GPT turn stops, keeps finished items and continues from its id', async () => {
    const bodies: ResponsesBody[] = [];
    const app = await fixtureRouter({ upstreamFetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as ResponsesBody);
      if (bodies.length === 1) return stalledUpstream(init.signal);
      return new Response(frame({ type: 'response.completed', response: { id: 'resp_next', status: 'completed', output: [] } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
    const { ws, events, next } = await socket(app);
    try {
      ws.send(JSON.stringify(request(GPT)));
      const created = await next('response.created');
      await next('response.output_item.done');
      ws.send(JSON.stringify({ type: 'response.interrupt', response_id: created.response.id, mode: 'discard_partial_items' }));
      expect(await next('response.interrupt.accepted')).toMatchObject({ response_id: 'resp_up' });
      expect(await next('response.output_item.interrupted')).toMatchObject({ response_id: 'resp_up', item_id: 'rs_partial', output_index: 1 });
      const incomplete = await next('response.incomplete');
      expect(incomplete.response).toMatchObject({ id: 'resp_up', status: 'incomplete', incomplete_details: { reason: 'interrupted' } });
      expect(incomplete.response.output.map((item: any) => item.id)).toEqual(['msg_done']);

      ws.send(JSON.stringify(request(GPT, { previous_response_id: 'resp_up', input: [{ role: 'user', content: 'steer' }] })));
      await next('response.completed');
      const replay = JSON.stringify(bodies[1]?.input);
      expect(replay).toContain('KEPT');
      expect(replay).toContain('steer');
      expect(replay).not.toContain('rs_partial');
      expect(events.some(e => e.type === 'error')).toBe(false);
    } finally { ws.close(); await app.close(); }
  });

  test('a subscription turn is cancelled and finishes empty', async () => {
    const backend = BACKENDS[0] as SubscriptionBackend;
    const model = Object.keys(backend.models)[0] ?? '';
    const original = backend.run;
    let cancelled = false;
    backend.run = (_request, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true });
    });
    const app = await fixtureRouter();
    const { ws, next } = await socket(app);
    try {
      ws.send(JSON.stringify(request(model)));
      const created = await next('response.created');
      ws.send(JSON.stringify({ type: 'response.interrupt', response_id: created.response.id, mode: 'discard_partial_items' }));
      await next('response.interrupt.accepted');
      const incomplete = await next('response.incomplete');
      expect(incomplete.response).toMatchObject({ id: created.response.id, status: 'incomplete', output: [], incomplete_details: { reason: 'interrupted' } });
      expect(cancelled).toBe(true);
    } finally { backend.run = original; ws.close(); await app.close(); }
  });

  test('an interrupt that arrives after the turn finished is only acknowledged', async () => {
    const app = await fixtureRouter({ upstreamFetch: async () =>
      new Response(frame({ type: 'response.completed', response: { id: 'resp_fast', status: 'completed', output: [] } }), { headers: { 'content-type': 'text/event-stream' } }) });
    const { ws, events, next } = await socket(app);
    try {
      ws.send(JSON.stringify(request(GPT)));
      await next('response.completed');
      ws.send(JSON.stringify({ type: 'response.interrupt', response_id: 'resp_fast', mode: 'discard_partial_items' }));
      expect(await next('response.interrupt.accepted')).toMatchObject({ response_id: 'resp_fast' });
      ws.send(JSON.stringify(request(GPT)));
      await next('response.completed');
      expect(events.some(e => e.type === 'error')).toBe(false);
    } finally { ws.close(); await app.close(); }
  });
});
