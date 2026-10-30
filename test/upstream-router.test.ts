// Native GPT WebSocket transport through the real router and two loopback WebSocket hops.
// All upstream frames and credentials are synthetic; these tests never contact a model provider.
import { expect, setDefaultTimeout, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord, type JsonRecord } from '../src/json';
import { responseObject, streamResponse } from '../src/protocol/output';
import type { ResponsesBody } from '../src/protocol/types';
import { AUTH_HEADERS, fixtureRouter } from './support';

setDefaultTimeout(10_000);
type Peer = ServerWebSocket<{ connection: number }>;
const user = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const assistant = (text: string) => ({ id: 'message-' + text, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] });
const emit = (peer: Peer, event: unknown) => peer.send(JSON.stringify(event));
const finished = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error']);
function complete(peer: Peer, request: JsonRecord, count: number) {
  const id = 'upstream-' + count, text = 'synthetic-' + count;
  const output = request.generate === false ? [] : [assistant(text)];
  emit(peer, { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } });
  if (output.length) {
    emit(peer, { type: 'response.output_item.added', output_index: 0, item: { ...output[0], content: [] } });
    emit(peer, { type: 'response.output_text.delta', response_id: id, item_id: output[0]!.id, output_index: 0, content_index: 0, delta: text });
    emit(peer, { type: 'response.output_item.done', output_index: 0, item: output[0] });
  }
  emit(peer, { type: 'response.completed', response: { id, object: 'response', model: request.model, status: 'completed', output } });
}
function upstream(handle = complete, rejectedStatus?: number) {
  const handshakes: Headers[] = [], messages: JsonRecord[] = [];
  let opens = 0, closes = 0;
  const server = Bun.serve<{ connection: number }>({ port: 0, hostname: '127.0.0.1',
    fetch(request, server) {
      handshakes.push(new Headers(request.headers));
      if (rejectedStatus) return new Response('synthetic unsupported upgrade', { status: rejectedStatus });
      if (server.upgrade(request, { data: { connection: handshakes.length } })) return;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: { open() { opens++; }, close() { closes++; }, message(peer, data) {
      const request: unknown = JSON.parse(String(data));
      if (!isRecord(request)) throw new Error('invalid synthetic request');
      messages.push(request); handle(peer, request, messages.length);
    } },
  });
  const socket = (address: string, headers: Headers) => {
    expect(address).toBe('wss://chatgpt.com/backend-api/codex/responses');
    const Socket = WebSocket as unknown as { new (url: string, options: { headers: Headers }): WebSocket };
    return new Socket(String(server.url).replace('http:', 'ws:'), { headers });
  };
  return { socket, messages, handshakes, get opens() { return opens; }, get closes() { return closes; }, close() { server.stop(true); } };
}
type Router = Awaited<ReturnType<typeof fixtureRouter>>;
async function client(router: Router) {
  const Socket = WebSocket as unknown as { new (url: string, options: { headers: Record<string, string> }): WebSocket };
  const socket = new Socket(router.url('/v1/responses').replace('http:', 'ws:'), { headers: AUTH_HEADERS });
  const events: JsonRecord[] = [];
  socket.onmessage = event => { const value: unknown = JSON.parse(String(event.data)); if (isRecord(value)) events.push(value); };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('synthetic client failed to connect'));
  });
  const wait = async (predicate: (event: JsonRecord) => boolean, start = 0) => {
    for (let i = 0; i < 500; i++) {
      const found = events.slice(start).find(predicate);
      if (found) return found;
      if (socket.readyState === 3) throw new Error('router closed before expected synthetic event');
      await Bun.sleep(5);
    }
    throw new Error('synthetic client event timed out');
  };
  return {
    events, wait, send: (body: JsonRecord) => socket.send(JSON.stringify(body)),
    async turn(body: JsonRecord) {
      const start = events.length;
      socket.send(JSON.stringify({ type: 'response.create', ...body }));
      const terminal = await wait(event => finished.has(String(event.type)), start);
      return { terminal, events: events.slice(start) };
    },
    close() { socket.close(); },
  };
}
const body = (input: unknown[] = [user('first')], extra: JsonRecord = {}) => ({ model: 'gpt-6.1-sol', reasoning: { effort: 'high' }, service_tier: 'priority', input, ...extra });
function response(event: JsonRecord): JsonRecord {
  if (!isRecord(event.response)) throw new Error('expected synthetic response');
  return event.response;
}
const noHttp = async () => { throw new Error('unexpected HTTP fallback in native WebSocket fixture'); };
function httpFixture() {
  const requests: JsonRecord[] = [], headers: Headers[] = [];
  return {
    requests, headers,
    fetch: async (_url: string, init: RequestInit) => {
      const parsed: unknown = JSON.parse(String(init.body));
      if (!isRecord(parsed)) throw new Error('expected synthetic JSON');
      requests.push(parsed); headers.push(new Headers(init.headers));
      const output = responseObject(parsed as ResponsesBody, { text: 'http-' + requests.length, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      return streamResponse(output);
    },
  };
}

test('router keeps one upstream connection per client and expands local history before sending a verified delta', async () => {
  const remote = upstream();
  const router = await fixtureRouter({ upstreamWebSocket: true, upstreamSocket: remote.socket, upstreamFetch: noHttp });
  const a = await client(router), b = await client(router);
  try {
    const first = await a.turn(body());
    expect(first.terminal.type).toBe('response.completed');
    expect(response(first.terminal).id).toBe('upstream-1');
    expect(first.events.some(event => event.type === 'response.output_text.delta')).toBe(true);
    await a.turn(body([user('next')], { previous_response_id: 'upstream-1', future_field: { untouched: [true, null] } }));
    expect(remote.opens).toBe(1);
    expect(remote.messages[1]).toMatchObject({ previous_response_id: 'upstream-1', input: [user('next')], future_field: { untouched: [true, null] } });
    expect(remote.messages[1]).not.toHaveProperty('stream');
    await b.turn(body([user('other client')]));
    expect(remote.opens).toBe(2);
    expect(remote.messages[2]).not.toHaveProperty('previous_response_id');
    expect(remote.handshakes[0]?.get('authorization')).toBe(AUTH_HEADERS.authorization);
    expect(remote.handshakes[0]?.get('chatgpt-account-id')).toBe(AUTH_HEADERS['chatgpt-account-id']);
  } finally { a.close(); b.close(); await router.close(); remote.close(); }
});

test('router forwards a no-generation warmup and retains the real upstream response ID for the first turn', async () => {
  const remote = upstream();
  const router = await fixtureRouter({ upstreamWebSocket: true, upstreamSocket: remote.socket, upstreamFetch: noHttp });
  const c = await client(router);
  try {
    const warm = await c.turn(body([], { generate: false }));
    expect(response(warm.terminal).id).toBe('upstream-1');
    expect(response(warm.terminal).output).toEqual([]);
    expect(remote.messages[0]?.generate).toBe(false);
    expect(warm.events.some(event => event.type === 'response.output_text.delta')).toBe(false);
    await c.turn(body([user('first generated')], { previous_response_id: 'upstream-1' }));
    expect(remote.opens).toBe(1);
    expect(remote.messages[1]).toMatchObject({ previous_response_id: 'upstream-1', input: [user('first generated')] });
  } finally { c.close(); await router.close(); remote.close(); }
});

test('router model changes reset connection-local continuation and send complete normalized history', async () => {
  const remote = upstream();
  const router = await fixtureRouter({ upstreamWebSocket: true, upstreamSocket: remote.socket, upstreamFetch: noHttp });
  const c = await client(router);
  try {
    await c.turn(body());
    await c.turn(body([user('different model')], { previous_response_id: 'upstream-1', model: 'gpt-6-astra' }));
    expect(remote.opens).toBe(2);
    expect(remote.messages[1]).not.toHaveProperty('previous_response_id');
    expect(remote.messages[1]?.input).toEqual([user('first'), assistant('synthetic-1'), user('different model')]);
  } finally { c.close(); await router.close(); remote.close(); }
});

test('router hides a missing-previous refusal and replays its expanded history once without changing client turns', async () => {
  const remote = upstream((peer, request, count) => {
    if (count !== 2) return complete(peer, request, count);
    emit(peer, { type: 'response.created', response: { id: 'unusable-response', output: [] } });
    emit(peer, { type: 'error', status: 400, error: { code: 'previous_response_not_found' } });
  });
  const router = await fixtureRouter({ upstreamWebSocket: true, upstreamSocket: remote.socket, upstreamFetch: noHttp });
  const c = await client(router);
  try {
    await c.turn(body());
    const result = await c.turn(body([user('next')], { previous_response_id: 'upstream-1' }));
    expect(result.terminal.type).toBe('response.completed');
    expect(response(result.terminal).id).toBe('upstream-3');
    expect(remote.messages).toHaveLength(3);
    expect(remote.messages[1]).toMatchObject({ previous_response_id: 'upstream-1', input: [user('next')] });
    expect(remote.messages[2]?.input).toEqual([user('first'), assistant('synthetic-1'), user('next')]);
    expect(remote.messages[2]).not.toHaveProperty('previous_response_id');
    expect(result.events.some(event => event.type === 'error')).toBe(false);
    expect(result.events.filter(event => event.type === 'response.created').map(event => response(event).id)).toEqual(['upstream-3']);
  } finally { c.close(); await router.close(); remote.close(); }
});

test('router applies primary/secondary tier and identity policies before opening native sockets, including token rotation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'router-upstream-account-'));
  const jwt = (claims: unknown) => 'fixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture';
  const write = (generation: number) => Bun.write(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    access_token: jwt({ exp: Date.now() / 1000 + 3600, generation }), id_token: jwt({ email: 'synthetic@example.com' }), account_id: 'synthetic-secondary',
  } }));
  await write(1);
  await Bun.write(join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list', service_tiers: [{ id: 'ultrafast' }] }] }));
  const remote = upstream();
  const router = await fixtureRouter({ upstreamWebSocket: true, upstreamSocket: remote.socket, upstreamFetch: noHttp, primaryStandard: true,
    secondaryAccount: { home, prefix: 'secondary', binary: 'unused', expectedEmail: 'synthetic@example.com', expectedAccountId: 'synthetic-secondary', fastest: true } });
  const c = await client(router);
  try {
    await c.turn(body());
    expect(remote.messages[0]?.service_tier).toBe('default');
    await c.turn(body([user('switch account')], { previous_response_id: 'upstream-1', model: 'secondary-gpt-6.1-sol', service_tier: 'default' }));
    expect(remote.messages[1]).toMatchObject({ model: 'gpt-6.1-sol', service_tier: 'ultrafast', reasoning: { effort: 'high' } });
    expect(remote.messages[1]).not.toHaveProperty('previous_response_id');
    expect(remote.handshakes[1]?.get('chatgpt-account-id')).toBe('synthetic-secondary');
    const originalToken = remote.handshakes[1]?.get('authorization');
    await write(2);
    await c.turn(body([user('after rotation')], { previous_response_id: 'upstream-2', model: 'secondary-gpt-6.1-sol' }));
    expect(remote.opens).toBe(3);
    expect(remote.handshakes[2]?.get('authorization')).not.toBe(originalToken);
    expect(remote.messages[2]).not.toHaveProperty('previous_response_id');
    expect((remote.messages[2]?.input as unknown[]).length).toBe(5);
  } finally { c.close(); await router.close(); remote.close(); await rm(home, { recursive: true, force: true }); }
});

test('router uses HTTP after a real unsupported WebSocket handshake, with the tier policy already applied', async () => {
  const remote = upstream(complete, 426), http = httpFixture();
  const router = await fixtureRouter({ upstreamWebSocket: true, upstreamSocket: remote.socket, upstreamFetch: http.fetch, primaryStandard: true });
  const c = await client(router);
  try {
    const result = await c.turn(body());
    expect(result.terminal.type).toBe('response.completed');
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.service_tier).toBe('default');
    expect(remote.messages).toHaveLength(0);
    expect(remote.handshakes).toHaveLength(1);
  } finally { c.close(); await router.close(); remote.close(); }
});

test('router secondary identity refresh handles an upstream 401 before publishing any model frames', async () => {
  const home = await mkdtemp(join(tmpdir(), 'router-upstream-refresh-'));
  const jwt = (claims: unknown) => 'fixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture';
  const write = (generation: number) => Bun.write(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    access_token: jwt({ exp: Date.now() / 1000 + 3600, generation }), id_token: jwt({ email: 'synthetic@example.com' }), account_id: 'synthetic-secondary',
  } }));
  await write(1);
  await Bun.write(join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] }));
  let refreshes = 0;
  const remote = upstream((peer, request, count) => {
    if (count === 1) emit(peer, { type: 'error', status: 401, error: { code: 'invalid_token', message: 'synthetic expired token' } });
    else complete(peer, request, count);
  });
  const router = await fixtureRouter({ upstreamWebSocket: true, upstreamSocket: remote.socket, upstreamFetch: noHttp,
    secondaryAccount: { home, prefix: 'secondary', binary: 'unused', expectedEmail: 'synthetic@example.com', expectedAccountId: 'synthetic-secondary', refresh: async () => { refreshes++; await write(2); } } });
  const c = await client(router);
  try {
    const result = await c.turn(body([user('synthetic refresh')], { model: 'secondary-gpt-6.1-sol' }));
    expect(result.terminal.type).toBe('response.completed');
    expect(response(result.terminal).id).toBe('upstream-2');
    expect(refreshes).toBe(1);
    expect(remote.opens).toBe(2);
    expect(remote.handshakes[1]?.get('authorization')).not.toBe(remote.handshakes[0]?.get('authorization'));
    expect(result.events.some(event => event.type === 'error')).toBe(false);
    expect(result.events.filter(event => event.type === 'response.created').map(event => response(event).id)).toEqual(['upstream-2']);
  } finally { c.close(); await router.close(); remote.close(); await rm(home, { recursive: true, force: true }); }
});

test('router closing a client socket aborts and closes only that client\'s upstream connection', async () => {
  const remote = upstream((peer, request, count) => {
    if (count !== 1) return complete(peer, request, count);
    emit(peer, { type: 'response.created', response: { id: 'active-before-disconnect', output: [] } });
    emit(peer, { type: 'response.output_text.delta', delta: 'synthetic unfinished' });
  });
  const router = await fixtureRouter({ upstreamWebSocket: true, upstreamSocket: remote.socket, upstreamFetch: noHttp });
  const a = await client(router), b = await client(router);
  try {
    a.send({ type: 'response.create', ...body() });
    await a.wait(event => event.type === 'response.output_text.delta');
    a.close();
    for (let i = 0; i < 100 && remote.closes < 1; i++) await Bun.sleep(5);
    expect(remote.closes).toBe(1);
    expect((await b.turn(body([user('independent client')]))).terminal.type).toBe('response.completed');
    expect(remote.opens).toBe(2);
  } finally { a.close(); b.close(); await router.close(); remote.close(); }
});

test('router interrupt completes as incomplete and the next request replays history on a fresh upstream socket', async () => {
  const remote = upstream((peer, request, count) => {
    if (count !== 1) return complete(peer, request, count);
    emit(peer, { type: 'response.created', response: { id: 'partial-1', object: 'response', status: 'in_progress', output: [] } });
    emit(peer, { type: 'response.output_item.added', output_index: 0, item: { id: 'unfinished-message', type: 'message', role: 'assistant', content: [] } });
    emit(peer, { type: 'response.output_text.delta', response_id: 'partial-1', item_id: 'unfinished-message', delta: 'partial synthetic text' });
  });
  const router = await fixtureRouter({ upstreamWebSocket: true, upstreamSocket: remote.socket, upstreamFetch: noHttp });
  const c = await client(router);
  try {
    c.send({ type: 'response.create', ...body() });
    await c.wait(event => event.type === 'response.output_text.delta');
    c.send({ type: 'response.interrupt', response_id: 'partial-1' });
    const incomplete = await c.wait(event => event.type === 'response.incomplete');
    expect(response(incomplete)).toMatchObject({ id: 'partial-1', status: 'incomplete', incomplete_details: { reason: 'interrupted' }, output: [] });
    expect(c.events.some(event => event.type === 'response.output_item.interrupted')).toBe(true);
    await c.turn(body([user('resume')], { previous_response_id: 'partial-1' }));
    expect(remote.opens).toBe(2);
    expect(remote.messages[1]).not.toHaveProperty('previous_response_id');
    expect(remote.messages[1]?.input).toEqual([user('first'), user('resume')]);
  } finally { c.close(); await router.close(); remote.close(); }
});

test('router keeps existing HTTP behavior when native sockets are not enabled', async () => {
  const http = httpFixture();
  const router = await fixtureRouter({ upstreamFetch: http.fetch, upstreamSocket: () => { throw new Error('disabled native socket was opened'); } });
  const c = await client(router);
  try {
    const first = await c.turn(body());
    const id = response(first.terminal).id;
    await c.turn(body([user('next')], { previous_response_id: id }));
    expect(http.requests).toHaveLength(2);
    expect((http.requests[1]?.input as unknown[]).length).toBe(3);
    expect(http.requests[1]).not.toHaveProperty('previous_response_id');
    const warm = await c.turn(body([], { generate: false }));
    expect(warm.terminal.type).toBe('response.completed');
    expect(http.requests).toHaveLength(2);
  } finally { c.close(); await router.close(); }
});

test('HTTP clients retain the HTTP upstream even when native client sockets are enabled', async () => {
  const http = httpFixture();
  const router = await fixtureRouter({ upstreamWebSocket: true, upstreamFetch: http.fetch, upstreamSocket: () => { throw new Error('HTTP request opened native socket'); } });
  try {
    const result = await fetch(router.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify({ ...body(), stream: true }) });
    expect(result.ok).toBe(true);
    expect(await result.text()).toContain('response.completed');
    expect(http.requests).toHaveLength(1);
  } finally { await router.close(); }
});
