import { afterAll, beforeAll, expect, test } from 'bun:test';
import { isRecord, type JsonRecord } from '../src/json';
import { responseObject, streamResponse } from '../src/protocol/output';
import { sseEvents } from '../src/protocol/stream';
import type { ResponsesBody } from '../src/protocol/types';
import { CapacityBudget, retryAfterMs } from '../src/router/capacity';
import { postJson } from '../src/router/upstream';
import { AUTH_HEADERS, fixtureRouter } from './support';

const saved = process.env.UPSTREAM_CAPACITY_RETRY_BASE_MS;
beforeAll(() => { process.env.UPSTREAM_CAPACITY_RETRY_BASE_MS = '1'; });
afterAll(() => { if (saved === undefined) delete process.env.UPSTREAM_CAPACITY_RETRY_BASE_MS; else process.env.UPSTREAM_CAPACITY_RETRY_BASE_MS = saved; });

const error = { code: 'server_is_overloaded', type: 'server_error', message: 'synthetic capacity failure' };
const created = (id: string) => ({ type: 'response.created', response: { id, status: 'in_progress', output: [] } });
const failed = (id = 'failed-attempt', reason: JsonRecord = error) => ({ type: 'response.failed', response: { id, status: 'failed', error: reason } });
const sse = (...events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const body: ResponsesBody = { model: 'gpt-6.1-sol', stream: true, input: [{ role: 'user', content: 'resume' }] };
const success = (request: ResponsesBody = body) => streamResponse(responseObject(request, { text: 'RECOVERED', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }));
const signal = () => AbortSignal.timeout(5_000);
async function collect(response: Response): Promise<JsonRecord[]> {
  const events: JsonRecord[] = [];
  await sseEvents(response, event => events.push(event));
  return events;
}

test('Retry-After dates, seconds and milliseconds are honored without a short cap; hints beyond the window refuse retry', () => {
  expect(retryAfterMs(new Headers({ 'retry-after': '90' }), 1000)).toBe(90_000);
  expect(retryAfterMs(new Headers({ 'retry-after-ms': '1234' }), 1000)).toBe(1234);
  expect(retryAfterMs(new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:02:00 GMT' }), 1000)).toBe(119_000);
  expect(retryAfterMs(new Headers({ 'retry-after': 'garbage' }))).toBeUndefined();
  let now = 0;
  const budget = new CapacityBudget(120_000, 1000, () => now);
  expect(budget.delay(new Headers({ 'retry-after': '90' }))).toBe(90_000);
  now = 90_000;
  expect(budget.delay(new Headers({ 'retry-after': '31' }))).toBeUndefined();
  expect(new CapacityBudget(0).delay(new Headers())).toBeUndefined();
});

test('streamed capacity is retried on the same immutable request, dropping failed ids and scaffolding', async () => {
  const requests: string[] = [];
  const request: ResponsesBody = { ...body, reasoning: { effort: 'high' }, service_tier: 'default', input: [
    { role: 'user', content: 'install' },
    { type: 'function_call', name: 'install', call_id: 'already-ran', arguments: '{}' },
    { type: 'function_call_output', call_id: 'already-ran', output: 'installed successfully' },
  ] };
  const response = await postJson(async (_url, init) => {
    expect(new Headers(init.headers).get('chatgpt-account-id')).toBe('same-account');
    requests.push(String(init.body));
    if (requests.length <= 2) return sse(created('discard-' + requests.length), { type: 'response.output_item.added', item: { type: 'reasoning', id: 'discard-reasoning', summary: [] } }, failed());
    return success(request);
  }, '/responses', new Headers({ 'chatgpt-account-id': 'same-account' }), request, signal());
  const text = await response.text();
  expect(text).toContain('RECOVERED');
  expect(text).not.toContain('discard-');
  expect(text).not.toContain('server_is_overloaded');
  expect(requests).toHaveLength(3);
  expect(new Set(requests).size).toBe(1);
  expect(JSON.parse(requests[2])).toEqual(request);
});

test('HTTP overload and stream overload share recovery, including Retry-After; no nested native burst', async () => {
  const starts: number[] = [];
  const response = await postJson(async () => {
    starts.push(performance.now());
    if (starts.length === 1) return Response.json({ error }, { status: 503, headers: { 'retry-after-ms': '35' } });
    if (starts.length === 2) return sse({ ...failed(), headers: { 'Retry-After': '0.035' } });
    return success();
  }, '/responses', new Headers(), body, signal());
  expect(await response.text()).toContain('RECOVERED');
  expect(starts).toHaveLength(3);
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(30);
  expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(30);
});

test('plain JSON HTTP overload recovers without changing the final content type', async () => {
  let calls = 0;
  const response = await postJson(async () => ++calls === 1 ? Response.json({ error }, { status: 503 }) : Response.json({ ok: true }), '/responses', new Headers(), { ...body, stream: false }, signal());
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(calls).toBe(2);
});

test('capacity recovery ends at its deadline and preserves the final native classification', async () => {
  const savedWindow = process.env.UPSTREAM_CAPACITY_RECOVERY_MS;
  process.env.UPSTREAM_CAPACITY_RECOVERY_MS = '30';
  let calls = 0;
  try {
    const response = await postJson(async () => { calls++; return sse(created('never'), failed()); }, '/responses', new Headers(), body, signal());
    const events = await collect(response);
    expect(events.at(-1)).toMatchObject({ type: 'response.failed', response: { status: 'failed', error } });
    expect(events[0]?.type).toBe('response.created');
    expect(new Set(events.filter(event => isRecord(event.response)).map(event => (event.response as JsonRecord).id)).size).toBe(1);
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(10);
  } finally { if (savedWindow === undefined) delete process.env.UPSTREAM_CAPACITY_RECOVERY_MS; else process.env.UPSTREAM_CAPACITY_RECOVERY_MS = savedWindow; }
});

test('an HTTP Retry-After exceeding the window surfaces capacity immediately rather than retrying early', async () => {
  let calls = 0;
  const response = await postJson(async () => { calls++; return Response.json({ error }, { status: 503, headers: { 'retry-after': '121' } }); }, '/responses', new Headers(), body, signal());
  expect((await collect(response)).at(-1)).toMatchObject({ type: 'response.failed', response: { error } });
  expect(calls).toBe(1);
});

test('text, reasoning, tool scaffolding and completed calls each prevent any inference replay', async () => {
  for (const output of [
    { type: 'response.output_text.delta', delta: 'shown' },
    { type: 'response.reasoning_summary_text.delta', delta: 'shown reasoning' },
    { type: 'response.output_item.added', item: { type: 'function_call', name: 'install', call_id: 'call', arguments: '' } },
    { type: 'response.output_item.done', item: { type: 'function_call', name: 'install', call_id: 'call', arguments: '{}' } },
    { type: 'unknown_future_event', output: 'conservatively committed' },
  ]) {
    let calls = 0;
    const original = await sse(created('committed'), output, failed('committed')).text();
    const response = await postJson(async () => { calls++; return new Response(original, { headers: { 'content-type': 'text/event-stream' } }); }, '/responses', new Headers(), body, signal());
    expect(await response.text()).toBe(original);
    expect(calls).toBe(1);
  }
});

test('quota, authentication, context and policy errors remain terminal and keep their payload', async () => {
  for (const reason of [
    { code: 'insufficient_quota' }, { type: 'usage_limit_reached' }, { code: 'context_length_exceeded' },
    { code: 'cyber_policy' }, { code: 'invalid_prompt' }, { code: 'server_is_overloaded', type: 'usage_limit_reached' },
  ]) {
    let calls = 0;
    const original = await sse(created('terminal'), failed('terminal', reason)).text();
    const response = await postJson(async () => { calls++; return new Response(original, { headers: { 'content-type': 'text/event-stream' } }); }, '/responses', new Headers(), body, signal());
    expect(await response.text()).toBe(original);
    expect(calls).toBe(1);
  }
});

test('cancelling recovery during backoff releases its reader and never opens another request', async () => {
  let calls = 0, released = 0;
  const abort = new AbortController();
  const response = await postJson(async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      start(out) { out.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...failed(), headers: { 'retry-after': '1' } })}\n\n`)); },
      cancel() { released++; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }, '/responses', new Headers(), body, abort.signal);
  const reading = response.text();
  await Bun.sleep(20);
  abort.abort(new Error('cancel capacity'));
  await expect(reading).rejects.toThrow('cancel capacity');
  await Bun.sleep(20);
  expect(calls).toBe(1);
  expect(released).toBe(1);
});

test('body cancellation aborts the retry transport while it is waiting for headers', async () => {
  let calls = 0;
  let retrySignal: AbortSignal | undefined;
  const response = await postJson(async (_url, init) => {
    calls++;
    if (calls === 1) return sse(failed());
    retrySignal = init.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => retrySignal!.addEventListener('abort', () => reject(retrySignal!.reason), { once: true }));
  }, '/responses', new Headers(), body, signal());
  const reader = response.body!.getReader();
  const reading = reader.read();
  for (let i = 0; !retrySignal && i < 100; i++) await Bun.sleep(2);
  expect(retrySignal).toBeDefined();
  await reader.cancel('stopped');
  await reading;
  expect(retrySignal!.aborted).toBe(true);
  expect(calls).toBe(2);
});

test('pending recovery emits native progress heartbeats without exposing failed response ids', async () => {
  const savedHeartbeat = process.env.UPSTREAM_CAPACITY_HEARTBEAT_MS;
  process.env.UPSTREAM_CAPACITY_HEARTBEAT_MS = '5';
  let calls = 0;
  try {
    const response = await postJson(async () => ++calls === 1 ? sse({ ...failed(), headers: { 'retry-after-ms': '25' } }) : success(), '/responses', new Headers(), body, signal());
    const events = await collect(response);
    expect(events.some(event => event.type === 'response.in_progress')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('failed-attempt');
    expect(events.at(-1)?.type).toBe('response.completed');
  } finally { if (savedHeartbeat === undefined) delete process.env.UPSTREAM_CAPACITY_HEARTBEAT_MS; else process.env.UPSTREAM_CAPACITY_HEARTBEAT_MS = savedHeartbeat; }
});

test('Stop interrupts the stable response id while capacity recovery is waiting', async () => {
  let calls = 0;
  const app = await fixtureRouter({ upstreamFetch: async () => { calls++; return sse({ ...failed(), headers: { 'retry-after': '1' } }); } });
  const Socket = WebSocket as unknown as { new(url: string, options: { headers: typeof AUTH_HEADERS }): WebSocket };
  const socket = new Socket(app.url('/v1/responses').replace('http:', 'ws:'), { headers: AUTH_HEADERS });
  try {
    const events = await new Promise<JsonRecord[]>((resolve, reject) => {
      const events: JsonRecord[] = [];
      const timer = setTimeout(() => reject(new Error('interrupt timed out')), 2000);
      socket.onopen = () => socket.send(JSON.stringify({ ...body, type: 'response.create' }));
      socket.onmessage = event => {
        const value: unknown = JSON.parse(String(event.data));
        if (!isRecord(value)) return;
        events.push(value);
        if (value.type === 'response.created' && isRecord(value.response)) socket.send(JSON.stringify({ type: 'response.interrupt', response_id: value.response.id }));
        if (value.type === 'response.incomplete') { clearTimeout(timer); resolve(events); }
      };
    });
    expect(events.at(-1)).toMatchObject({ type: 'response.incomplete', response: { incomplete_details: { reason: 'interrupted' } } });
    await Bun.sleep(20);
    expect(calls).toBe(1);
  } finally { socket.close(); await app.close(); }
});

test('oversized metadata commits the attempt instead of retaining an unbounded replay buffer', async () => {
  let calls = 0;
  const chunks = [
    `data: ${JSON.stringify({ ...created('large'), padding: 'x'.repeat(1024 * 1024) })}\n\n`,
    `data: ${JSON.stringify(failed('large'))}\n\n`,
  ];
  const response = await postJson(async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({ start(out) { for (const chunk of chunks) out.enqueue(new TextEncoder().encode(chunk)); out.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  }, '/responses', new Headers(), body, signal());
  expect(await response.text()).toBe(chunks.join(''));
  expect(calls).toBe(1);
});

test('recovery does not eagerly drain a successful stream when the client stops reading', async () => {
  let reads = 0, released = 0;
  const events = [created('slow-consumer'), { type: 'response.output_text.delta', delta: 'first' }, { type: 'response.output_text.delta', delta: 'next' }];
  const response = await postJson(async () => new Response(new ReadableStream<Uint8Array>({
    pull(out) { reads++; out.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(events[Math.min(reads - 1, 2)])}\n\n`)); },
    cancel() { released++; },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }), '/responses', new Headers(), body, signal());
  expect(reads).toBe(0);
  const reader = response.body!.getReader();
  await reader.read();
  expect(reads).toBe(2);
  await Bun.sleep(10);
  expect(reads).toBe(2);
  await reader.cancel();
  expect(released).toBe(1);
});

test('HTTP SSE, client WebSocket and compaction all recover a pre-output capacity failure', async () => {
  for (const transport of ['sse', 'ws', 'compact']) {
    let calls = 0;
    const app = await fixtureRouter({ summaryKey: Buffer.alloc(32, 4), upstreamFetch: async (_url, init) => {
      calls++;
      if (calls === 1) return sse(created('lost'), failed());
      return success(JSON.parse(String(init.body)) as ResponsesBody);
    } });
    try {
      const request = transport === 'compact' ? { ...body, input: [{ role: 'user', content: 'hi' }, { type: 'compaction_trigger' }] } : body;
      if (transport === 'ws') {
        const Socket = WebSocket as unknown as { new(url: string, options: { headers: typeof AUTH_HEADERS }): WebSocket };
        const socket = new Socket(app.url('/v1/responses').replace('http:', 'ws:'), { headers: AUTH_HEADERS });
        const events: JsonRecord[] = [];
        await new Promise<void>((resolve, reject) => {
          socket.onopen = () => socket.send(JSON.stringify({ ...request, type: 'response.create' }));
          socket.onerror = () => reject(new Error('socket failed'));
          socket.onmessage = event => { const value: unknown = JSON.parse(String(event.data)); if (isRecord(value)) { events.push(value); if (value.type === 'response.completed') resolve(); } };
        });
        socket.close();
        expect(JSON.stringify(events)).toContain('RECOVERED');
        expect(JSON.stringify(events)).not.toContain('server_is_overloaded');
      } else {
        const response = await fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(request) });
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(text).toContain(transport === 'compact' ? '"type":"compaction"' : 'RECOVERED');
        expect(text).not.toContain('server_is_overloaded');
      }
      expect(calls).toBe(2);
    } finally { await app.close(); }
  }
});
