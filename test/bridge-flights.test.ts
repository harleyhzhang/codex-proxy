import { expect, test } from 'bun:test';
import { claudeBackend } from '../src/backends/claude';
import { isRecord } from '../src/json';
import { streamResponse, responseObject } from '../src/protocol/output';
import type { ResponsesBody, StreamEvent } from '../src/protocol/types';
import { AUTH_HEADERS, fixtureRouter } from './support';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const output = { text: 'restored', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
const body: ResponsesBody = {
  model: 'claude-opus-5-5',
  input: [{ type: 'compaction', encrypted_content: 'gAAAA-shared' }],
};

// Hold the upstream stream open so requests overlap without relying on sleeps or live services.
test('concurrent HTTP and WebSocket history restoration shares one flight even if one caller cancels', async () => {
  const ready = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  let effectiveHeaders: Record<string, string> = {};
  const app = await fixtureRouter({
    summaryKey: Buffer.alloc(32, 6),
    upstreamFetch: async (_url, init) => {
      calls++;
      effectiveHeaders = Object.fromEntries(new Headers(init.headers).entries());
      ready.resolve();
      await release.promise;
      const request = JSON.parse(String(init.body)) as ResponsesBody;
      return streamResponse(responseObject(request, output));
    },
  });
  const original = claudeBackend.run;
  claudeBackend.run = async (request, signal) => {
    signal?.throwIfAborted();
    expect(JSON.stringify(request.input)).toContain('restored');
    return output;
  };
  const cancelled = new AbortController();
  const post = (signal?: AbortSignal) => fetch(app.url('/v1/responses'), {
    method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(body), signal,
  });
  const first = post(cancelled.signal).catch(error => error);
  let socket: WebSocket | undefined;
  try {
    await ready.promise;
    const Socket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
    socket = new Socket(app.url('/v1/responses').replace('http:', 'ws:'), { headers: effectiveHeaders });
    await new Promise<void>((resolve, reject) => {
      socket!.onopen = () => resolve();
      socket!.onerror = () => reject(new Error('fixture socket failed'));
    });
    const joined = deferred<void>();
    const finished = new Promise<StreamEvent>((resolve, reject) => {
      socket!.onmessage = event => {
        const message = JSON.parse(String(event.data)) as StreamEvent;
        if (message.type === 'error' && isRecord(message.error) && message.error.message === 'A response is already in progress') {
          joined.resolve();
          return;
        }
        if (message.type === 'response.completed') resolve(message);
        if (message.type === 'response.failed' || message.type === 'error') reject(new Error('fixture response failed'));
      };
      socket!.onerror = () => reject(new Error('fixture socket failed'));
    });
    socket.send(JSON.stringify({ type: 'response.create', ...body }));
    // A second command is refused only after the first has entered normalization.
    socket.send(JSON.stringify({ type: 'response.create', ...body }));
    await joined.promise;
    cancelled.abort();
    release.resolve();
    expect(await first).toBeInstanceOf(Error);
    expect((await finished).type).toBe('response.completed');
    expect(calls).toBe(1);
    expect([...new Bun.Glob('bridged/*.cap').scanSync(app.dir)]).toHaveLength(1);
  } finally {
    release.resolve();
    socket?.close();
    claudeBackend.run = original;
    await app.close();
  }
});

test.each(['header metadata', 'credential rotation'])('bridge flights isolate %s and failures do not poison retries', async context => {
  const release = deferred<void>();
  const firstStarted = deferred<void>();
  const bothStarted = deferred<void>();
  const credentials: Array<string | null> = [];
  let calls = 0;
  const app = await fixtureRouter({
    summaryKey: Buffer.alloc(32, 7),
    upstreamFetch: async (_url, init) => {
      credentials.push(new Headers(init.headers).get('authorization'));
      if (++calls === 1) firstStarted.resolve();
      if (calls === 2) bothStarted.resolve();
      await release.promise;
      return new Response('unavailable', { status: 400 });
    },
    bridgeModels: ['fixture'],
  });
  try {
    const first = fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(body) });
    await firstStarted.promise;
    const headers = { ...AUTH_HEADERS };
    if (context === 'credential rotation') {
      await Bun.write(app.dir + '/auth.json', JSON.stringify({
        auth_mode: 'chatgpt', tokens: { access_token: 'rotated-fixture-token', account_id: 'fixture-account' },
      }));
      headers.authorization = 'Bearer rotated-fixture-token';
    }
    // Both callers authenticate, but must retain their own effective upstream context.
    const second = fetch(app.url('/v1/responses'), {
      method: 'POST', headers: context === 'header metadata' ? { ...headers, 'x-fixture-context': 'other' } : headers, body: JSON.stringify(body),
    });
    await bothStarted.promise;
    release.resolve();
    expect((await first).status).toBe(502);
    expect((await second).status).toBe(502);
    const retry = await fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(body) });
    expect(retry.status).toBe(502);
    expect(calls).toBe(3);
    expect(credentials).toEqual([AUTH_HEADERS.authorization, headers.authorization, AUTH_HEADERS.authorization]);
  } finally {
    release.resolve();
    await app.close();
  }
});
