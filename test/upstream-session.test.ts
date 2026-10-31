import { expect, spyOn, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord, type JsonRecord } from '../src/json';
import { sseEvents } from '../src/protocol/stream';
import { ProxyTransportError } from '../src/transport';
import { UpstreamSession } from '../src/router/upstream-session';
import { UpstreamStatusError } from '../src/router/upstream';
import { AccountUpstream } from '../src/router/account-upstream';

const target = 'https://chatgpt.com/backend-api/codex/responses';
const user = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const assistant = (text: string) => ({ id: 'msg-' + text, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] });
const init = (input: unknown[], extra: JsonRecord = {}): RequestInit => ({ method: 'POST', headers: { authorization: 'Bearer fixture-one', 'chatgpt-account-id': 'fixture-account', 'x-routing-fixture': 'preserved' },
  body: JSON.stringify({ model: 'gpt-6.1-sol', service_tier: 'priority', reasoning: { effort: 'high' }, store: false, stream: true, input, ...extra }) });
type Peer = ServerWebSocket<{ id: number }>;
const emit = (peer: Peer, event: unknown) => peer.send(JSON.stringify(event));
function complete(peer: Peer, id: string, text = 'OK', output: unknown[] = [assistant(text)]) {
  emit(peer, { type: 'response.created', response: { id, output: [] } });
  if (text) emit(peer, { type: 'response.output_text.delta', delta: text });
  emit(peer, { type: 'response.completed', response: { id, status: 'completed', output } });
}
async function collect(response: Response): Promise<JsonRecord[]> {
  const events: JsonRecord[] = [];
  await sseEvents(response, event => events.push(event));
  return events;
}
function fixture(handle: (peer: Peer, request: JsonRecord, count: number) => void) {
  const messages: JsonRecord[] = [], handshakes: Headers[] = [];
  let didClose!: () => void;
  const closed = new Promise<void>(resolve => { didClose = resolve; });
  let opens = 0, closes = 0;
  const server = Bun.serve<{ id: number }>({ port: 0, hostname: '127.0.0.1',
    fetch(request, server) {
      handshakes.push(new Headers(request.headers));
      if (server.upgrade(request, { data: { id: opens + 1 } })) return;
      return new Response('not upgraded', { status: 400 });
    },
    websocket: { open() { opens++; }, close() { closes++; didClose(); }, message(peer, data) {
      const request: unknown = JSON.parse(String(data));
      if (!isRecord(request)) throw new Error('invalid fixture request');
      messages.push(request); handle(peer, request, messages.length);
    } },
  });
  const socket = (url: string, headers: Headers) => {
    expect(url).toBe('wss://chatgpt.com/backend-api/codex/responses');
    const Socket = WebSocket as unknown as { new(url: string, options: { headers: Headers }): WebSocket };
    return new Socket(String(server.url).replace('http:', 'ws:'), { headers });
  };
  return { socket, messages, handshakes, closed, get opens() { return opens; }, get closes() { return closes; }, close() { server.stop(true); } };
}

test('native upstream sessions are disabled by default and preserve the HTTP initializer exactly', async () => {
  const request = init([user('synthetic')]);
  const expected = new Response('{}');
  const session = new UpstreamSession({ fallback: async (url, forwarded) => { expect(url).toBe(target); expect(forwarded).toBe(request); return expected; }, socket: () => { throw new Error('must not connect'); } });
  expect(session.enabled).toBe(false);
  expect(await session.fetch(target, request)).toBe(expected);
  session.close();
});

test('same completed response and matching full history reuse a socket and send only new input', async () => {
  const app = fixture((peer, _request, count) => complete(peer, 'r' + count, count === 1 ? 'FIRST' : 'SECOND'));
  const session = new UpstreamSession({ enabled: true, socket: app.socket, fallback: async () => { throw new Error('no HTTP fallback'); } });
  try {
    await collect(await session.fetch(target, init([user('first')], { future: { opaque: [null, true] } })));
    await collect(await session.transport('r1')(target, init([user('first'), assistant('FIRST'), user('second')], { future: { opaque: [null, true] } })));
    expect(app.opens).toBe(1);
    expect(app.messages[0]).toMatchObject({ type: 'response.create', model: 'gpt-6.1-sol', reasoning: { effort: 'high' }, service_tier: 'priority', store: false, future: { opaque: [null, true] } });
    expect(app.messages[0]).not.toHaveProperty('stream');
    expect(app.messages[1]).toMatchObject({ previous_response_id: 'r1', input: [user('second')] });
    expect(app.handshakes[0].get('authorization')).toBe('Bearer fixture-one');
    expect(app.handshakes[0].get('x-routing-fixture')).toBe('preserved');
    expect(app.handshakes[0].get('openai-beta')).toContain('responses_websockets=2026-02-06');
  } finally { session.close(); app.close(); }
});

test('wrong response ids or changed history always send the complete input without a previous id', async () => {
  const app = fixture((peer, _request, count) => complete(peer, 'r' + count));
  const session = new UpstreamSession({ enabled: true, socket: app.socket, fallback: async () => new Response('{}') });
  try {
    await collect(await session.fetch(target, init([user('first')])));
    const changed = [user('changed'), assistant('OK'), user('next')];
    await collect(await session.transport('r1')(target, init(changed)));
    expect(app.messages[1].input).toEqual(changed); expect(app.messages[1]).not.toHaveProperty('previous_response_id');
    const next = [...changed, assistant('OK'), user('last')];
    await collect(await session.transport('wrong-id')(target, init(next)));
    expect(app.messages[2].input).toEqual(next); expect(app.messages[2]).not.toHaveProperty('previous_response_id');
  } finally { session.close(); app.close(); }
});

test('token, account, model and connection lifetime changes discard continuation state', async () => {
  let now = 1_000;
  const app = fixture((peer, _request, count) => complete(peer, 'r' + count));
  const session = new UpstreamSession({ enabled: true, socket: app.socket, now: () => now, maxLifetimeMs: 60_000, fallback: async () => new Response('{}') });
  try {
    let history: unknown[] = [user('first')];
    for (let turn = 1; turn <= 5; turn++) {
      const request = init(history, turn >= 4 ? { model: 'gpt-different' } : {});
      const headers = new Headers(request.headers);
      if (turn >= 2) headers.set('authorization', 'Bearer fixture-two');
      if (turn >= 3) headers.set('chatgpt-account-id', 'fixture-other');
      request.headers = headers;
      if (turn === 5) now += 60_001;
      await collect(await session.transport(turn > 1 ? 'r' + (turn - 1) : undefined)(target, request));
      expect(app.messages[turn - 1]).not.toHaveProperty('previous_response_id');
      history = [...history, assistant('OK'), user('next-' + turn)];
    }
    expect(app.opens).toBe(5);
  } finally { session.close(); app.close(); }
});

test('missing connection-local history earns exactly one full replay before visible output', async () => {
  const app = fixture((peer, _request, count) => {
    if (count === 2) {
      emit(peer, { type: 'response.created', response: { id: 'discarded', output: [] } });
      emit(peer, { type: 'response.output_item.added', item: { id: 'stray', type: 'message' } });
      emit(peer, { type: 'error', status: 400, error: { code: 'previous_response_not_found' } });
    }
    else complete(peer, 'r' + count, count === 1 ? 'FIRST' : 'FINAL');
  });
  const session = new UpstreamSession({ enabled: true, socket: app.socket, fallback: async () => { throw new Error('no HTTP fallback'); } });
  try {
    await collect(await session.fetch(target, init([user('first')])));
    const full = [user('first'), assistant('FIRST'), user('next')];
    const events = await collect(await session.transport('r1')(target, init(full)));
    expect(app.messages).toHaveLength(3);
    expect(app.messages[1]).toMatchObject({ previous_response_id: 'r1', input: [user('next')] });
    expect(app.messages[2].input).toEqual(full); expect(app.messages[2]).not.toHaveProperty('previous_response_id');
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.filter(event => event.type === 'response.created').map(event => isRecord(event.response) && event.response.id)).toEqual(['r3']);
    expect(events.some(event => isRecord(event.item) && event.item.id === 'stray')).toBe(false);
    expect(events.map(event => event.type)).toEqual(['response.created', 'response.output_text.delta', 'response.completed']);
    expect(events.at(-1)?.type).toBe('response.completed');
  } finally { session.close(); app.close(); }
});

test('missing-history errors never loop or replay after meaningful text/tool output', async () => {
  for (const visible of [false, true]) {
    const app = fixture((peer, _request, count) => {
      if (count === 1) complete(peer, 'r1', 'FIRST');
      else {
        if (visible) emit(peer, { type: 'response.function_call_arguments.delta', delta: '{' });
        emit(peer, { type: 'error', status: 400, error: { code: 'previous_response_not_found' } });
      }
    });
    const session = new UpstreamSession({ enabled: true, socket: app.socket, fallback: async () => { throw new Error('no HTTP fallback'); } });
    try {
      await collect(await session.fetch(target, init([user('first')])));
      const response = await session.transport('r1')(target, init([user('first'), assistant('FIRST'), user('next')]));
      expect(app.messages).toHaveLength(visible ? 2 : 3);
      if (visible) expect((await collect(response)).at(-1)?.type).toBe('error');
      else { expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { code: 'previous_response_not_found' } }); }
    } finally { session.close(); app.close(); }
  }
});

test('provisional metadata is bounded and committing an oversized frame disables replay', async () => {
  const app = fixture((peer, _request, count) => {
    if (count === 1) complete(peer, 'r1', 'FIRST');
    else {
      emit(peer, { type: 'response.created', response: { id: 'large', padding: 'x'.repeat(256) } });
      emit(peer, { type: 'error', status: 400, error: { code: 'previous_response_not_found' } });
    }
  });
  const session = new UpstreamSession({ enabled: true, socket: app.socket, maxProvisionalBytes: 128, fallback: async () => { throw new Error('no HTTP fallback'); } });
  try {
    await collect(await session.fetch(target, init([user('first')])));
    const events = await collect(await session.transport('r1')(target, init([user('first'), assistant('FIRST'), user('next')])));
    expect(events.map(event => event.type)).toEqual(['response.created', 'error']);
    expect(app.messages).toHaveLength(2);
  } finally { session.close(); app.close(); }
});

test('an initial native status is returned before committing SSE so account refresh and quota policy can act', async () => {
  for (const status of [401, 429]) {
    const app = fixture(peer => emit(peer, { type: 'error', status, error: { code: status === 401 ? 'invalid_token' : 'usage_limit_reached', message: 'synthetic' } }));
    const session = new UpstreamSession({ enabled: true, socket: app.socket, fallback: async () => { throw new Error('no HTTP fallback'); } });
    try {
      const response = await session.fetch(target, init([user('first')]));
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { message: 'synthetic' } });
    } finally { session.close(); app.close(); }
  }
});

test('synthetic HTTP errors retain native quota metadata and strip body encoding/framing/hop-by-hop headers', async () => {
  const app = fixture(peer => emit(peer, { type: 'error', status: 429, error: { code: 'usage_limit_reached' }, headers: {
    'content-length': '999999', 'content-encoding': 'gzip', 'transfer-encoding': 'chunked', connection: 'keep-alive',
    upgrade: 'websocket', 'keep-alive': 'timeout=999', trailer: 'x-trailer', 'sec-websocket-accept': 'synthetic',
    'content-type': 'text/html', 'retry-after': '60', 'x-codex-primary-reset-after-seconds': '120',
    'x-ratelimit-remaining-requests': '0', 'x-request-id': 'synthetic-id', 'x-arbitrary': 'drop',
  } }));
  const session = new UpstreamSession({ enabled: true, socket: app.socket, fallback: async () => { throw new Error('no HTTP fallback'); } });
  try {
    const response = await session.fetch(target, init([user('first')]));
    expect(response.status).toBe(429);
    for (const header of ['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'upgrade', 'keep-alive', 'trailer', 'sec-websocket-accept', 'x-arbitrary']) expect(response.headers.has(header)).toBe(false);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('x-codex-primary-reset-after-seconds')).toBe('120');
    expect(response.headers.get('x-ratelimit-remaining-requests')).toBe('0');
    expect(response.headers.get('x-request-id')).toBe('synthetic-id');
    expect(await response.json()).toEqual({ error: { code: 'usage_limit_reached' } });
  } finally { session.close(); app.close(); }
});

test('hidden created metadata followed by 401 earns one shared-account refresh without duplicate created events', async () => {
  const home = await mkdtemp(join(tmpdir(), 'upstream-account-'));
  const jwt = (value: unknown) => 'fixture.' + Buffer.from(JSON.stringify(value)).toString('base64url') + '.fixture';
  const writeAuth = (version: number) => Bun.write(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    access_token: jwt({ exp: Date.now() / 1000 + 3600, version }), id_token: jwt({ email: 'fixture@example.com' }), account_id: 'fixture-account',
  } }));
  let refreshes = 0;
  await writeAuth(1);
  await Bun.write(join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] }));
  const app = fixture((peer, _request, count) => {
    if (count === 2) {
      emit(peer, { type: 'response.created', response: { id: 'hidden-rejected', output: [] } });
      emit(peer, { type: 'error', status: 401, error: { code: 'invalid_token' } });
    } else complete(peer, 'r' + count, count === 1 ? 'FIRST' : 'FINAL');
  });
  const session = new UpstreamSession({ enabled: true, socket: app.socket, fallback: async () => { throw new Error('no HTTP fallback'); } });
  const account = new AccountUpstream({ home, prefix: 'secondary', binary: 'unused', refresh: async () => { refreshes++; await writeAuth(2); } }, async () => { throw new Error('wrong transport'); });
  try {
    const request = (input: unknown[]) => init(input, { model: 'secondary-gpt-6.1-sol' });
    await collect(await account.withTransport(session.transport())(target, request([user('first')])));
    const events = await collect(await account.withTransport(session.transport('r1'))(target, request([user('first'), assistant('FIRST'), user('next')])));
    expect(refreshes).toBe(1); expect(app.messages).toHaveLength(3); expect(app.opens).toBe(2);
    expect(app.handshakes[0].get('authorization')).not.toBe(app.handshakes[1].get('authorization'));
    expect(events.filter(event => event.type === 'response.created').map(event => isRecord(event.response) && event.response.id)).toEqual(['r3']);
    expect(events.at(-1)?.type).toBe('response.completed');
  } finally { session.close(); app.close(); await rm(home, { recursive: true, force: true }); }
});

test('an unpublished missing-history replay preserves its subsequent initial refusal status', async () => {
  const app = fixture((peer, _request, count) => {
    if (count === 1) complete(peer, 'r1', 'FIRST');
    else if (count === 2) {
      emit(peer, { type: 'response.created', response: { id: 'hidden-rejected' } });
      emit(peer, { type: 'error', status: 400, error: { code: 'previous_response_not_found' } });
    } else {
      emit(peer, { type: 'response.created', response: { id: 'hidden-refusal' } });
      emit(peer, { type: 'error', status: 403, error: { code: 'denied' } });
    }
  });
  const session = new UpstreamSession({ enabled: true, socket: app.socket, fallback: async () => { throw new Error('no HTTP fallback'); } });
  try {
    await collect(await session.fetch(target, init([user('first')])));
    const response = await session.transport('r1')(target, init([user('first'), assistant('FIRST'), user('next')]));
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: { code: 'denied' } });
    expect(app.messages).toHaveLength(3);
  } finally { session.close(); app.close(); }
});

test('a flush deadline exposes long-turn progress before completion and a late 401 stays a stream error', async () => {
  let nextPeer!: Peer;
  const app = fixture((peer, _request, count) => {
    if (count === 1) complete(peer, 'r1', 'FIRST');
    else { nextPeer = peer; emit(peer, { type: 'response.created', response: { id: 'slow', output: [] } }); }
  });
  const session = new UpstreamSession({ enabled: true, socket: app.socket, maxProvisionalMs: 10, fallback: async () => { throw new Error('no HTTP fallback'); } });
  try {
    await collect(await session.fetch(target, init([user('first')])));
    const response = await session.transport('r1')(target, init([user('first'), assistant('FIRST'), user('next')]));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const progress = new TextDecoder().decode((await reader.read()).value);
    expect(progress).toContain('response.created'); expect(progress).toContain('slow');
    emit(nextPeer, { type: 'error', status: 401, error: { code: 'invalid_token' } });
    const error = new TextDecoder().decode((await reader.read()).value);
    expect(error).toContain('invalid_token'); expect((await reader.read()).done).toBe(true);
    expect(app.messages).toHaveLength(2);
    await app.closed;
    expect(app.closes).toBe(1);
  } finally { session.close(); app.close(); }
});

test('provisional flush timers are cleared on replay, completion and cancellation', async () => {
  let received!: () => void;
  const waiting = new Promise<void>(resolve => { received = resolve; });
  const app = fixture((peer, _request, count) => {
    if (count === 1) complete(peer, 'r1', 'FIRST');
    else if (count === 2) {
      emit(peer, { type: 'response.created', response: { id: 'hidden' } });
      emit(peer, { type: 'error', status: 400, error: { code: 'previous_response_not_found' } });
    } else if (count === 3) complete(peer, 'r3', 'FINAL');
    else { emit(peer, { type: 'response.created', response: { id: 'waiting' } }); received(); }
  });
  const session = new UpstreamSession({ enabled: true, socket: app.socket, maxProvisionalMs: 4567, fallback: async () => { throw new Error('no HTTP fallback'); } });
  const scheduled = spyOn(globalThis, 'setTimeout'), cleared = spyOn(globalThis, 'clearTimeout');
  try {
    await collect(await session.fetch(target, init([user('first')])));
    const second = [user('first'), assistant('FIRST'), user('second')];
    await collect(await session.transport('r1')(target, init(second)));
    const controller = new AbortController(), request = init([...second, assistant('FINAL'), user('third')]); request.signal = controller.signal;
    const pending = session.transport('r3')(target, request);
    await waiting;
    // Wait for observable scheduling rather than assuming a network frame arrives in one tick.
    const deadline = performance.now() + 1000;
    while (scheduled.mock.calls.filter(([, ms]) => ms === 4567).length < 3 && performance.now() < deadline) await Bun.sleep(1);
    controller.abort(new DOMException('fixture cancelled', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const timers = scheduled.mock.calls.flatMap(([, ms], index) => ms === 4567 ? [scheduled.mock.results[index]] : []);
    expect(timers).toHaveLength(3);
    for (const timer of timers) {
      expect(timer.type).toBe('return');
      if (timer.type === 'return') expect(cleared.mock.calls.some(([value]) => value === timer.value)).toBe(true);
    }
  } finally { scheduled.mockRestore(); cleared.mockRestore(); session.close(); app.close(); }
});

test('unknown pre-send upgrade failures use HTTP to obtain its authoritative status', async () => {
  let fallbacks = 0;
  const request = init([user('first')]);
  const session = new UpstreamSession({ enabled: true, socket: () => { throw new ProxyTransportError(); }, fallback: async (_url, sent) => {
    expect(sent).toBe(request); fallbacks++; return new Response('{}', { status: 429 });
  } });
  try { expect((await session.fetch(target, request)).status).toBe(429); expect(fallbacks).toBe(1); }
  finally { session.close(); }
});

test('only an unsupported pre-send handshake falls back to HTTP; auth failures retain their status', async () => {
  for (const status of [426, 401]) {
    let fallback = 0;
    const request = init([user('first')]);
    const session = new UpstreamSession({ enabled: true, socket: () => { throw new UpstreamStatusError('fixture', status); }, fallback: async (_url, actual) => {
      fallback++; expect(actual).toBe(request); return new Response('{}', { status: 202 });
    } });
    try { expect((await session.fetch(target, request)).status).toBe(status === 426 ? 202 : 401); expect(fallback).toBe(status === 426 ? 1 : 0); }
    finally { session.close(); }
  }
});

test('unsupported handshakes are cached per auth/model scope and warmups stay local on HTTP fallback', async () => {
  let connects = 0, fallbacks = 0;
  const session = new UpstreamSession({ enabled: true, socket: () => { connects++; throw new UpstreamStatusError('fixture', 426); }, fallback: async () => {
    fallbacks++; return new Response('{}');
  } });
  try {
    await collect(await session.fetch(target, init([user('warm')], { generate: false })));
    expect(connects).toBe(1); expect(fallbacks).toBe(0);
    await session.fetch(target, init([user('next')]));
    expect(connects).toBe(1); expect(fallbacks).toBe(1);
    const rotated = init([user('next')]); rotated.headers = { authorization: 'Bearer changed' };
    await session.fetch(target, rotated);
    expect(connects).toBe(2); expect(fallbacks).toBe(2);
  } finally { session.close(); }
});

test('a dropped socket after send fails the stream without HTTP replay', async () => {
  const app = fixture(peer => { emit(peer, { type: 'response.output_text.delta', delta: 'visible' }); peer.close(); });
  let fallbacks = 0;
  const session = new UpstreamSession({ enabled: true, socket: app.socket, fallback: async () => { fallbacks++; return new Response('{}'); } });
  try { await expect(collect(await session.fetch(target, init([user('first')])))).rejects.toBeInstanceOf(ProxyTransportError); expect(fallbacks).toBe(0); }
  finally { session.close(); app.close(); }
});

test('abort during a turn closes the socket and a later turn starts with full context', async () => {
  const app = fixture((peer, _request, count) => count === 1 ? emit(peer, { type: 'response.created', response: { id: 'partial', output: [] } }) : complete(peer, 'r2'));
  const session = new UpstreamSession({ enabled: true, socket: app.socket, fallback: async () => { throw new Error('no HTTP fallback'); } });
  try {
    const controller = new AbortController(); const request = init([user('first')]); request.signal = controller.signal;
    const response = await session.fetch(target, request), reader = response.body!.getReader();
    await reader.read(); controller.abort(new DOMException('fixture cancelled', 'AbortError'));
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    const full = [user('first'), user('replacement')];
    await collect(await session.transport('partial')(target, init(full)));
    expect(app.opens).toBe(2); expect(app.messages[1].input).toEqual(full); expect(app.messages[1]).not.toHaveProperty('previous_response_id');
    session.close();
    await expect(session.fetch(target, init(full))).rejects.toBeInstanceOf(ProxyTransportError);
  } finally { session.close(); app.close(); }
});

test('cancellation during connection and consumer cancellation never invoke HTTP replay', async () => {
  const app = fixture(peer => emit(peer, { type: 'response.created', response: { id: 'partial', output: [] } }));
  let fallbacks = 0;
  const session = new UpstreamSession({ enabled: true, socket: app.socket, fallback: async () => { fallbacks++; return new Response('{}'); } });
  try {
    const controller = new AbortController(), request = init([user('first')]); request.signal = controller.signal;
    const pending = session.fetch(target, request);
    controller.abort(new DOMException('fixture cancelled', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const response = await session.fetch(target, init([user('next')]));
    const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
    expect(fallbacks).toBe(0);
  } finally { session.close(); app.close(); }
});

test('client teardown rejects a turn waiting for its initial upstream event', async () => {
  let started!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  const app = fixture(() => started());
  const session = new UpstreamSession({ enabled: true, socket: app.socket, fallback: async () => { throw new Error('no HTTP fallback'); } });
  try {
    const response = session.fetch(target, init([user('first')]));
    await received; session.close();
    await expect(response).rejects.toBeInstanceOf(ProxyTransportError);
  } finally { session.close(); app.close(); }
});

test('warmups reach the native socket with generate=false and their real response ids can continue', async () => {
  const app = fixture((peer, _request, count) => count === 1 ? complete(peer, 'warm-real', '', []) : complete(peer, 'r2'));
  const session = new UpstreamSession({ enabled: true, socket: app.socket, fallback: async () => new Response('{}') });
  try {
    await collect(await session.fetch(target, init([user('warm')], { generate: false })));
    await collect(await session.transport('warm-real')(target, init([user('warm'), user('next')])));
    expect(app.messages[0].generate).toBe(false);
    expect(app.messages[1]).toMatchObject({ previous_response_id: 'warm-real', input: [user('next')] });
    expect(app.opens).toBe(1);
  } finally { session.close(); app.close(); }
});
