// Cursor bridge failure modes through the router: a scripted bridge binary that really speaks the
// local Connect handshake and SDK endpoints, failing at every stage the real bridge can fail at.
// The scenario travels in the API key so each run also defeats the five-minute profile cache.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { configuredCursorBackend, type CursorBackend } from '../src/backends/cursor';
import type { SubscriptionBackend } from '../src/backends/contract';
import { BACKENDS } from '../src/backends/registry';
import { AUTH_HEADERS, fixtureRouter } from './support';

const INTERNAL = 'Internal router error; Codex will retry.';
const EMAIL = 'bridge@example.com';
const USER = 'user_bridge';
let scratch = '';
let backend: CursorBackend | undefined;
const savedTimeout = process.env.CURSOR_TIMEOUT_MS;
const savedRetry = process.env.CURSOR_RPC_RETRY_MS;
const savedReachability = process.env.CURSOR_REACHABILITY_URL;
// Stands in for api2.cursor.sh so the reachability probe never leaves the machine.
const cursorApi = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 404 }) });
// Every cell spawns the scripted bridge on three transports; under full-suite load that can exceed
// bun's 5s default, and a short Cursor timeout would trip normal turns. Only the hang cell shortens it.
setDefaultTimeout(20_000);

beforeAll(async () => {
  scratch = await mkdtemp(tmpdir() + '/cursor-bridge-matrix-');
  const bridge = scratch + '/bridge';
  await Bun.write(bridge, `#!/usr/bin/env bun
const scenario = (process.env.CURSOR_API_KEY ?? '').replace(/^key-/, '');
await Bun.write('${scratch}/bridge.pid', String(process.pid));
if (scenario === 'BRIDGE_CRASH') { console.error('bridge: cannot bind'); process.exit(1); }
if (scenario === 'BRIDGE_GARBAGE') { console.error('cursor-sdk-bridge ready <<not json>>'); await new Promise(() => {}); }
if (scenario === 'BRIDGE_BADHANDSHAKE') { console.error('cursor-sdk-bridge ready ' + JSON.stringify({ schemaVersion: 2 })); await new Promise(() => {}); }
if (scenario === 'BRIDGE_SLOW') await new Promise(r => setTimeout(r, 3000));
if (scenario === 'BRIDGE_SLOW_ONCE') { const marker = '${scratch}/slow-start-seen'; if (!(await Bun.file(marker).exists())) { await Bun.write(marker, '1'); await new Promise(r => setTimeout(r, 3000)); } }
const FINISHED = 'RUN_LIFECYCLE_STATUS_FINISHED';
// A finished run streams its reply as assistant text before the terminal record.
const rawFrame = (flags, value) => { const json = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(5); head[0] = flags; head.writeUInt32BE(json.length, 1); return Buffer.concat([head, json]); };
const frame = (flags, value) => { const text = value?.result?.result?.result; return typeof text === 'string' ? Buffer.concat([rawFrame(0, { sdkMessage: { type: 'assistant', message: { type: 'assistant', run_id: 'run-1', message: { role: 'assistant', content: [{ type: 'text', text }] } } } }), rawFrame(flags, value)]) : rawFrame(flags, value); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const catalog = { items: [
  { id: 'kimi-k3', parameters: [{ id: 'reasoning', values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] }] },
  { id: 'grok-4.7', parameters: [{ id: 'reasoning_effort', values: [{ value: 'high' }] }, { id: 'context', values: [{ value: '256k' }] }, { id: 'fast', values: [{ value: 'false' }] }] },
] };
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/Me')) {
    if (scenario === 'SDK_401') return json({ code: 'unauthenticated' }, 401);
    if (scenario === 'SDK_429') return json({ code: 'resource_exhausted' }, 429);
    if (scenario === 'SDK_503') return json({ code: 'unavailable' }, 503);
    // 2026-10-19 live shape: Me answered 500 'internal'. Twice then fine (in-place retries), or every time.
    if (scenario === 'ME_500_TWICE') { const marker = '${scratch}/me500-count'; const n = (await Bun.file(marker).exists()) ? Number(await Bun.file(marker).text()) : 0; if (n < 2) { await Bun.write(marker, String(n + 1)); return json({ code: 'internal' }, 500); } }
    if (scenario === 'ME_500') return json({ code: 'internal' }, 500);
    if (scenario === 'IDENTITY') return json({ user: { userEmail: 'other@example.com', userId: 'user_other' } });
    return json({ user: { userEmail: '${EMAIL}', userId: '${USER}' } });
  }
  if (path.endsWith('/ListModels')) return json(scenario === 'CATALOG_BAD' ? { nope: true } : scenario === 'MODEL_MISSING' ? { items: [] } : catalog);
  if (path.endsWith('/SetToolCallback')) return json({});
  if (path.endsWith('/CreateAgent')) return json(scenario === 'AGENT_BAD' ? {} : { agentId: 'agent-1' });
  if (path.endsWith('/CancelRun') || path.endsWith('/CloseAgent')) return json({});
  if (path.endsWith('/Send')) {
    if (scenario === 'HANG') await new Promise(() => {});
    if (scenario === 'SEND_OVERFLOW') return json({ code: 'invalid_argument', message: 'prompt is too long for this model' }, 400);
    // 2026-10-19 live shape: Send itself answered HTTP 500 'internal'. Once, then fine; or every time.
    if (scenario === 'SEND_500_ONCE') { const marker = '${scratch}/send500-seen'; if (!(await Bun.file(marker).exists())) { await Bun.write(marker, '1'); return json({ code: 'internal' }, 500); } }
    if (scenario === 'SEND_500') return json({ code: 'internal' }, 500);
    const headers = { 'content-type': 'application/connect+json' };
    const run = (result) => ({ result: { status: FINISHED, runId: 'run-1', result: { status: FINISHED, result, model: { id: 'kimi-k3', params: [{ id: 'reasoning', value: 'high' }] }, usage: { inputTokens: 3, outputTokens: 2 } } } });
    if (scenario === 'RUN_OVERFLOW') return new Response(Buffer.concat([frame(0, { result: { status: 'RUN_LIFECYCLE_STATUS_ERROR', runId: 'run-1', result: { status: 'RUN_LIFECYCLE_STATUS_ERROR', error: 'prompt is too long for this model' } } }), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers });
    if (scenario === 'STREAM_INTERNAL_ONCE') { const marker = '${scratch}/stream-internal-seen'; if (!(await Bun.file(marker).exists())) { await Bun.write(marker, '1'); return new Response(frame(2, { error: { code: 'internal' } }), { headers }); } }
    if (scenario === 'SLOW') {
      // Six keepalive frames 250 ms apart, then the result: 1.5 s total, never more than 250 ms silent.
      const stream = new ReadableStream({ async start(controller) {
        for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 250)); controller.enqueue(frame(0, { sdkMessage: { message: { runId: 'run-1', step: i } } })); }
        controller.enqueue(frame(0, run('CURSOR_SLOW_OK'))); controller.enqueue(frame(0, { done: { runId: 'run-1' } })); controller.enqueue(frame(2, {})); controller.close();
      } });
      return new Response(stream, { headers });
    }
    if (scenario === 'STREAM_ERROR') return new Response(Buffer.concat([frame(0, { sdkMessage: { message: { runId: 'run-1' } } }), frame(2, { error: { code: 'internal' } })]), { headers });
    if (scenario === 'STREAM_OVERFLOW') return new Response(Buffer.concat([frame(0, { sdkMessage: { message: { runId: 'run-1' } } }), frame(2, { error: { code: 'invalid_argument', message: 'prompt is too long for this model' } })]), { headers });
    if (scenario === 'TRUNCATED') return new Response(frame(0, run('{}')).subarray(0, 12), { headers });
    if (scenario === 'NATIVE') return new Response(Buffer.concat([frame(0, { sdkMessage: { message: { content: [{ type: 'tool_use', name: 'shell' }] } } }), frame(0, run('{}')), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers });
    if (scenario === 'UNFINISHED') return new Response(Buffer.concat([frame(0, { result: { status: 'RUN_LIFECYCLE_STATUS_ERROR', runId: 'run-1', result: { status: 'RUN_LIFECYCLE_STATUS_ERROR' } } }), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers });
    // A provider-side transient failure (what native Codex retries on 429/5xx): the first run errors
    // with Cursor's reason string, the fresh retry succeeds. A non-transient reason is not retried.
    // Each attempt launches a fresh bridge process, so the first/second distinction lives on disk.
    if (scenario === 'UNFINISHED_TRANSIENT') { const marker = '${scratch}/transient-seen'; if (!(await Bun.file(marker).exists())) { await Bun.write(marker, '1'); return new Response(Buffer.concat([frame(0, { result: { status: 'RUN_LIFECYCLE_STATUS_ERROR', runId: 'run-1', result: { status: 'RUN_LIFECYCLE_STATUS_ERROR', error: 'upstream provider rate limit exceeded, try again' } } }), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers }); } return new Response(Buffer.concat([frame(0, run('CURSOR_AFTER_TRANSIENT')), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers }); }
    if (scenario === 'UNFINISHED_REASON') return new Response(Buffer.concat([frame(0, { result: { status: 'RUN_LIFECYCLE_STATUS_ERROR', runId: 'run-1', result: { status: 'RUN_LIFECYCLE_STATUS_ERROR', error: 'model refused the request policy' } } }), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers });
    // 2026-10-15 live shape: status ERROR with every reason field empty. Nothing has executed, so it
    // gets the same single fresh attempt as a transient provider error; here the retry succeeds.
    if (scenario === 'UNFINISHED_OPAQUE') { const marker = '${scratch}/opaque-seen'; if (!(await Bun.file(marker).exists())) { await Bun.write(marker, '1'); return new Response(Buffer.concat([frame(0, { result: { status: 'RUN_LIFECYCLE_STATUS_ERROR', runId: 'run-1', result: { status: 'RUN_LIFECYCLE_STATUS_ERROR' } } }), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers }); } return new Response(Buffer.concat([frame(0, run('CURSOR_AFTER_OPAQUE')), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers }); }
    if (scenario === 'WRONG_MODEL') { const body = run('x'); body.result.result.model.params = [{ id: 'reasoning', value: 'low' }]; return new Response(Buffer.concat([frame(0, body), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers }); }
    return new Response(Buffer.concat([frame(0, run('CURSOR_OK')), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers });
  }
  return json({ code: 'unimplemented' }, 404);
} });
await Bun.write('${scratch}/bridge-token', 'token-' + scenario);
console.error('cursor-sdk-bridge ready ' + JSON.stringify({ schemaVersion: 1, host: '127.0.0.1', protocol: 'connect', transport: 'tcp', port: server.port, authTokenFile: '${scratch}/bridge-token', url: 'http://127.0.0.1:' + server.port }));
await new Promise(() => {});
`);
  await chmod(bridge, 0o700);
  const hash = createHash('sha256').update(await readFile(bridge)).digest('hex');
  await scenario('OK');
  backend = configuredCursorBackend({ CURSOR_BRIDGE_BIN: bridge, CURSOR_BRIDGE_SHA256: hash, CURSOR_AUTH_FILE: scratch + '/auth.json', CURSOR_CWD: scratch, CURSOR_EXPECTED_EMAIL: EMAIL, CURSOR_EXPECTED_USER_ID: USER, CURSOR_MODEL_PREFIX: 'cx', CURSOR_LABEL: 'Bridge fixture' });
  if (!backend) throw new Error('fixture backend not configured');
  (BACKENDS as SubscriptionBackend[]).push(backend);
  process.env.CURSOR_TIMEOUT_MS = '10000';
  process.env.CURSOR_RPC_RETRY_MS = '20';
  process.env.CURSOR_REACHABILITY_URL = `http://127.0.0.1:${cursorApi.port}`;
});
afterAll(async () => {
  await backend?.close();
  if (backend) { const at = BACKENDS.indexOf(backend); if (at >= 0) (BACKENDS as SubscriptionBackend[]).splice(at, 1); }
  if (savedTimeout === undefined) delete process.env.CURSOR_TIMEOUT_MS; else process.env.CURSOR_TIMEOUT_MS = savedTimeout;
  if (savedRetry === undefined) delete process.env.CURSOR_RPC_RETRY_MS; else process.env.CURSOR_RPC_RETRY_MS = savedRetry;
  if (savedReachability === undefined) delete process.env.CURSOR_REACHABILITY_URL; else process.env.CURSOR_REACHABILITY_URL = savedReachability;
  cursorApi.stop(true);
  await rm(scratch, { recursive: true, force: true });
});

/** Selects the bridge scenario by rewriting the owner-only credential file (a new key per scenario). */
async function scenario(name: string): Promise<void> {
  await writeFile(scratch + '/auth.json', JSON.stringify({ apiKey: 'key-' + name, email: EMAIL, backendUrl: 'https://api2.cursor.sh' }), { mode: 0o600 });
  await chmod(scratch + '/auth.json', 0o600);
}

type App = Awaited<ReturnType<typeof fixtureRouter>>;
const MODEL = 'cx-kimi-k3';
const body = (text: string) => ({ model: MODEL, input: [{ role: 'user', content: text }], reasoning: { effort: 'high' } });
const post = (app: App, payload: unknown, init: RequestInit = {}) =>
  fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(payload), ...init });
const sse = (text: string) => text.split('\n').filter(l => l.startsWith('data: ')).flatMap(l => { try { return [JSON.parse(l.slice(6)) as any]; } catch { return []; } });
const terminal = (text: string) => sse(text).find(e => ['response.failed', 'response.completed'].includes(e.type));
async function socketTurn(app: App, payload: unknown, timeoutMs = 8000): Promise<any> {
  const Socket = WebSocket as unknown as { new (url: string, options: { headers: Record<string, string> }): WebSocket };
  const ws = new Socket(app.url('/v1/responses').replace('http:', 'ws:'), { headers: AUTH_HEADERS });
  try {
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket turn timed out')), timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'response.create', ...(payload as object) }));
      ws.onerror = () => { clearTimeout(timer); reject(new Error('socket failed')); };
      ws.onclose = (e) => { clearTimeout(timer); resolve({ type: 'close', code: e.code, reason: e.reason }); };
      ws.onmessage = (e) => { const event = JSON.parse(String(e.data)); if (['response.failed', 'response.completed', 'error'].includes(event.type)) { clearTimeout(timer); resolve(event); } };
    });
  } finally { ws.close(); }
}
type Seen = { status: number | undefined; code: string; message: string; transport: string };
async function everyTransport(app: App, payload: Record<string, unknown>): Promise<Seen[]> {
  const seen: Seen[] = [];
  const plain = await post(app, payload);
  const plainBody = await plain.json() as any;
  seen.push({ transport: 'http', status: plain.status, code: plainBody.error?.code ?? plainBody.error?.type ?? 'ok', message: plainBody.error?.message ?? plainBody.output?.[0]?.content?.[0]?.text ?? '' });
  const stream = await post(app, { ...payload, stream: true });
  const event = terminal(await stream.text());
  seen.push({ transport: 'sse', status: stream.status, code: event?.response?.error?.code ?? (event?.type === 'response.completed' ? 'ok' : 'none'), message: event?.response?.error?.message ?? event?.response?.output?.[0]?.content?.[0]?.text ?? '' });
  const ws = await socketTurn(app, payload);
  seen.push({ transport: 'ws', status: ws.status, code: ws.error?.code ?? ws.response?.error?.code ?? (ws.type === 'response.completed' ? 'ok' : ws.type), message: ws.error?.message ?? ws.response?.error?.message ?? ws.response?.output?.[0]?.content?.[0]?.text ?? '' });
  return seen;
}
const expectTerminal = (seen: Seen[], fragment: string) => {
  for (const cell of seen) {
    expect(cell.code, cell.transport).toBe(cell.transport === 'http' ? 'invalid_request_error' : 'invalid_prompt');
    expect(cell.message, cell.transport).toContain(fragment);
    if (cell.transport === 'http') expect(cell.status).toBe(400);
  }
};
const expectOk = (seen: Seen[], text: string) => { for (const cell of seen) { expect(cell.code, cell.transport).toBe('ok'); expect(cell.message, cell.transport).toBe(text); } };
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const bridgePid = async () => Number(await readFile(scratch + '/bridge.pid', 'utf8'));

describe('Cursor bridge failures through the router', () => {
  test('the scripted bridge serves normal turns on every transport and stays available for reuse', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('OK');
      expectOk(await everyTransport(app, body('hello')), 'CURSOR_OK');
      await sleep(50);
      expect(pidAlive(await bridgePid())).toBe(true);
    } finally { await app.close(); }
  });

  test('bridge crash, garbage handshake and wrong schema are refused with the stage named', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('BRIDGE_CRASH'); expectTerminal(await everyTransport(app, body('x')), 'exited before ready');
      await scenario('BRIDGE_GARBAGE'); expectTerminal(await everyTransport(app, body('x')), 'startup or diagnostics failed');
      await scenario('BRIDGE_BADHANDSHAKE'); expectTerminal(await everyTransport(app, body('x')), 'invalid local handshake');
      await sleep(50);
      expect(pidAlive(await bridgePid())).toBe(false);
    } finally { await app.close(); }
  });

  test('SDK refusals carry the HTTP status and code, never a fallback, and never leak the key', async () => {
    const app = await fixtureRouter();
    try {
      for (const [name, status, code] of [['SDK_401', 401, 'unauthenticated'], ['SDK_429', 429, 'resource_exhausted']] as const) {
        await scenario(name);
        const seen = await everyTransport(app, body('x'));
        expectTerminal(seen, `HTTP ${status}, ${code}`);
        for (const cell of seen) expect(cell.message).not.toContain('key-');
      }
    } finally { await app.close(); }
  });

  test('a Connect `unavailable` (Cursor unreachable) is an outage: plain JSON gets a 503, streams stay pending until it clears', async () => {
    const savedOffline = process.env.OFFLINE_RETRY_BASE_MS; process.env.OFFLINE_RETRY_BASE_MS = '20';
    const app = await fixtureRouter({ heartbeatMs: 20 });
    try {
      await scenario('SDK_503');
      const plain = await post(app, body('x'));
      expect(plain.status).toBe(503);
      const text = await plain.text();
      expect(text).toContain('server_error'); expect(text).toContain('Network connection interrupted'); expect(text).not.toContain('key-');
      // The stream rides out the outage: the bridge is re-spawned with the restored key and the
      // same request completes without a response.failed in between.
      const inflight = post(app, { ...body('x'), stream: true }).then(r => r.text());
      await sleep(300);
      await scenario('OK');
      const stream = await inflight;
      expect(stream).toContain('response.in_progress');
      expect(terminal(stream)?.type).toBe('response.completed');
      expect(stream).toContain('CURSOR_OK'); expect(stream).not.toContain('response.failed');
    } finally { await app.close(); if (savedOffline === undefined) delete process.env.OFFLINE_RETRY_BASE_MS; else process.env.OFFLINE_RETRY_BASE_MS = savedOffline; }
  });

  test('identity mismatch, broken catalog, missing model and failed agent creation are refused', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('IDENTITY'); expectTerminal(await everyTransport(app, body('x')), 'differs from the pinned identity');
      await scenario('CATALOG_BAD'); expectTerminal(await everyTransport(app, body('x')), 'invalid model catalog');
      await scenario('MODEL_MISSING'); expectTerminal(await everyTransport(app, body('x')), 'unavailable on the pinned Cursor account');
      await scenario('AGENT_BAD'); expectTerminal(await everyTransport(app, body('x')), 'agent creation failed');
    } finally { await app.close(); }
  });

  test('context overflow from an RPC, stream trailer or terminal run keeps the native context_length_exceeded code', async () => {
    const app = await fixtureRouter();
    try {
      for (const name of ['SEND_OVERFLOW', 'STREAM_OVERFLOW', 'RUN_OVERFLOW']) {
        await scenario(name);
        for (const cell of await everyTransport(app, body('x'))) {
          expect(cell.code, name + ':' + cell.transport).toBe('context_length_exceeded');
          expect(cell.message, name + ':' + cell.transport).toContain('context window');
        }
      }
    } finally { await app.close(); }
  });

  test('a transient internal Connect trailer gets one safe fresh attempt and then completes', async () => {
    const app = await fixtureRouter();
    try { await scenario('STREAM_INTERNAL_ONCE'); expectOk(await everyTransport(app, body('x')), 'CURSOR_OK'); }
    finally { await app.close(); }
  });

  test('stream errors, truncation, native tool use, unfinished runs and model drift are refused', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('STREAM_ERROR'); expectTerminal(await everyTransport(app, body('x')), 'stream failed');
      await scenario('TRUNCATED'); expectTerminal(await everyTransport(app, body('x')), 'partial frame');
      await scenario('NATIVE'); expectTerminal(await everyTransport(app, body('x')), 'native tool');
      await scenario('UNFINISHED'); expectTerminal(await everyTransport(app, body('x')), 'did not finish successfully');
      await scenario('UNFINISHED_REASON'); expectTerminal(await everyTransport(app, body('x')), 'run status ERROR: model refused the request policy');
      await scenario('WRONG_MODEL'); expectTerminal(await everyTransport(app, body('x')), 'different model or reasoning setting');
    } finally { await app.close(); }
  });

  test('a transient provider error on the run is retried once with a fresh agent, like native 429/5xx handling', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('UNFINISHED_TRANSIENT');
      for (const cell of await everyTransport(app, body('x'))) {
        expect(cell.code, cell.transport).toBe('ok');
        expect(cell.message, cell.transport).toContain('CURSOR_AFTER_TRANSIENT');
      }
    } finally { await app.close(); }
  });

  test('an errored run with no reason at all is retried once like a transient error; the retry succeeds', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('UNFINISHED_OPAQUE');
      for (const cell of await everyTransport(app, body('x'))) {
        expect(cell.code, cell.transport).toBe('ok');
        expect(cell.message, cell.transport).toContain('CURSOR_AFTER_OPAQUE');
      }
    } finally { await app.close(); }
  });

  test('an SDK HTTP 500 is retried once with a fresh bridge; the retry succeeds', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('SEND_500_ONCE');
      for (const cell of await everyTransport(app, body('x'))) {
        expect(cell.code, cell.transport).toBe('ok');
        expect(cell.message, cell.transport).toContain('CURSOR_OK');
      }
    } finally { await app.close(); }
  });

  test('an SDK HTTP 500 that repeats on the retry is refused with its status and code', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('SEND_500');
      const seen = await everyTransport(app, body('x'));
      expectTerminal(seen, 'HTTP 500, internal');
      for (const cell of seen) expect(cell.message).not.toContain('key-');
    } finally { await app.close(); }
  });

  test('a bridge that misses the startup window is retried once with a fresh bridge; the retry succeeds', async () => {
    const app = await fixtureRouter();
    process.env.CURSOR_STARTUP_TIMEOUT_MS = '500';
    try {
      await scenario('BRIDGE_SLOW_ONCE');
      expectOk(await everyTransport(app, body('x')), 'CURSOR_OK');
    } finally { delete process.env.CURSOR_STARTUP_TIMEOUT_MS; await app.close(); }
  });

  test('a bridge that misses the startup window twice is refused naming the startup timeout', async () => {
    const app = await fixtureRouter();
    process.env.CURSOR_STARTUP_TIMEOUT_MS = '500';
    try {
      await scenario('BRIDGE_SLOW');
      expectTerminal(await everyTransport(app, body('x')), 'Cursor bridge startup timed out');
      await sleep(50);
      expect(pidAlive(await bridgePid())).toBe(false);
    } finally { delete process.env.CURSOR_STARTUP_TIMEOUT_MS; await app.close(); }
  });

  test('a setup RPC that answers 500 is retried in place with backoff; the turn succeeds', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('ME_500_TWICE');
      expectOk(await everyTransport(app, body('x')), 'CURSOR_OK');
    } finally { await app.close(); }
  });

  test('a setup RPC that keeps answering 500 while Cursor is reachable is refused with its status and code', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('ME_500');
      expectTerminal(await everyTransport(app, body('x')), 'HTTP 500, internal');
    } finally { await app.close(); }
  });

  test('a persistent 500 while Cursor is unreachable is an outage: streams stay pending until the network returns', async () => {
    const savedOffline = process.env.OFFLINE_RETRY_BASE_MS; process.env.OFFLINE_RETRY_BASE_MS = '20';
    process.env.CURSOR_REACHABILITY_URL = 'http://127.0.0.1:1';
    const app = await fixtureRouter({ heartbeatMs: 20 });
    try {
      await scenario('ME_500');
      const plain = await post(app, body('x'));
      expect(plain.status).toBe(503);
      expect(await plain.text()).toContain('Network connection interrupted');
      const inflight = post(app, { ...body('x'), stream: true }).then(r => r.text());
      await sleep(300);
      await scenario('OK');
      const stream = await inflight;
      expect(terminal(stream)?.type).toBe('response.completed');
      expect(stream).toContain('CURSOR_OK'); expect(stream).not.toContain('response.failed');
    } finally {
      await app.close();
      process.env.CURSOR_REACHABILITY_URL = `http://127.0.0.1:${cursorApi.port}`;
      if (savedOffline === undefined) delete process.env.OFFLINE_RETRY_BASE_MS; else process.env.OFFLINE_RETRY_BASE_MS = savedOffline;
    }
  });

  // Envelope repair exists only on the JSON path; native replies are text and real tool calls.
  test('a hung Send is cut at the Cursor timeout and the bridge is killed', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('HANG');
      process.env.CURSOR_TIMEOUT_MS = '600';
      const seen = await everyTransport(app, body('x')).finally(() => { process.env.CURSOR_TIMEOUT_MS = '10000'; });
      // Same shape as the Grok CLI watchdog: a deliberate terminal refusal that names the cause,
      // never the anonymous INTERNAL message (which would hide why the turn died).
      expectTerminal(seen, 'Cursor request timed out');
      for (const c of seen) expect(c.message).not.toContain(INTERNAL);
      await sleep(50);
      expect(pidAlive(await bridgePid())).toBe(false);
      await scenario('OK');
      expectOk(await everyTransport(app, body('after-hang')), 'CURSOR_OK');
    } finally { await app.close(); }
  });

  test('a slow but steady stream outlives the idle window because every frame restarts it', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('SLOW');
      // 600 ms of silence would cut it; the stream stays quiet for at most 250 ms but runs 1.5 s.
      process.env.CURSOR_TIMEOUT_MS = '600';
      const seen = await everyTransport(app, body('slow')).finally(() => { process.env.CURSOR_TIMEOUT_MS = '10000'; });
      expectOk(seen, 'CURSOR_SLOW_OK');
    } finally { await app.close(); }
  });

  test('a client cancel mid-run kills the bridge', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('HANG');
      const controller = new AbortController();
      const pending = post(app, body('x'), { signal: controller.signal }).catch(error => error);
      await sleep(300);
      const pid = await bridgePid();
      expect(pidAlive(pid)).toBe(true);
      controller.abort();
      await pending;
      await sleep(150);
      expect(pidAlive(pid)).toBe(false);
    } finally { await app.close(); }
  });
});
