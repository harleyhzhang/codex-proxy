// Subscription text streams to Codex as it is generated, on SSE and WebSocket, as one message item that
// matches the final output; tool calls follow once the turn is validated. Text that reached Codex is
// never retried or replayed.
import { expect, test } from 'bun:test';
import type { SubscriptionBackend } from '../src/backends/contract';
import { backendFor } from '../src/backends/registry';
import type { ProxyOutput } from '../src/protocol/types';
import { ProxyTransportError } from '../src/transport';
import { AUTH_HEADERS, fixtureRouter } from './support';

const MODEL = 'grok-4.7';
const backend = backendFor(MODEL) as SubscriptionBackend;
const body = (extra: Record<string, unknown> = {}) => ({ model: MODEL, stream: true, input: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', name: 'echo', parameters: { type: 'object' } }], ...extra });
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

async function withRun<T>(run: SubscriptionBackend['run'], work: () => Promise<T>): Promise<T> {
  const original = backend.run; backend.run = run;
  try { return await work(); } finally { backend.run = original; }
}

/** A backend that streams `Hel`, waits for `release`, streams `lo`, then returns more text and a call. */
function scripted() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run: SubscriptionBackend['run'] = async (_request, _signal, sink) => {
    sink?.text('Hel');
    await gate;
    sink?.text('lo');
    return { text: 'Hello world', toolCalls: [{ name: 'echo', arguments: '{}', callId: 'call_1' }], usage } satisfies ProxyOutput;
  };
  return { run, release };
}

function checkSequence(events: any[]) {
  const types = events.map(event => event.type).filter(type => type !== 'response.in_progress');
  expect(types).toEqual([
    'response.created', 'response.output_item.added', 'response.content_part.added',
    'response.output_text.delta', 'response.output_text.delta', 'response.output_text.delta',
    'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
    'response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.output_item.done',
    'response.completed',
  ]);
  expect(events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta)).toEqual(['Hel', 'lo', ' world']);
  const message = events.find(event => event.type === 'response.output_item.added').item.id;
  const completed = events.at(-1).response;
  expect(completed.output.map((item: any) => [item.type, item.id === message, item.content?.[0]?.text ?? item.name])).toEqual([['message', true, 'Hello world'], ['function_call', false, 'echo']]);
  expect(events.find(event => event.type === 'response.output_item.added' && event.item.type === 'function_call').output_index).toBe(1);
}

test('SSE: text reaches the client while the backend is still generating, then matches the final output', async () => {
  const app = await fixtureRouter();
  const { run, release } = scripted();
  try {
    await withRun(run, async () => {
      const response = await fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(body()) });
      const reader = response.body!.getReader();
      let raw = '';
      while (!raw.includes('"delta":"Hel"')) raw += new TextDecoder().decode((await reader.read()).value);
      // The backend is still blocked: nothing past the first delta exists yet.
      expect(raw).not.toContain('response.completed');
      release();
      for (;;) { const { value, done } = await reader.read(); if (done) break; raw += new TextDecoder().decode(value); }
      checkSequence(raw.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6))));
    });
  } finally { await app.close(); }
});

function socket(app: Awaited<ReturnType<typeof fixtureRouter>>) {
  const Socket = WebSocket as unknown as { new (url: string, options: { headers: Record<string, string> }): WebSocket };
  const ws = new Socket(app.url('/v1/responses').replace('http:', 'ws:'), { headers: AUTH_HEADERS });
  const events: any[] = [];
  const waiters: Array<() => void> = [];
  ws.onmessage = message => { events.push(JSON.parse(String(message.data))); for (const wake of waiters.splice(0)) wake(); };
  const until = async (test: () => boolean) => { while (!test()) await new Promise<void>(resolve => waiters.push(resolve)); };
  return { ws, events, until, open: new Promise(resolve => { ws.onopen = resolve; }) };
}

test('WebSocket: the same streamed sequence', async () => {
  const app = await fixtureRouter();
  const { run, release } = scripted();
  try {
    await withRun(run, async () => {
      const client = socket(app);
      await client.open;
      client.ws.send(JSON.stringify({ type: 'response.create', ...body() }));
      await client.until(() => client.events.some(event => event.delta === 'Hel'));
      expect(client.events.some(event => event.type === 'response.completed')).toBe(false);
      release();
      await client.until(() => client.events.some(event => event.type === 'response.completed'));
      checkSequence(client.events);
      client.ws.close();
    });
  } finally { await app.close(); }
});

test('an interrupt mid-text closes the streamed message as interrupted and exposes no tool call', async () => {
  const app = await fixtureRouter();
  try {
    await withRun(async (_request, signal, sink) => {
      sink?.text('partial');
      await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
      throw new Error('unreachable');
    }, async () => {
      const client = socket(app);
      await client.open;
      client.ws.send(JSON.stringify({ type: 'response.create', ...body() }));
      await client.until(() => client.events.some(event => event.delta === 'partial'));
      const id = client.events.find(event => event.type === 'response.created').response.id;
      client.ws.send(JSON.stringify({ type: 'response.interrupt', response_id: id }));
      await client.until(() => client.events.some(event => event.type === 'response.incomplete'));
      const types = client.events.map(event => event.type);
      expect(types).toContain('response.output_item.interrupted');
      expect(types).not.toContain('response.function_call_arguments.done');
      client.ws.close();
    });
  } finally { await app.close(); }
});

test('a connection dropped after text reached Codex fails the turn instead of replaying it', async () => {
  const app = await fixtureRouter();
  let calls = 0;
  try {
    await withRun(async (_request, _signal, sink) => { calls++; sink?.text('half'); throw new ProxyTransportError(); }, async () => {
      const text = await (await fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(body()) })).text();
      const last = JSON.parse(text.split('\n').filter(line => line.startsWith('data: {')).at(-1)!.slice(6));
      expect(last.type).toBe('response.failed');
      expect(last.response.error.code).toBe('server_error');
      expect(calls).toBe(1);
    });
  } finally { await app.close(); }
});
