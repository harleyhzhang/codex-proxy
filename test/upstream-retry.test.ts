import { afterAll, beforeAll, expect, test } from 'bun:test';
import { responseObject, streamResponse } from '../src/protocol/output';
import type { ResponsesBody } from '../src/protocol/types';
import { postJson, retryDelayMs } from '../src/router/upstream';
import { AUTH_HEADERS, fixtureRouter } from './support';

const saved = process.env.UPSTREAM_RETRY_BASE_MS;
beforeAll(() => { process.env.UPSTREAM_RETRY_BASE_MS = '1'; });

test('upstream backoff matches native Codex: 200ms doubling with 0.9-1.1 jitter', () => {
  expect(retryDelayMs(200, 0, () => 0)).toBe(180);
  expect(retryDelayMs(200, 0, () => 0.5)).toBe(200);
  expect(retryDelayMs(200, 3, () => 0.999999)).toBe(1759);
});
afterAll(() => { if (saved === undefined) delete process.env.UPSTREAM_RETRY_BASE_MS; else process.env.UPSTREAM_RETRY_BASE_MS = saved; });

const body: ResponsesBody = { model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'hi' }] };
const signal = () => AbortSignal.timeout(5_000);

test('a transient 5xx is retried until OpenAI answers', async () => {
  const statuses = [507, 503, 200];
  let calls = 0;
  const response = await postJson(async () => new Response('x', { status: statuses[calls++] }), '/responses', new Headers(), body, signal());
  expect(response.status).toBe(200);
  expect(calls).toBe(3);
});

test('4xx is returned at once and 5xx gives up after four retries, like native Codex', async () => {
  let calls = 0;
  expect((await postJson(async () => { calls++; return new Response('x', { status: 400 }); }, '/responses', new Headers(), body, signal())).status).toBe(400);
  expect(calls).toBe(1);
  calls = 0;
  expect((await postJson(async () => { calls++; return new Response('x', { status: 507 }); }, '/responses', new Headers(), body, signal())).status).toBe(507);
  expect(calls).toBe(5);
});

test('cancelling during a retry backoff stops at once instead of sleeping it out', async () => {
  process.env.UPSTREAM_RETRY_BASE_MS = '10000';
  try {
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(new Error('cancelled')), 50);
    await expect(postJson(async () => new Response('x', { status: 503 }), '/responses', new Headers(), body, controller.signal)).rejects.toThrow('cancelled');
    expect(performance.now() - started).toBeLessThan(2000);
  } finally { process.env.UPSTREAM_RETRY_BASE_MS = '1'; }
});

test('compaction survives a transient 507, and a lasting one reaches Codex as 507 rather than 400', async () => {
  let failuresLeft = 1;
  const app = await fixtureRouter({
    summaryKey: Buffer.alloc(32, 7),
    upstreamFetch: async (_url, init) => {
      if (failuresLeft-- > 0) return new Response('{}', { status: 507 });
      const request = JSON.parse(String(init.body)) as ResponsesBody;
      return streamResponse(responseObject(request, { text: 'SUMMARY', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }));
    },
  });
  const compaction = { ...body, input: [{ role: 'user', content: 'hi' }, { type: 'compaction_trigger' }] };
  try {
    const ok = await fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(compaction) });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(await ok.json())).toContain('"type":"compaction"');

    failuresLeft = 10;
    const failed = await fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(compaction) });
    expect(failed.status).toBe(507);
    const error = (await failed.json()) as { error: { type: string; message: string } };
    expect(error.error.type).toBe('server_error');
    expect(error.error.message).toContain('OpenAI compaction request failed HTTP 507');
  } finally {
    await app.close();
  }
});

test('a slow but steady compaction stream outlives the timeout, which bounds silence like native SSE', async () => {
  const app = await fixtureRouter({
    summaryKey: Buffer.alloc(32, 7),
    upstreamTimeoutMs: 150,
    upstreamFetch: async (_url, init) => {
      const request = JSON.parse(String(init.body)) as ResponsesBody;
      const text = await streamResponse(responseObject(request, { text: 'SUMMARY', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })).text();
      const events = text.split('\n\n').filter(Boolean).map((event) => `${event}\n\n`);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          // Honour the request signal like real fetch, so a total deadline would cut the stream.
          let aborted = false;
          init.signal?.addEventListener('abort', () => { aborted = true; controller.error(init.signal?.reason); });
          for (const event of events) {
            await Bun.sleep(60);
            if (aborted) return;
            controller.enqueue(encoder.encode(event));
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const compaction = { ...body, input: [{ role: 'user', content: 'hi' }, { type: 'compaction_trigger' }] };
  try {
    const started = Date.now();
    const ok = await fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(compaction) });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(await ok.json())).toContain('"type":"compaction"');
    expect(Date.now() - started).toBeGreaterThan(150);
  } finally {
    await app.close();
  }
});
