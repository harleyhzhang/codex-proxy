// Cursor bridge failure modes through the router: a scripted bridge binary that really speaks the
// local Connect handshake and SDK endpoints, failing at every stage the real bridge can fail at.
// The scenario travels in the API key so each run also defeats the five-minute profile cache.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { configuredCursorBackend } from '../src/backends/cursor';
import type { SubscriptionBackend } from '../src/backends/contract';
import { BACKENDS } from '../src/backends/registry';
import { AUTH_HEADERS, fixtureRouter } from './support';

const INTERNAL = 'Internal router error; Codex will retry.';
const EMAIL = 'bridge@example.com';
const USER = 'user_bridge';
let scratch = '';
let backend: SubscriptionBackend | undefined;
const savedTimeout = process.env.CURSOR_TIMEOUT_MS;

beforeAll(async () => {
  scratch = await mkdtemp(tmpdir() + '/cursor-bridge-matrix-');
  const bridge = scratch + '/bridge';
  await Bun.write(bridge, `#!/usr/bin/env bun
const scenario = (process.env.CURSOR_API_KEY ?? '').replace(/^key-/, '');
await Bun.write('${scratch}/bridge.pid', String(process.pid));
if (scenario === 'BRIDGE_CRASH') { console.error('bridge: cannot bind'); process.exit(1); }
if (scenario === 'BRIDGE_GARBAGE') { console.error('cursor-sdk-bridge ready <<not json>>'); await new Promise(() => {}); }
if (scenario === 'BRIDGE_BADHANDSHAKE') { console.error('cursor-sdk-bridge ready ' + JSON.stringify({ schemaVersion: 2 })); await new Promise(() => {}); }
const FINISHED = 'RUN_LIFECYCLE_STATUS_FINISHED';
const frame = (flags, value) => { const json = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(5); head[0] = flags; head.writeUInt32BE(json.length, 1); return Buffer.concat([head, json]); };
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
    if (scenario === 'IDENTITY') return json({ user: { userEmail: 'other@example.com', userId: 'user_other' } });
    return json({ user: { userEmail: '${EMAIL}', userId: '${USER}' } });
  }
  if (path.endsWith('/ListModels')) return json(scenario === 'CATALOG_BAD' ? { nope: true } : scenario === 'MODEL_MISSING' ? { items: [] } : catalog);
  if (path.endsWith('/CreateAgent')) return json(scenario === 'AGENT_BAD' ? {} : { agentId: 'agent-1' });
  if (path.endsWith('/CancelRun') || path.endsWith('/CloseAgent')) return json({});
  if (path.endsWith('/Send')) {
    if (scenario === 'HANG') await new Promise(() => {});
    const headers = { 'content-type': 'application/connect+json' };
    const run = (result) => ({ result: { status: FINISHED, runId: 'run-1', result: { status: FINISHED, result, model: { id: 'kimi-k3', params: [{ id: 'reasoning', value: 'high' }] }, usage: { inputTokens: 3, outputTokens: 2 } } } });
    if (scenario === 'STREAM_ERROR') return new Response(Buffer.concat([frame(0, { sdkMessage: { message: { runId: 'run-1' } } }), frame(2, { error: { code: 'internal' } })]), { headers });
    if (scenario === 'TRUNCATED') return new Response(frame(0, run('{}')).subarray(0, 12), { headers });
    if (scenario === 'NATIVE') return new Response(Buffer.concat([frame(0, { sdkMessage: { message: { content: [{ type: 'tool_use', name: 'shell' }] } } }), frame(0, run('{}')), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers });
    if (scenario === 'UNFINISHED') return new Response(Buffer.concat([frame(0, { result: { status: 'RUN_LIFECYCLE_STATUS_ERROR', runId: 'run-1', result: { status: 'RUN_LIFECYCLE_STATUS_ERROR' } } }), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers });
    if (scenario === 'WRONG_MODEL') { const body = run(JSON.stringify({ text: 'x', tool_calls: [] })); body.result.result.model.params = [{ id: 'reasoning', value: 'low' }]; return new Response(Buffer.concat([frame(0, body), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers }); }
    if (scenario === 'BAD_OUTPUT') return new Response(Buffer.concat([frame(0, run('this is not the JSON object')), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers });
    if (scenario === 'BAD_JSON') return new Response(Buffer.concat([frame(0, run('{"text": "oops", tool_calls: [')), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers });
    if (scenario === 'PROSE_THEN_JSON') { globalThis.__sends = (globalThis.__sends || 0) + 1; return new Response(Buffer.concat([frame(0, run(globalThis.__sends === 1 ? 'I will read the file next.' : JSON.stringify({ text: 'wrapped after correction', tool_calls: [] }))), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers }); }
    return new Response(Buffer.concat([frame(0, run(JSON.stringify({ text: 'CURSOR_OK', tool_calls: [] }))), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers });
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
  process.env.CURSOR_TIMEOUT_MS = '600';
});
afterAll(async () => {
  if (backend) { const at = BACKENDS.indexOf(backend); if (at >= 0) (BACKENDS as SubscriptionBackend[]).splice(at, 1); }
  if (savedTimeout === undefined) delete process.env.CURSOR_TIMEOUT_MS; else process.env.CURSOR_TIMEOUT_MS = savedTimeout;
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
const expectRetryable = (seen: Seen[], message: string) => {
  for (const cell of seen) { expect(cell.code, cell.transport).toBe('server_error'); expect(cell.message, cell.transport).toBe(message); if (cell.transport === 'http') expect(cell.status).toBeGreaterThanOrEqual(500); }
};
const expectOk = (seen: Seen[], text: string) => { for (const cell of seen) { expect(cell.code, cell.transport).toBe('ok'); expect(cell.message, cell.transport).toBe(text); } };
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const bridgePid = async () => Number(await readFile(scratch + '/bridge.pid', 'utf8'));

describe('Cursor bridge failures through the router', () => {
  test('the scripted bridge serves a normal turn on every transport and is killed afterwards', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('OK');
      expectOk(await everyTransport(app, body('hello')), 'CURSOR_OK');
      await sleep(50);
      expect(pidAlive(await bridgePid())).toBe(false);
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
      for (const [name, status, code] of [['SDK_401', 401, 'unauthenticated'], ['SDK_429', 429, 'resource_exhausted'], ['SDK_503', 503, 'unavailable']] as const) {
        await scenario(name);
        const seen = await everyTransport(app, body('x'));
        expectTerminal(seen, `HTTP ${status}, ${code}`);
        for (const cell of seen) expect(cell.message).not.toContain('key-');
      }
    } finally { await app.close(); }
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

  test('stream errors, truncation, native tool use, unfinished runs and model drift are refused', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('STREAM_ERROR'); expectTerminal(await everyTransport(app, body('x')), 'stream failed');
      await scenario('TRUNCATED'); expectTerminal(await everyTransport(app, body('x')), 'partial frame');
      await scenario('NATIVE'); expectTerminal(await everyTransport(app, body('x')), 'native tool');
      await scenario('UNFINISHED'); expectTerminal(await everyTransport(app, body('x')), 'did not finish successfully');
      await scenario('WRONG_MODEL'); expectTerminal(await everyTransport(app, body('x')), 'different model or reasoning setting');
    } finally { await app.close(); }
  });

  test('malformed JSON output is retried once and then delivered as a refusal chat message, not a failed turn', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('BAD_JSON');
      for (const cell of await everyTransport(app, body('x'))) {
        expect(cell.code, cell.transport).toBe('ok');
        expect(cell.message, cell.transport).toContain('Cursor could not produce a valid action');
        expect(cell.message, cell.transport).toContain('no Codex actions were executed');
        if (cell.transport === 'http') expect(cell.status).toBe(200);
      }
    } finally { await app.close(); }
  });

  test('narration is corrected inside the same agent, so one attempt yields the wrapped reply', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('PROSE_THEN_JSON');
      for (const cell of await everyTransport(app, body('x'))) {
        expect(cell.code, cell.transport).toBe('ok');
        expect(cell.message, cell.transport).toBe('wrapped after correction');
      }
    } finally { await app.close(); }
  });

  test('bare prose (Grok narration) is retried once and then delivered verbatim as a text-only chat message', async () => {
    // (kept for the case where the agent keeps narrating after the in-agent correction)
    const app = await fixtureRouter();
    try {
      await scenario('BAD_OUTPUT');
      for (const cell of await everyTransport(app, body('x'))) {
        expect(cell.code, cell.transport).toBe('ok');
        expect(cell.message, cell.transport).toBe('this is not the JSON object');
        if (cell.transport === 'http') expect(cell.status).toBe(200);
      }
    } finally { await app.close(); }
  });

  test('a hung Send is cut at the Cursor timeout and the bridge is killed', async () => {
    const app = await fixtureRouter();
    try {
      await scenario('HANG');
      const seen = await everyTransport(app, body('x'));
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
