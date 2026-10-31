// Every model row × every failure mode × every transport (plain HTTP, SSE stream, WebSocket).
// Rows: GPT (OpenAI relay), every registered subscription backend, plus the optional secondary
// Claude account and Cursor bridge registered here under the production `poly-` prefixes so the
// router is exercised with the exact slugs the live catalog serves.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { configuredClaudeAccount } from '../src/backends/claude';
import { ClaudeUsageLimitError } from '../src/backends/claude-limits';
import { BackendError, type SubscriptionBackend } from '../src/backends/contract';
import { configuredCursorBackend } from '../src/backends/cursor';
import { withOpusQuotaFallback } from '../src/backends/quota-fallback';
import { BACKENDS, publicModels } from '../src/backends/registry';
import { responseObject, streamResponse } from '../src/protocol/output';
import { MAX_BODY_BYTES } from '../src/protocol/stream';
import type { ProxyOutput, ResponsesBody } from '../src/protocol/types';
import { AUTH_HEADERS, fixtureRouter } from './support';

const GPT = 'gpt-6.1-sol';
const INTERNAL = 'Internal router error; Codex will retry.';
const OK: ProxyOutput = { text: 'FINE', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
const savedBase = process.env.UPSTREAM_RETRY_BASE_MS;
const savedOffline = process.env.OFFLINE_RETRY_BASE_MS;
let scratch = '';
const extraRows: SubscriptionBackend[] = [];

beforeAll(async () => {
  process.env.UPSTREAM_RETRY_BASE_MS = '1';
  process.env.OFFLINE_RETRY_BASE_MS = '5';
  scratch = await mkdtemp(tmpdir() + '/failure-matrix-');
  await Bun.write(scratch + '/bridge', '#!/bin/sh\nexit 1\n');
  // The same constructors the live launcher uses, with the production prefixes.
  const polyClaude = configuredClaudeAccount({ CLAUDE_ACCOUNT_CONFIG_DIR: scratch, CLAUDE_ACCOUNT_MODEL_PREFIX: 'poly', CLAUDE_ACCOUNT_LABEL: 'Polymarket', CLAUDE_ACCOUNT_MODELS: 'claude-opus-5-5,claude-fable-5-1' })?.backend;
  await Bun.write(scratch + '/cursor-auth.json', '{}');
  const polyCursor = configuredCursorBackend({
    CURSOR_BRIDGE_BIN: scratch + '/bridge', CURSOR_BRIDGE_SHA256: 'a'.repeat(64), CURSOR_AUTH_FILE: scratch + '/cursor-auth.json', CURSOR_CWD: scratch,
    CURSOR_EXPECTED_EMAIL: 'fixture@example.com', CURSOR_EXPECTED_USER_ID: 'user_fixture', CURSOR_MODEL_PREFIX: 'poly-cursor', CURSOR_LABEL: 'Cursor',
  });
  for (const row of [polyClaude, polyCursor]) if (row) extraRows.push(row);
  (BACKENDS as SubscriptionBackend[]).push(...extraRows);
});
afterAll(async () => {
  for (const row of extraRows) { const at = BACKENDS.indexOf(row); if (at >= 0) (BACKENDS as SubscriptionBackend[]).splice(at, 1); }
  if (savedBase === undefined) delete process.env.UPSTREAM_RETRY_BASE_MS; else process.env.UPSTREAM_RETRY_BASE_MS = savedBase;
  if (savedOffline === undefined) delete process.env.OFFLINE_RETRY_BASE_MS; else process.env.OFFLINE_RETRY_BASE_MS = savedOffline;
  await rm(scratch, { recursive: true, force: true });
});

const request = (model: string, extra: Record<string, unknown> = {}): ResponsesBody & Record<string, unknown> =>
  ({ model, input: [{ role: 'user', content: 'hello' }], ...extra });
/** Parses SSE data frames, skipping any that are not JSON (like the native client does). */
const sse = (text: string) => text.split('\n').filter(l => l.startsWith('data: ')).flatMap(l => {
  try { return [JSON.parse(l.slice(6)) as any]; } catch { return []; }
});
const last = (text: string) => { const events = sse(text); return events[events.length - 1]; };
async function withRun<T>(backend: SubscriptionBackend, run: SubscriptionBackend['run'], body: () => Promise<T>): Promise<T> {
  const original = backend.run; backend.run = run;
  try { return await body(); } finally { backend.run = original; }
}
type App = Awaited<ReturnType<typeof fixtureRouter>>;
const post = (app: App, body: unknown, init: RequestInit = {}) =>
  fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(body), ...init });

/** Sends one response.create over a fresh socket and resolves with the first terminal frame. */
async function socketTurn(app: App, body: unknown, timeoutMs = 4000): Promise<any> {
  const Socket = WebSocket as unknown as { new (url: string, options: { headers: Record<string, string> }): WebSocket };
  const ws = new Socket(app.url('/v1/responses').replace('http:', 'ws:'), { headers: AUTH_HEADERS });
  try {
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket turn timed out')), timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'response.create', ...(body as object) }));
      ws.onerror = () => { clearTimeout(timer); reject(new Error('socket failed')); };
      ws.onclose = (e) => { clearTimeout(timer); resolve({ type: 'close', code: e.code, reason: e.reason }); };
      ws.onmessage = (e) => {
        const event = JSON.parse(String(e.data));
        if (['response.failed', 'response.completed', 'error'].includes(event.type)) { clearTimeout(timer); resolve(event); }
      };
    });
  } finally { ws.close(); }
}

// ---------------------------------------------------------------------------------------------
// Subscription rows: claude-*, grok-*, poly-claude-*, poly-cursor-* (every public slug).
// ---------------------------------------------------------------------------------------------
describe('subscription models × failure modes', () => {
  const rows = () => BACKENDS.flatMap(backend => publicModels(backend).map(model => ({ backend, model })));

  test('registered rows cover the live catalog families', () => {
    const models = rows().map(r => r.model);
    for (const expected of ['claude-opus-5-5', 'grok-', 'poly-claude-opus-5-5', 'poly-cursor-']) expect(models.some(m => m.startsWith(expected))).toBe(true);
  });

  test('a terminal refusal reaches Codex with the backend message on every transport and is never retried', async () => {
    const app = await fixtureRouter();
    try {
      for (const { backend, model } of rows()) {
        let calls = 0;
        await withRun(backend, async () => { calls++; throw new BackendError(`${backend.name} refused: fixture`, { code: 'fixture_refusal' }); }, async () => {
          const plain = await post(app, request(model));
          expect(plain.status).toBe(400);
          const error = ((await plain.json()) as any).error;
          expect(error).toMatchObject({ type: 'invalid_request_error', code: 'fixture_refusal' });
          expect(error.message).toContain('refused: fixture');

          const stream = await post(app, request(model, { stream: true }));
          expect(stream.status).toBe(200);
          const failed = last(await stream.text());
          expect(failed.type).toBe('response.failed');
          expect(failed.response.error).toMatchObject({ code: 'invalid_prompt' });
          expect(failed.response.error.message).toContain('refused: fixture');

          const ws = await socketTurn(app, request(model, { stream: true }));
          expect(ws.type).toBe('response.failed');
          expect(ws.response.error.code).toBe('invalid_prompt');
          expect(calls).toBe(3);
        });
      }
    } finally { await app.close(); }
  });

  test('a retryable refusal that keeps failing still terminates with the message, not an internal error', async () => {
    const app = await fixtureRouter();
    try {
      for (const { backend, model } of rows()) {
        await withRun(backend, async () => { throw new BackendError('bad arguments every time', { retryable: true }); }, async () => {
          const failed = last(await (await post(app, request(model, { stream: true }))).text());
          expect(failed.response.error.code).toBe('invalid_prompt');
          expect(failed.response.error.message).toContain('bad arguments');
        });
      }
    } finally { await app.close(); }
  });

  test('an unexpected crash inside a backend is a retryable 500 server_error that never leaks the diagnostic', async () => {
    const app = await fixtureRouter();
    try {
      for (const { backend, model } of rows()) {
        await withRun(backend, async () => { throw new TypeError('SECRET undefined is not a function'); }, async () => {
          const plain = await post(app, request(model));
          expect(plain.status).toBe(500);
          const text = await plain.text();
          expect(JSON.parse(text).error).toMatchObject({ type: 'server_error', code: 'server_error', message: INTERNAL });
          expect(text).not.toContain('SECRET');

          const stream = await (await post(app, request(model, { stream: true }))).text();
          expect(last(stream).response.error).toMatchObject({ code: 'server_error', message: INTERNAL });
          expect(stream).not.toContain('SECRET');

          const ws = await socketTurn(app, request(model, { stream: true }));
          expect(ws).toMatchObject({ type: 'error', status: 500 });
          expect(ws.error).toMatchObject({ type: 'server_error', code: 'server_error', message: INTERNAL });
        });
      }
    } finally { await app.close(); }
  });

  test('CLI network drops keep the turn pending until the network returns; timeouts stay terminal', async () => {
    const app = await fixtureRouter({ heartbeatMs: 20 });
    const reset = () => Object.assign(new Error('SECRET socket path'), { code: 'ECONNRESET' });
    try {
      for (const { backend, model } of rows()) {
        // Plain JSON has no channel for heartbeats, so a drop is a 503 the client may retry.
        await withRun(backend, async () => { throw reset(); }, async () => {
          const plain = await post(app, request(model));
          expect(plain.status).toBe(503);
          const text = await plain.text();
          expect(JSON.parse(text).error.type).toBe('server_error');
          expect(text).toContain('Network connection interrupted'); expect(text).not.toContain('SECRET');
        });

        // Streams and sockets ride out the outage: the same request stays pending with
        // response.in_progress heartbeats and completes once the backend reconnects.
        for (const transport of ['stream', 'socket'] as const) {
          let calls = 0;
          await withRun(backend, async () => { if (++calls <= 3) throw reset(); return OK; }, async () => {
            if (transport === 'stream') {
              const stream = await (await post(app, request(model, { stream: true }))).text();
              const events = sse(stream);
              expect(events.some(e => e.type === 'response.in_progress')).toBe(true);
              expect(last(stream).type).toBe('response.completed');
              expect(stream).toContain('FINE'); expect(stream).not.toContain('SECRET');
            } else {
              const ws = await socketTurn(app, request(model, { stream: true }));
              expect(ws.type).toBe('response.completed');
              expect(JSON.stringify(ws)).toContain('FINE'); expect(JSON.stringify(ws)).not.toContain('SECRET');
            }
            expect(calls).toBe(4);
          });
        }

        // A backend deadline is not an outage: every transport reports it once, safely.
        await withRun(backend, async () => { throw new DOMException('SECRET deadline', 'TimeoutError'); }, async () => {
          const plain = await post(app, request(model));
          expect(plain.status).toBe(503);
          const text = await plain.text();
          expect(text).toContain('timed out'); expect(text).not.toContain('SECRET');

          const stream = await (await post(app, request(model, { stream: true }))).text();
          expect(last(stream).response.error.code).toBe('server_error');
          expect(stream).toContain('timed out'); expect(stream).not.toContain('SECRET');

          const ws = await socketTurn(app, request(model, { stream: true }));
          expect(ws.type).toBe('response.failed');
          expect(ws.response.error.code).toBe('server_error');
          expect(JSON.stringify(ws)).not.toContain('SECRET');
        });
      }
    } finally { await app.close(); }
  });

  test('a client cancelling mid-generation aborts the backend and the router keeps serving', async () => {
    const app = await fixtureRouter();
    try {
      for (const { backend, model } of rows()) {
        let seen: AbortSignal | undefined; let started = Promise.withResolvers<void>();
        await withRun(backend, (_request, signal) => { seen = signal; started.resolve(); return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))); }, async () => {
          const controller = new AbortController();
          const inflight = post(app, request(model, { stream: true }), { signal: controller.signal }).catch(e => e);
          await started.promise;
          controller.abort();
          await inflight;
          for (let i = 0; i < 50 && !seen?.aborted; i++) await Bun.sleep(10);
          expect(seen?.aborted).toBe(true);
        });
        await withRun(backend, async () => OK, async () => {
          const next = await post(app, request(model));
          expect(next.status).toBe(200);
          expect(JSON.stringify(await next.json())).toContain('FINE');
        });
      }
    } finally { await app.close(); }
  });

  test('warmups never run the backend and a pre-generation quota gate refuses before the CLI starts', async () => {
    const app = await fixtureRouter();
    try {
      for (const { backend, model } of rows()) {
        let calls = 0;
        await withRun(backend, async () => { calls++; return OK; }, async () => {
          expect((await post(app, request(model, { generate: false }))).status).toBe(200);
          expect(calls).toBe(0);
          const original = backend.assertAvailable;
          backend.assertAvailable = () => { throw new ClaudeUsageLimitError('five_hour', Math.floor(Date.now() / 1000) + 600); };
          try {
            const refused = await post(app, request(model));
            expect(refused.status).toBe(400);
            const error = ((await refused.json()) as any).error;
            expect(error.code).toBe('claude_usage_limit_reached');
            expect(error.message).toContain('limit reached');
            expect(calls).toBe(0);
            // Warmups are unaffected by the gate.
            expect((await post(app, request(model, { generate: false }))).status).toBe(200);
          } finally { if (original) backend.assertAvailable = original; else delete (backend as { assertAvailable?: unknown }).assertAvailable; }
        });
      }
    } finally { await app.close(); }
  });

  test('typos inside a reserved namespace are refused by name and never reach OpenAI', async () => {
    let upstreamCalls = 0;
    const app = await fixtureRouter({ upstreamFetch: async () => { upstreamCalls++; return new Response('{}', { status: 200 }); } });
    try {
      for (const backend of BACKENDS) {
        const response = await post(app, request(`${backend.reservedPrefix}-does-not-exist`));
        expect(response.status).toBe(400);
        expect(((await response.json()) as any).error.message).toContain(`Unsupported ${backend.name} model`);
      }
      expect(upstreamCalls).toBe(0);
    } finally { await app.close(); }
  });

  test('compaction for a subscription model is refused with the local-compaction hint on every transport', async () => {
    const app = await fixtureRouter({ summaryKey: Buffer.alloc(32, 3) });
    try {
      for (const { model } of rows()) {
        const response = await fetch(app.url('/v1/responses/compact'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(request(model)) });
        expect(response.status).toBe(400);
        expect(((await response.json()) as any).error.message).toContain('Use Codex local compaction');
      }
    } finally { await app.close(); }
  });

  test('the Opus quota fallback only swaps suppliers for Opus usage limits, never for other refusals or cancelled turns', async () => {
    const limit = () => new ClaudeUsageLimitError('five_hour', Math.floor(Date.now() / 1000) + 60);
    const make = (run: SubscriptionBackend['run'], name: string): SubscriptionBackend => ({ name, models: { 'claude-opus-5-5': 'opus', 'claude-fable-5-1': 'fable' }, reservedPrefix: 'x', catalog: [], run });
    let fallbackCalls = 0;
    const fallback = make(async () => { fallbackCalls++; return { ...OK, text: 'FROM CURSOR' }; }, 'Cursor');
    const wrapped = withOpusQuotaFallback(make(async (req) => { if (req.model === 'claude-opus-5-5') throw limit(); throw new BackendError('fable refused'); }, 'Claude'), fallback);
    const opus = await wrapped.run(request('claude-opus-5-5') as any);
    expect(opus.text).toContain('FROM CURSOR'); expect(opus.text).toContain('usage limit'); expect(fallbackCalls).toBe(1);
    await expect(wrapped.run(request('claude-fable-5-1') as any)).rejects.toThrow('fable refused');
    const aborted = new AbortController(); aborted.abort();
    await expect(wrapped.run(request('claude-opus-5-5') as any, aborted.signal)).rejects.toThrow();
    expect(fallbackCalls).toBe(1);
    // A non-quota Opus failure is not masked by the fallback either.
    const crashing = withOpusQuotaFallback(make(async () => { throw new BackendError('opus refused'); }, 'Claude'), fallback);
    await expect(crashing.run(request('claude-opus-5-5') as any)).rejects.toThrow('opus refused');
    expect(fallbackCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// GPT row: the OpenAI relay, retried and classified like the native Codex client.
// ---------------------------------------------------------------------------------------------
describe('gpt models × upstream failure modes', () => {
  const success = (init: RequestInit) => streamResponse(responseObject(JSON.parse(String(init.body)) as ResponsesBody, { text: 'UPSTREAM OK', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }));

  test('every transient 5xx is retried until OpenAI answers, on plain, stream and socket transports', async () => {
    for (const status of [500, 502, 503, 504, 507, 529]) {
      let failuresLeft = 2; let calls = 0;
      const app = await fixtureRouter({ upstreamFetch: async (_url, init) => { calls++; if (failuresLeft-- > 0) return new Response('{"error":{"message":"overloaded"}}', { status }); return success(init); } });
      try {
        expect((await post(app, request(GPT))).status).toBe(200); expect(calls).toBe(3);
        failuresLeft = 2; calls = 0;
        expect(last(await (await post(app, request(GPT, { stream: true }))).text()).type).toBe('response.completed'); expect(calls).toBe(3);
        failuresLeft = 2; calls = 0;
        expect((await socketTurn(app, request(GPT, { stream: true }))).type).toBe('response.completed'); expect(calls).toBe(3);
      } finally { await app.close(); }
    }
  });

  test('a lasting 5xx gives up after four retries and reaches Codex with the real status as server_error', async () => {
    for (const status of [500, 502, 503, 507]) {
      let calls = 0;
      const app = await fixtureRouter({ upstreamFetch: async () => { calls++; return new Response('{"error":{"message":"still down"}}', { status }); } });
      try {
        const plain = await post(app, request(GPT));
        expect(plain.status).toBe(status); expect(calls).toBe(5);
        // Plain HTTP relays the upstream body verbatim so Codex sees exactly what OpenAI said.
        expect(await plain.text()).toContain('still down');
        calls = 0;
        const ws = await socketTurn(app, request(GPT, { stream: true }));
        expect(ws).toMatchObject({ type: 'error', status }); expect(ws.error.type).toBe('server_error'); expect(calls).toBe(5);
      } finally { await app.close(); }
    }
  });

  test('4xx answers pass through once with their status and are never retried (429 included, like native)', async () => {
    for (const status of [400, 401, 403, 404, 413, 429]) {
      let calls = 0;
      const app = await fixtureRouter({ upstreamFetch: async () => { calls++; return new Response(JSON.stringify({ error: { type: 'upstream', message: `upstream said ${status}` } }), { status, headers: { 'content-type': 'application/json', 'x-codex-primary-used-percent': '100', 'x-request-id': 'req_1', 'set-cookie': 'secret=1' } }); } });
      try {
        const plain = await post(app, request(GPT));
        expect(plain.status).toBe(status); expect(calls).toBe(1);
        expect(await plain.text()).toContain(`upstream said ${status}`);
        calls = 0;
        const ws = await socketTurn(app, request(GPT, { stream: true }));
        expect(ws.type).toBe('error'); expect(ws.status).toBe(status); expect(calls).toBe(1);
        // Native reads rate-limit and request-id headers off the wrapped socket error; nothing else leaks.
        expect(ws.headers).toEqual({ 'x-codex-primary-used-percent': '100', 'x-request-id': 'req_1' });
      } finally { await app.close(); }
    }
  });

  test('dropped connections are retried like native; a lasting one is a 503 on plain JSON but stays pending on streams, timeouts are not retried', async () => {
    let calls = 0; let failuresLeft = 2;
    const app = await fixtureRouter({ upstreamFetch: async (_url, init) => { calls++; if (failuresLeft-- > 0) throw Object.assign(new Error('SECRET reset'), { code: 'ECONNRESET' }); return success(init); } });
    try {
      expect((await post(app, request(GPT))).status).toBe(200); expect(calls).toBe(3);
      failuresLeft = 99; calls = 0;
      const plain = await post(app, request(GPT));
      expect(plain.status).toBe(503); expect(calls).toBe(5);
      const text = await plain.text(); expect(text).toContain('Network connection interrupted'); expect(text).not.toContain('SECRET');
      // A stream outlasts the native burst: after the 4 inner retries fail the relay stays pending
      // with heartbeats and reconnects with backoff until OpenAI answers.
      calls = 0; failuresLeft = 7;
      const stream = await (await post(app, request(GPT, { stream: true }))).text();
      expect(last(stream).type).toBe('response.completed'); expect(stream).toContain('UPSTREAM OK'); expect(stream).not.toContain('SECRET');
      expect(calls).toBe(8);
      calls = 0; failuresLeft = 7;
      const ws = await socketTurn(app, request(GPT, { stream: true }));
      expect(ws.type).toBe('response.completed'); expect(JSON.stringify(ws)).toContain('UPSTREAM OK'); expect(calls).toBe(8);
    } finally { await app.close(); }
    calls = 0;
    const slow = await fixtureRouter({ upstreamFetch: async () => { calls++; throw new DOMException('SECRET deadline', 'TimeoutError'); } });
    try {
      const plain = await post(slow, request(GPT));
      expect(plain.status).toBe(503); expect(calls).toBe(1);
      const text = await plain.text(); expect(text).toContain('timed out'); expect(text).not.toContain('SECRET');
    } finally { await slow.close(); }
  });

  test('a stream that ends without response.completed is reported as a dropped connection, not a hang', async () => {
    const app = await fixtureRouter({ upstreamFetch: async () => new Response('data: {"type":"response.output_text.delta","delta":"par"}\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
    try {
      // HTTP streaming is a raw byte relay: native Codex detects the missing terminal frame itself.
      const stream = await (await post(app, request(GPT, { stream: true }))).text();
      expect(stream).toContain('"delta":"par"');
      expect(stream).not.toContain('response.completed');
      // The WebSocket path parses frames, so it must synthesise the retryable failure.
      const ws = await socketTurn(app, request(GPT, { stream: true }));
      expect(ws.type).toBe('response.failed'); expect(ws.response.error.code).toBe('server_error');
      expect(ws.response.error.message).toContain('Network connection interrupted');
    } finally { await app.close(); }
  });

  test('unparseable SSE frames are skipped like the native parser and the turn still completes', async () => {
    const app = await fixtureRouter({ upstreamFetch: async (_url, init) => {
      const good = await success(init).text();
      return new Response('data: {not json\n\ndata: 42\n\n' + good, { headers: { 'content-type': 'text/event-stream' } });
    } });
    try {
      const stream = await (await post(app, request(GPT, { stream: true }))).text();
      expect(last(stream).type).toBe('response.completed');
      expect(stream).toContain('UPSTREAM OK');
      expect((await post(app, request(GPT))).status).toBe(200);
      const ws = await socketTurn(app, request(GPT, { stream: true }));
      expect(ws.type).toBe('response.completed');
    } finally { await app.close(); }
  });

  test('an upstream response.failed is forwarded verbatim so Codex applies its own classification', async () => {
    for (const code of ['rate_limit_exceeded', 'server_is_overloaded', 'context_length_exceeded', 'insufficient_quota']) {
      const app = await fixtureRouter({ upstreamFetch: async () => new Response(`data: ${JSON.stringify({ type: 'response.failed', sequence_number: 0, response: { id: 'resp_x', status: 'failed', error: { code, message: `upstream ${code}` } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) });
      try {
        const failed = last(await (await post(app, request(GPT, { stream: true }))).text());
        expect(failed.response.error).toMatchObject({ code, message: `upstream ${code}` });
        const ws = await socketTurn(app, request(GPT, { stream: true }));
        expect(ws.type).toBe('response.failed'); expect(ws.response.error.code).toBe(code);
      } finally { await app.close(); }
    }
  });

  test('compaction: a transient 5xx recovers, a lasting one carries the real status, and the summary route works', async () => {
    let failuresLeft = 3; let calls = 0; let status = 502;
    const app = await fixtureRouter({ summaryKey: Buffer.alloc(32, 5), upstreamFetch: async (_url, init) => {
      calls++; if (failuresLeft-- > 0) return new Response('{}', { status });
      return streamResponse(responseObject(JSON.parse(String(init.body)) as ResponsesBody, { text: 'SUMMARY', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }));
    } });
    const compaction = request(GPT, { input: [{ role: 'user', content: 'hi' }, { type: 'compaction_trigger' }] });
    try {
      const ok = await post(app, compaction);
      expect(ok.status).toBe(200); expect(calls).toBe(4);
      expect(JSON.stringify(await ok.json())).toContain('"type":"compaction"');
      for (status of [500, 502, 507]) {
        failuresLeft = 99; calls = 0;
        const lasting = await post(app, compaction);
        expect(lasting.status).toBe(status); expect(calls).toBe(5);
        const error = ((await lasting.json()) as any).error;
        expect(error.type).toBe('server_error');
        expect(error.message).toContain(`OpenAI compaction request failed HTTP ${status}`);
      }
    } finally { await app.close(); }
  });

  test('compaction: OpenAI usage-limit, cyber-policy and overload fields survive so native classifies them', async () => {
    let reply = { status: 429, error: { type: 'usage_limit_reached', message: 'cap', plan_type: 'pro', resets_at: 1_900_000_000 } as Record<string, unknown> };
    let calls = 0;
    const app = await fixtureRouter({ summaryKey: Buffer.alloc(32, 5), upstreamFetch: async () => { calls++; return Response.json({ error: reply.error }, { status: reply.status }); } });
    const compaction = request(GPT, { input: [{ role: 'user', content: 'hi' }, { type: 'compaction_trigger' }] });
    try {
      const capped = await post(app, compaction);
      expect(capped.status).toBe(429); expect(calls).toBe(1);
      expect(((await capped.json()) as any).error).toMatchObject({ type: 'usage_limit_reached', plan_type: 'pro', resets_at: 1_900_000_000 });
      reply = { status: 400, error: { type: 'invalid_request_error', code: 'cyber_policy', message: 'flagged' } };
      const flagged = ((await (await post(app, compaction)).json()) as any).error;
      expect(flagged.code).toBe('cyber_policy'); expect(flagged.message).toContain('flagged');
      reply = { status: 503, error: { type: 'server_error', code: 'server_is_overloaded', message: 'busy' } };
      const ws = await socketTurn(app, compaction);
      expect(ws).toMatchObject({ type: 'error', status: 503, error: { code: 'server_is_overloaded' } });
    } finally { await app.close(); }
  });

  test('compaction: a stream OpenAI ends as failed or incomplete reports what happened, not a missing summary', async () => {
    let events: object[] = [];
    const app = await fixtureRouter({ summaryKey: Buffer.alloc(32, 5), upstreamFetch: async () =>
      new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) });
    const compaction = request(GPT, { input: [{ role: 'user', content: 'hi' }, { type: 'compaction_trigger' }] });
    const summary = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PARTIAL SUMMARY' }] };
    const failed = (error: object) => [{ type: 'response.failed', response: { id: 'r', status: 'failed', output: [], error } }];
    try {
      // Regression: reasoning + message streamed, then response.incomplete, was reported as no summary.
      events = [
        { type: 'response.output_item.done', item: { type: 'reasoning' } },
        { type: 'response.output_item.done', item: summary },
        { type: 'response.incomplete', response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning' }, summary] } },
      ];
      const partial = await post(app, compaction);
      expect(partial.status).toBe(200);
      expect(JSON.stringify(await partial.json())).toContain('"type":"compaction"');

      events = failed({ code: 'server_error', message: 'boom' });
      const retryable = await post(app, compaction);
      expect(retryable.status).toBe(502);
      expect(((await retryable.json()) as any).error).toMatchObject({ code: 'server_error', message: 'OpenAI compaction failed: boom' });

      events = failed({ code: 'context_length_exceeded', message: 'too long' });
      expect(await socketTurn(app, compaction)).toMatchObject({ type: 'error', status: 400, error: { code: 'context_length_exceeded' } });

      events = [{ type: 'response.completed', response: { id: 'r', status: 'completed', output: [] } }];
      expect(await socketTurn(app, compaction)).toMatchObject({ type: 'error', status: 502, error: { type: 'server_error' } });
    } finally { await app.close(); }
  });
});

// ---------------------------------------------------------------------------------------------
// Router-level edge cases that are independent of the model.
// ---------------------------------------------------------------------------------------------
describe('router edge cases', () => {
  test('malformed requests are refused with precise 4xx codes before any backend or OpenAI call', async () => {
    let upstreamCalls = 0;
    const app = await fixtureRouter({ upstreamFetch: async () => { upstreamCalls++; return new Response('{}'); } });
    try {
      const raw = (body: string, headers: Record<string, string> = AUTH_HEADERS, method = 'POST', path = '/v1/responses') =>
        fetch(app.url(path), { method, headers, body: method === 'GET' ? undefined : body });
      expect((await raw('[]')).status).toBe(400);
      expect((await raw('null')).status).toBe(400);
      expect((await raw('{not json')).status).toBe(400);
      const missing = await raw(JSON.stringify({ input: [] }));
      expect(missing.status).toBe(400); expect(await missing.text()).toContain('Model is required');
      expect((await raw('{}', AUTH_HEADERS, 'GET')).status).toBe(405);
      expect((await raw('{}', AUTH_HEADERS, 'POST', '/v1/nope')).status).toBe(404);
      expect((await raw('{}', { 'content-type': 'application/json' })).status).toBe(401);
      expect((await raw('{}', { ...AUTH_HEADERS, authorization: 'Bearer wrong-token' })).status).toBe(401);
      const encoded = await raw(JSON.stringify(request(GPT)), { ...AUTH_HEADERS, 'content-encoding': 'zstd-fake' });
      expect(encoded.status).toBeGreaterThanOrEqual(400); expect(encoded.status).toBeLessThan(500);
      expect(upstreamCalls).toBe(0);
    } finally { await app.close(); }
  });

  test('a body larger than the router limit is rejected instead of buffered', async () => {
    let upstreamCalls = 0;
    const app = await fixtureRouter({ upstreamFetch: async () => { upstreamCalls++; return new Response('{}'); } });
    try {
      const huge = JSON.stringify(request(GPT, { input: [{ role: 'user', content: 'x'.repeat(MAX_BODY_BYTES + 1) }] }));
      const response = await post(app, undefined, { body: huge }).catch(() => undefined);
      if (response) expect(response.status).toBeGreaterThanOrEqual(400);
      expect(upstreamCalls).toBe(0);
    } finally { await app.close(); }
  });

  test('a second response.create on a busy socket is refused without disturbing the running turn', async () => {
    const gate = Promise.withResolvers<void>();
    const app = await fixtureRouter({ upstreamFetch: async (_url, init) => { await gate.promise; return streamResponse(responseObject(JSON.parse(String(init.body)) as ResponsesBody, { text: 'FIRST', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })); } });
    const Socket = WebSocket as unknown as { new (url: string, options: { headers: Record<string, string> }): WebSocket };
    const ws = new Socket(app.url('/v1/responses').replace('http:', 'ws:'), { headers: AUTH_HEADERS });
    try {
      const events: any[] = [];
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('busy test timed out')), 4000);
        ws.onmessage = (e) => { const event = JSON.parse(String(e.data)); events.push(event); if (event.type === 'error') gate.resolve(); if (event.type === 'response.completed') { clearTimeout(timer); resolve(); } };
        ws.onerror = () => reject(new Error('socket failed'));
      });
      await new Promise<void>(resolve => { ws.onopen = () => resolve(); });
      ws.send(JSON.stringify({ type: 'response.create', ...request(GPT, { stream: true }) }));
      await Bun.sleep(50);
      ws.send(JSON.stringify({ type: 'response.create', ...request(GPT, { stream: true }) }));
      await done;
      const busy = events.find(e => e.type === 'error');
      expect(busy.error.message).toContain('already in progress');
      expect(events.some(e => e.type === 'response.completed')).toBe(true);
    } finally { ws.close(); await app.close(); }
  });

  test('the same socket serves a new turn after a failure without reconnecting', async () => {
    let fail = true;
    const app = await fixtureRouter({ upstreamFetch: async (_url, init) => fail ? new Response('{}', { status: 503 }) : streamResponse(responseObject(JSON.parse(String(init.body)) as ResponsesBody, { text: 'AGAIN', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })) });
    const Socket = WebSocket as unknown as { new (url: string, options: { headers: Record<string, string> }): WebSocket };
    const ws = new Socket(app.url('/v1/responses').replace('http:', 'ws:'), { headers: AUTH_HEADERS });
    try {
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('socket failed')); });
      const turn = () => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('turn timed out')), 4000);
        ws.onmessage = (e) => { const event = JSON.parse(String(e.data)); if (['error', 'response.failed', 'response.completed'].includes(event.type)) { clearTimeout(timer); resolve(event); } };
        ws.send(JSON.stringify({ type: 'response.create', ...request(GPT, { stream: true }) }));
      });
      expect((await turn())).toMatchObject({ type: 'error', status: 503 });
      fail = false;
      const ok = await turn();
      expect(ok.type).toBe('response.completed');
      expect(JSON.stringify(ok)).toContain('AGAIN');
    } finally { ws.close(); await app.close(); }
  });
});
