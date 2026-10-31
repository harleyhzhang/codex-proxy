// Cursor failure modes through the router on plain HTTP, SSE and WebSocket, against a scripted SDK:
// SDK refusals keep their status and Cursor's reason, outages stay pending, transient provider
// failures get one fresh attempt, and nothing native or off-model ever reaches Codex.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import type { SubscriptionBackend } from '../src/backends/contract';
import { BACKENDS } from '../src/backends/registry';
import { scriptedCursor, sdkError } from './cursor-sdk-fixture';
import { AUTH_HEADERS, fixtureRouter } from './support';

type Fixture = Awaited<ReturnType<typeof scriptedCursor>>;
type State = Fixture['state'];
let f: Fixture;
let app: Awaited<ReturnType<typeof fixtureRouter>>;
let defaults: State;
const saved = { timeout: process.env.CURSOR_TIMEOUT_MS, offline: process.env.OFFLINE_RETRY_BASE_MS };
beforeAll(async () => {
  f = await scriptedCursor({ prefix: 'cx', label: 'Fixture' });
  defaults = { ...f.state };
  (BACKENDS as SubscriptionBackend[]).push(f.backend);
  process.env.CURSOR_TIMEOUT_MS = '10000';
  process.env.OFFLINE_RETRY_BASE_MS = '20';
  app = await fixtureRouter({ heartbeatMs: 20 });
});
afterAll(async () => {
  await app.close();
  const at = BACKENDS.indexOf(f.backend);
  if (at >= 0) (BACKENDS as SubscriptionBackend[]).splice(at, 1);
  await f.backend.close();
  for (const [key, value] of [['CURSOR_TIMEOUT_MS', saved.timeout], ['OFFLINE_RETRY_BASE_MS', saved.offline]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(f.root, { recursive: true, force: true });
});
/** Each case uses its own key, so the cached identity proof of one never answers another. */
let keys = 0;
async function scenario(change: Partial<State> = {}): Promise<void> {
  Object.assign(f.state, defaults, change);
  await writeFile(f.auth, JSON.stringify({ apiKey: `key-${++keys}`, email: 'test@example.com', backendUrl: 'https://api2.cursor.sh' }), { mode: 0o600 });
}

const body = (text: string) => ({ model: 'cx-kimi-k3', input: [{ role: 'user', content: text }], reasoning: { effort: 'high' } });
const post = (payload: unknown, init: RequestInit = {}) => fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(payload), ...init });
const sse = (text: string) => text.split('\n').filter(l => l.startsWith('data: ')).flatMap(l => { try { return [JSON.parse(l.slice(6)) as any]; } catch { return []; } });
const terminal = (text: string) => sse(text).find(e => ['response.failed', 'response.completed'].includes(e.type));
async function socketTurn(payload: unknown, timeoutMs = 8000): Promise<any> {
  const Socket = WebSocket as unknown as { new (url: string, options: { headers: Record<string, string> }): WebSocket };
  const ws = new Socket(app.url('/v1/responses').replace('http:', 'ws:'), { headers: AUTH_HEADERS });
  try {
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket turn timed out')), timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'response.create', ...(payload as object) }));
      ws.onerror = () => { clearTimeout(timer); reject(new Error('socket failed')); };
      ws.onmessage = (e) => { const event = JSON.parse(String(e.data)); if (['response.failed', 'response.completed', 'error'].includes(event.type)) { clearTimeout(timer); resolve(event); } };
    });
  } finally { ws.close(); }
}
type Seen = { status: number | undefined; code: string; message: string; transport: string };
const lastText = (output: any[] | undefined) => output?.filter(item => item.type === 'message').at(-1)?.content?.[0]?.text ?? '';
async function everyTransport(payload: Record<string, unknown>): Promise<Seen[]> {
  const plain = await post(payload);
  const plainBody = await plain.json() as any;
  const stream = await post({ ...payload, stream: true });
  const event = terminal(await stream.text());
  const ws = await socketTurn(payload);
  return [
    { transport: 'http', status: plain.status, code: plainBody.error?.code ?? plainBody.error?.type ?? 'ok', message: plainBody.error?.message ?? lastText(plainBody.output) },
    { transport: 'sse', status: stream.status, code: event?.response?.error?.code ?? (event?.type === 'response.completed' ? 'ok' : 'none'), message: event?.response?.error?.message ?? lastText(event?.response?.output) },
    { transport: 'ws', status: ws.status, code: ws.error?.code ?? ws.response?.error?.code ?? (ws.type === 'response.completed' ? 'ok' : ws.type), message: ws.error?.message ?? ws.response?.error?.message ?? lastText(ws.response?.output) },
  ];
}
const expectTerminal = (seen: Seen[], fragment: string) => {
  for (const cell of seen) {
    expect(cell.code, cell.transport).toBe(cell.transport === 'http' ? 'invalid_request_error' : 'invalid_prompt');
    expect(cell.message, cell.transport).toContain(fragment);
    expect(cell.message, cell.transport).not.toContain('key-');
    if (cell.transport === 'http') expect(cell.status).toBe(400);
  }
};
const expectOk = (seen: Seen[], text: string) => { for (const cell of seen) { expect(cell.code, cell.transport).toBe('ok'); expect(cell.message, cell.transport).toBe(text); } };
/** Fails every other call, starting with the first: each turn fails once and its retry succeeds. */
function everyOther<T>(failure: () => T): () => T | undefined { let calls = 0; return () => (calls++ % 2 === 0 ? failure() : undefined); }
const errored = (message: string) => ({ status: 'error', error: { message } });
const runResult = (pick: () => unknown) => (_text: string, model: unknown, final: string) => (pick() ?? { status: 'finished', result: final, model }) as never;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Cursor failures through the router', () => {
  test('a normal turn completes on every transport', async () => {
    await scenario();
    expectOk(await everyTransport(body('x')), 'hello');
  });

  test('SDK refusals keep their status and Cursor\'s reason, never fall back, and never leak the key', async () => {
    await scenario({ sendError: () => sdkError('AuthenticationError', 'API key is invalid', { status: 401, code: 'unauthenticated' }) });
    expectTerminal(await everyTransport(body('x')), 'Cursor rejected the SDK login (HTTP 401, unauthenticated); sign in again');
    await scenario({ sendError: () => sdkError('RateLimitError', 'Usage limit for kimi-k3 reached', { status: 429, code: 'resource_exhausted' }) });
    expectTerminal(await everyTransport(body('x')), 'Cursor usage limit reached (HTTP 429, resource_exhausted): Usage limit for kimi-k3 reached');
  });

  test('a network failure is an outage: plain JSON gets a 503, streams stay pending until it clears', async () => {
    let down = true;
    await scenario({ sendError: () => (down ? sdkError('NetworkError', 'fetch failed') : undefined) });
    const plain = await post(body('x'));
    expect(plain.status).toBe(503);
    expect(await plain.text()).toContain('Network connection interrupted');
    const inflight = post({ ...body('x'), stream: true }).then(r => r.text());
    await sleep(200);
    down = false;
    const stream = await inflight;
    expect(stream).toContain('response.in_progress');
    expect(terminal(stream)?.type).toBe('response.completed');
    expect(stream).not.toContain('response.failed');
  });

  test('identity mismatch, broken catalog, missing model and failed agent creation are refused', async () => {
    await scenario({ me: () => ({ userEmail: 'other@example.com', userId: 'fixture' }) });
    expectTerminal(await everyTransport(body('x')), 'differs from the pinned identity');
    await scenario({ models: () => ({ items: 'nope' }) });
    expectTerminal(await everyTransport(body('x')), 'invalid model catalog');
    await scenario({ models: () => [] });
    expectTerminal(await everyTransport(body('x')), 'unavailable on the pinned Cursor account');
    await scenario({ createError: () => sdkError('ConfigurationError', 'Unknown model kimi-k3') });
    expectTerminal(await everyTransport(body('x')), 'Cursor refused the request: Unknown model kimi-k3');
  });

  test('context overflow from a send, an errored run or Cursor\'s own summary keeps the native context_length_exceeded code', async () => {
    await scenario({ sendError: () => sdkError('CursorAgentError', 'prompt is too long for this model') });
    for (const cell of await everyTransport(body('x'))) expect(cell.code, cell.transport).toBe('context_length_exceeded');
    await scenario({ result: runResult(() => errored('prompt is too long for this model')) });
    for (const cell of await everyTransport(body('x'))) expect(cell.code, cell.transport).toBe('context_length_exceeded');
    await scenario();
    for (const cell of await everyTransport(body('SUMMARY'))) expect(cell.code, cell.transport).toBe('context_length_exceeded');
  });

  test('a transient or reasonless errored run, or a retryable SDK failure, gets one fresh attempt and then completes', async () => {
    for (const change of [
      { result: runResult(everyOther(() => errored('upstream provider rate limit exceeded, try again'))) },
      { result: runResult(everyOther(() => errored(''))) },
      { sendError: everyOther(() => sdkError('CursorAgentError', 'internal', { status: 500, code: 'internal' })) },
    ]) {
      await scenario(change);
      expectOk(await everyTransport(body('x')), 'hello');
    }
  });

  test('a repeated SDK 500, a named refusal, native tool use and model drift are refused', async () => {
    await scenario({ sendError: () => sdkError('CursorAgentError', 'internal', { status: 500, code: 'internal' }) });
    expectTerminal(await everyTransport(body('x')), 'Cursor refused the request (HTTP 500, internal)');
    await scenario({ result: runResult(() => errored('model refused the request policy')) });
    expectTerminal(await everyTransport(body('x')), 'run status error: model refused the request policy');
    await scenario();
    expectTerminal(await everyTransport(body('NATIVE_SHELL')), 'native action');
    await scenario({ result: runResult(() => ({ status: 'finished', result: 'x', model: { id: 'kimi-k3', params: [{ id: 'reasoning', value: 'low' }] } })) });
    expectTerminal(await everyTransport(body('x')), 'different model or reasoning setting');
  });

  test('a silent run is cut at the Cursor timeout and cancelled; the next turn works', async () => {
    await scenario();
    process.env.CURSOR_TIMEOUT_MS = '600';
    const before = f.count('cancel');
    const seen = await everyTransport(body('HANG')).finally(() => { process.env.CURSOR_TIMEOUT_MS = '10000'; });
    // Retried once like any transient failure, then refused naming the cause.
    expectTerminal(seen, 'Cursor request timed out');
    expect(f.count('cancel')).toBeGreaterThanOrEqual(before + 3);
    expectOk(await everyTransport(body('after')), 'hello');
  }, 15_000);

  test('a client cancel mid-run cancels the Cursor run', async () => {
    await scenario();
    const before = f.count('cancel');
    const controller = new AbortController();
    const pending = post(body('HANG'), { signal: controller.signal }).catch(error => error);
    await sleep(200);
    controller.abort();
    await pending;
    await sleep(100);
    expect(f.count('cancel')).toBe(before + 1);
  });
});
