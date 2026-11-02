import { expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Admission } from '../src/backends/admission';
import { ClaudeAccount } from '../src/backends/claude';
import { RetryBudget } from '../src/backends/retries';
import { functionTools } from '../src/protocol/native-tools';
import { checkToolArguments } from '../src/protocol/tool-schema';
import { responseObject, streamResponse } from '../src/protocol/output';
import { pendingResponse, pendingStream } from '../src/protocol/pending';
import { fitImage } from '../src/protocol/image-fit';
import { EMPTY_OUTPUT, type ResponsesRequest, type ResponseInputItem } from '../src/protocol/types';
import { upstreamAdmission } from '../src/router/admission';
import { HistoryCache, HistoryMiss } from '../src/router/history';
import { anthropicFixture, anthropicStream } from './anthropic-fixture';
import { scriptedCursor } from './cursor-sdk-fixture';

const env = (name: string, value: string) => { const before = process.env[name]; process.env[name] = value; return () => { if (before === undefined) delete process.env[name]; else process.env[name] = before; }; };

test('the actual interleaved stream is the Cursor continuation prefix, retaining one SDK run', async () => {
  const restore = env('CURSOR_TOOL_SETTLE_MS', '50');
  const f = await scriptedCursor();
  try {
    f.state.beforeToolText = 'about to call ';
    const first: ResponsesRequest = { model: 'kimi-k3', input: [{ role: 'user', content: 'PARALLEL' }], reasoning: { effort: 'high' }, tools: [{ type: 'function', name: 'echo', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] };
    const wire = await pendingResponse(first, async (signal, sink) => responseObject(first, await f.backend.run(first, signal, sink)), new AbortController().signal, () => {});
    expect(wire.output.map(item => item.type)).toEqual(['message', 'function_call', 'message', 'function_call']);
    const calls = wire.output.filter(item => item.type === 'function_call');
    const next: ResponsesRequest = { ...first, input: [...first.input as ResponseInputItem[], ...wire.output as ResponseInputItem[], ...calls.map(call => ({ type: 'function_call_output', call_id: String(call.call_id), output: 'result' }))] };
    const done = await f.backend.run(next);
    expect(done.text).toBe('got:result|result');
    expect(f.count('send')).toBe(1);
  } finally { restore(); await f.backend.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('Claude stop and cache metadata survive backend conversion and both event renderers', async () => {
  const f = anthropicFixture(); const file = f.credentials(); const claude = new ClaudeAccount(f.options(file));
  try {
    for (const [stop, status, terminal] of [['max_tokens', 'incomplete', 'response.incomplete'], ['refusal', 'incomplete', 'response.incomplete'], ['model_context_window_exceeded', 'failed', 'response.failed'], ['pause_turn', 'completed', 'response.completed']] as const) {
      f.state.replies.push(() => anthropicStream([{ type: 'text', text: 'partial' }], stop, { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 7 }));
      const request: ResponsesRequest = { model: 'claude-opus-5-5', input: 'fixture' };
      const output = await claude.run(request);
      const wire = responseObject(request, output);
      expect(wire.status).toBe(status);
      expect(wire.usage?.input_tokens_details?.cached_tokens).toBe(100);
      expect(await streamResponse(wire).text()).toContain(`event: ${terminal}`);
      const events: Record<string, unknown>[] = [];
      await pendingResponse(request, async (_signal, sink) => { sink.text('partial'); return wire; }, new AbortController().signal, event => events.push(event));
      expect(events.at(-1)?.type).toBe(terminal);
      if (stop === 'model_context_window_exceeded') expect(wire.error).toMatchObject({ code: 'context_length_exceeded' });
      if (stop === 'pause_turn') expect(wire.end_turn).toBe(false);
    }
  } finally { f.stop(); await rm(dirname(file), { recursive: true, force: true }); }
});

test('union translation represents every valid const/enum/type alternative, while intersections retain both bounds', () => {
  for (const union of ['oneOf', 'anyOf']) {
    const contract = { type: 'object', [union]: [
      { properties: { kind: { const: 'file' }, value: { type: 'string', enum: ['a'] } }, required: ['kind', 'value'], additionalProperties: false },
      { properties: { kind: { const: 'url' }, value: { type: 'number', minimum: 2 } }, required: ['kind', 'value'], additionalProperties: false },
    ] };
    const schema = functionTools([{ type: 'function', proxyName: 'pick', name: 'pick', contract }]).definitions.pick!.inputSchema;
    for (const valid of [{ kind: 'file', value: 'a' }, { kind: 'url', value: 2 }, { kind: 'url', value: 42 }]) {
      expect(checkToolArguments({ ...valid }, contract).issue).toBeUndefined();
      expect(checkToolArguments({ ...valid }, schema).issue).toBeUndefined();
    }
  }
  const contract = { allOf: [{ properties: { value: { type: 'number', minimum: 1 } } }, { properties: { value: { maximum: 3 } }, required: ['value'] }] };
  const schema = functionTools([{ type: 'function', proxyName: 'bounded', name: 'bounded', contract }]).definitions.bounded!.inputSchema;
  expect(checkToolArguments({ value: 2 }, schema).issue).toBeUndefined();
  expect(checkToolArguments({ value: 0 }, schema).issue).toBeDefined();
  expect(checkToolArguments({ value: 4 }, schema).issue).toBeDefined();
});

test('root and nested schema references preserve valid alternative values', () => {
  const contract = { $defs: { root: { anyOf: [{ properties: { a: { $ref: '#/$defs/value' } }, required: ['a'] }, { properties: { b: { type: 'number' } }, required: ['b'] }] }, value: { type: 'string' } }, $ref: '#/$defs/root' };
  const schema = functionTools([{ type: 'function', proxyName: 'refs', name: 'refs', contract }]).definitions.refs!.inputSchema;
  for (const valid of [{ a: 'x' }, { b: 2 }]) expect(checkToolArguments(valid, schema).issue).toBeUndefined();
});

test('history charges retained input, bounds independent/shared entries, and expires without a new request', async () => {
  let now = 0;
  const cache = new HistoryCache({ maxBytes: 1800, maxEntries: 10, ttlMs: 10, sweepMs: 5, now: () => now });
  try {
    const input = [{ role: 'user', content: 'x'.repeat(1000) }];
    const body = { model: 'fixture', input };
    cache.remember(body, { ...responseObject(body, EMPTY_OUTPUT), id: 'first' });
    expect(cache.retainedBytes).toBeGreaterThan(1000);
    cache.remember({ ...body, input: structuredClone(input) }, { ...responseObject(body, EMPTY_OUTPUT), id: 'second' });
    expect(cache.size).toBe(1);
    expect(cache.retainedBytes).toBeLessThanOrEqual(1800);
    expect(() => cache.expand({ previous_response_id: 'first', input: [] })).toThrow(HistoryMiss);
    expect(cache.expand({ previous_response_id: 'second', input: [] }).input).toEqual(input);
    now = 11; await Bun.sleep(20);
    expect(cache.size).toBe(0); expect(cache.retainedBytes).toBe(0);
  } finally { cache.close(); }
});

test('admission bounds active work, prioritizes continuations, aborts queued work and reuses released leases', async () => {
  const gate = new Admission('Fixture', 1, 2); const release = await gate.acquire();
  const order: string[] = [];
  const fresh = gate.acquire().then(done => { order.push('fresh'); done(); });
  const continued = gate.acquire(undefined, 1).then(done => { order.push('continued'); done(); });
  await expect(gate.acquire()).rejects.toThrow('queue is full');
  release(); await Promise.all([fresh, continued]); expect(order).toEqual(['continued', 'fresh']);
  const hold = await gate.acquire(); const controller = new AbortController();
  const cancelled = gate.acquire(controller.signal); controller.abort(new Error('cancelled'));
  await expect(cancelled).rejects.toThrow('cancelled'); hold(); (await gate.acquire())();
});

test('Cursor limits actual simultaneous SDK starts and cancels queued requests before model execution', async () => {
  const restore = env('CURSOR_MAX_ACTIVE', '2'); const f = await scriptedCursor(); const controller = new AbortController();
  const attempts = Array.from({ length: 8 }, (_, index) => f.backend.run({ model: 'kimi-k3', input: `HANG ${index}`, reasoning: { effort: 'high' } }, controller.signal));
  const settled = Promise.allSettled(attempts);
  try {
    for (let index = 0; index < 100 && f.count('send') < 2; index++) await Bun.sleep(2);
    expect(f.count('send')).toBe(2);
    controller.abort(); await settled; expect(f.count('send')).toBe(2);
  } finally { controller.abort(); await settled; restore(); await f.backend.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('shared async image conversions yield to other work and cancelling one waiter preserves the other', async () => {
  let conversions = 0; let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const shrink = async () => { conversions++; await pending; return new Uint8Array(3); };
  const controller = new AbortController();
  const first = fitImage('image/png', 'A'.repeat(100), 8, shrink, controller.signal);
  const second = fitImage('image/png', 'A'.repeat(100), 8, shrink);
  await Bun.sleep(1); expect(conversions).toBe(1);
  controller.abort(new Error('cancelled')); await expect(first).rejects.toThrow('cancelled');
  finish(); expect(await second).toMatchObject({ mediaType: 'image/jpeg' });
});

test('slow SSE consumers have bounded buffers and cancel generation without dropping executable events', async () => {
  const restore = env('STREAM_BUFFER_BYTES', '4096'); let aborted = false;
  try {
    const response = pendingStream({ model: 'fixture' }, async (signal, sink) => {
      for (let i = 0; i < 100 && !signal.aborted; i++) sink.text('x'.repeat(1024));
      aborted = signal.aborted; signal.throwIfAborted(); return responseObject({}, EMPTY_OUTPUT);
    }, new AbortController().signal, () => ({ type: 'error' }));
    await expect(response.text()).rejects.toThrow('not reading'); expect(aborted).toBe(true);
  } finally { restore(); }
});

test('one retry budget spans stream-open and fresh retries and respects provider delay hints', () => {
  const budget = new RetryBudget('Fixture', 2); budget.take();
  expect(budget.delay(new Headers({ 'retry-after': '0.01' }))).toBe(10);
  expect(budget.delay(new Headers({ 'retry-after-ms': '25' }))).toBe(25);
  expect(budget.delay(new Headers({ 'retry-after': '99999' }))).toBe(60_000);
  budget.take(); expect(budget.remaining).toBe(false); expect(() => budget.take()).toThrow('after 2 attempts');
});


test('image cache evicts by bytes and cancelling every waiter aborts the shared codec', async () => {
  const restore = env('IMAGE_CACHE_BYTES', '520'); let calls = 0;
  const shrink = async () => { calls++; return new Uint8Array(3); };
  try {
    for (const data of ['A', 'B', 'C', 'A']) await fitImage('image/png', data.repeat(100), 8, shrink);
    expect(calls).toBe(4);
  } finally { restore(); }
  let codecAborted = false;
  const controller = new AbortController();
  const active = fitImage('image/png', 'D'.repeat(100), 8, async (_bytes, _edge, signal) => {
    await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => { codecAborted = true; reject(signal.reason); }, { once: true }));
    return undefined;
  }, controller.signal);
  await Bun.sleep(1); controller.abort(new Error('all cancelled'));
  await expect(active).rejects.toThrow('all cancelled');
  await Bun.sleep(1); expect(codecAborted).toBe(true);
});


test('GPT admission remains leased until the body ends, and separate accounts do not block each other', async () => {
  const restore = env('GPT_MAX_ACTIVE', '1'); const wrap = upstreamAdmission(); let starts = 0;
  const fetch = wrap(async () => { starts++; return new Response(new ReadableStream<Uint8Array>({})); });
  const init = (account: string, signal?: AbortSignal): RequestInit => ({ method: 'POST', headers: { 'chatgpt-account-id': account }, body: '{"model":"gpt-fixture","input":[]}', signal });
  const url = 'https://chatgpt.com/backend-api/codex/responses';
  const controller = new AbortController();
  try {
    const one = await fetch(url, init('one')); const independent = await fetch(url, init('two'));
    const waiting = fetch(url, init('one', controller.signal));
    await Bun.sleep(1); expect(starts).toBe(2);
    controller.abort(new Error('queued cancel')); await expect(waiting).rejects.toThrow('queued cancel');
    await one.body?.cancel(); const next = await fetch(url, init('one')); expect(starts).toBe(3);
    await independent.body?.cancel(); await next.body?.cancel();
  } finally { controller.abort(); restore(); }
});

test('GPT admission cancels an aborted body and unlocks it before stalled source cleanup finishes', async () => {
  const restore = env('GPT_MAX_ACTIVE', '1');
  const controller = new AbortController();
  let cancelled: unknown, starts = 0;
  const source = new ReadableStream<Uint8Array>({ cancel(reason) { cancelled = reason; return new Promise<void>(() => {}); } });
  const fetch = upstreamAdmission()(async () => { starts++; return starts === 1 ? new Response(source) : new Response('next'); });
  const url = 'https://chatgpt.com/backend-api/codex/responses';
  const init = { method: 'POST', body: '{}' };
  try {
    const first = await fetch(url, { ...init, signal: controller.signal });
    const next = fetch(url, init);
    await Bun.sleep(1); expect(starts).toBe(1);
    const reason = new Error('stop owned stream'); controller.abort(reason);
    expect(cancelled).toBe(reason); expect(source.locked).toBe(false);
    expect(await (await next).text()).toBe('next');
    await first.body!.cancel();
  } finally { controller.abort(); restore(); }
});

test('GPT admission discards a transport body arriving after the request was cancelled', async () => {
  const controller = new AbortController();
  let resolve!: (response: Response) => void;
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const fetch = upstreamAdmission()(() => new Promise<Response>(done => { resolve = done; }));
  const pending = fetch('https://chatgpt.com/backend-api/codex/responses', { body: '{}', signal: controller.signal });
  await Bun.sleep(1); controller.abort(new Error('late response'));
  resolve(new Response(source));
  await expect(pending).rejects.toThrow('late response');
  expect(cancelled).toBe(true); expect(source.locked).toBe(false);
});
