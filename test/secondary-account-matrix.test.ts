// Secondary Claude account and the Opus quota fallback into Cursor, end to end: a scripted Anthropic
// (identity check, Messages stream, quota headers) and a scripted Cursor bridge (real local Connect
// handshake) composed exactly as the registry composes them for the live `poly-` rows, driven through
// the router on HTTP, SSE and WebSocket.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createClaudeAccountBackend, type ClaudeAccount } from '../src/backends/claude';
import { claudeUsageSnapshot } from '../src/backends/claude-limits';
import type { SubscriptionBackend } from '../src/backends/contract';
import { configuredCursorBackend } from '../src/backends/cursor';
import { withOpusQuotaFallback } from '../src/backends/quota-fallback';
import { BACKENDS } from '../src/backends/registry';
import { anthropicFixture, limitHeaders, say } from './anthropic-fixture';
import { AUTH_HEADERS, fixtureRouter } from './support';

const EMAIL = 'work@example.com';
const USER = 'user_work';
const anthropic = anthropicFixture({ email: EMAIL, org: 'org_work' });
const defaultProfile = anthropic.state.profile;
let scratch = '';
let credentials = '';
let claude: ClaudeAccount;
const rows: SubscriptionBackend[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ['CLAUDE_TIMEOUT_MS', 'CURSOR_TIMEOUT_MS', 'OFFLINE_RETRY_BASE_MS'];

type Turn = 'ok' | 'limit' | 'limit-bare' | 'error';
const TURNS: Record<Turn, () => Response> = {
  ok: () => say('CLAUDE_OK'),
  limit: () => new Response('{}', { status: 429, headers: limitHeaders(Math.floor(Date.now() / 1000) + 3600) }),
  'limit-bare': () => new Response('{}', { status: 429 }),
  error: () => new Response(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'model backend exploded' } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
};
const setTurn = (mode: Turn) => { anthropic.state.reply = TURNS[mode]; };
const setBridge = (mode: 'ok' | 'quota') => writeFile(scratch + '/bridge.mode', mode);
/** A new access token in the login store, so the identity pin is checked again on the next turn. */
let tokens = 0;
const newToken = () => writeFile(credentials, JSON.stringify({ claudeAiOauth: { accessToken: `access-new-${++tokens}`, refreshToken: 'refresh-0', expiresAt: Date.now() + 3_600_000 } }));
const turns = () => anthropic.messages().length;
const profiles = () => anthropic.state.seen.filter(entry => entry.path === '/api/oauth/profile').length;
const count = async (name: string) => Number(await readFile(scratch + '/' + name + '.count', 'utf8').catch(() => '0'));
/** Requests the scripted Cursor bridge served, one line each; bridges are pooled, so a launch count says nothing about generation. */
const hits = async (name: 'agent' | 'send') => (await readFile(scratch + '/' + name + '.log', 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

beforeAll(async () => {
  scratch = await mkdtemp(tmpdir() + '/secondary-matrix-');
  for (const key of ENV) saved[key] = process.env[key];
  const bridge = scratch + '/bridge';
  await Bun.write(bridge, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
// The router pools bridges, so behaviour is read per request and work is logged per request, not per launch.
const mode = async () => (await Bun.file('${scratch}/bridge.mode').text().catch(() => 'ok')).trim();
await Bun.write('${scratch}/bridge.count', String(Number(await Bun.file('${scratch}/bridge.count').text().catch(() => '0')) + 1));
const FINISHED = 'RUN_LIFECYCLE_STATUS_FINISHED';
const frame = (flags, value) => { const json = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(5); head[0] = flags; head.writeUInt32BE(json.length, 1); return Buffer.concat([head, json]); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const catalog = { items: [{ id: 'claude-opus-5-5', parameters: [{ id: 'effort', values: [{ value: 'medium' }, { value: 'high' }] }, { id: 'context', values: [{ value: '300k' }, { value: '1m' }] }, { id: 'fast', values: [{ value: 'false' }] }] }] };
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/Me')) return json({ user: { userEmail: '${EMAIL}', userId: '${USER}' } });
  if (path.endsWith('/ListModels')) return json(catalog);
  if (path.endsWith('/SetToolCallback')) return json({});
  if (path.endsWith('/CreateAgent')) { appendFileSync('${scratch}/agent.log', 'a\\n'); return await mode() === 'quota' ? json({ code: 'resource_exhausted' }, 429) : json({ agentId: 'agent-1' }); }
  if (path.endsWith('/CancelRun') || path.endsWith('/CloseAgent')) return json({});
  if (path.endsWith('/Send')) {
    appendFileSync('${scratch}/send.log', 's\\n');
    const run = { result: { status: FINISHED, runId: 'run-1', result: { status: FINISHED, result: 'CURSOR_OPUS_OK', model: { id: 'claude-opus-5-5', params: [{ id: 'effort', value: 'high' }, { id: 'context', value: '1m' }, { id: 'fast', value: 'false' }] }, usage: { inputTokens: 3, outputTokens: 2 } } } };
    const said = { sdkMessage: { type: 'assistant', message: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CURSOR_OPUS_OK' }] } } } };
    return new Response(Buffer.concat([frame(0, said), frame(0, run), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers: { 'content-type': 'application/connect+json' } });
  }
  return json({ code: 'unimplemented' }, 404);
} });
await Bun.write('${scratch}/bridge-token', 'token');
console.error('cursor-sdk-bridge ready ' + JSON.stringify({ schemaVersion: 1, host: '127.0.0.1', protocol: 'connect', transport: 'tcp', port: server.port, authTokenFile: '${scratch}/bridge-token', url: 'http://127.0.0.1:' + server.port }));
await new Promise(() => {});
`);
  await chmod(bridge, 0o700);
  await writeFile(scratch + '/auth.json', JSON.stringify({ apiKey: 'key-work', email: EMAIL, backendUrl: 'https://api2.cursor.sh' }), { mode: 0o600 });
  await setBridge('ok');
  process.env.CLAUDE_TIMEOUT_MS = '2000';
  process.env.CURSOR_TIMEOUT_MS = '2000';
  process.env.OFFLINE_RETRY_BASE_MS = '10';
  credentials = anthropic.credentials();
  const hash = createHash('sha256').update(await readFile(bridge)).digest('hex');
  // Composed the way src/backends/registry.ts composes the live `poly-` rows.
  const account = createClaudeAccountBackend({ ...anthropic.options(credentials), configDir: scratch + '/claude-config', prefix: 'wk', label: 'Work', models: ['claude-opus-5-5', 'claude-fable-5-1'], expectedEmail: EMAIL, expectedOrg: 'org_work' });
  const cursor = configuredCursorBackend({ CURSOR_BRIDGE_BIN: bridge, CURSOR_BRIDGE_SHA256: hash, CURSOR_AUTH_FILE: scratch + '/auth.json', CURSOR_CWD: scratch, CURSOR_EXPECTED_EMAIL: EMAIL, CURSOR_EXPECTED_USER_ID: USER, CURSOR_MODEL_PREFIX: 'wk-cursor', CURSOR_LABEL: 'Work' });
  if (!cursor) throw new Error('fixture rows not configured');
  claude = account.account;
  rows.push(withOpusQuotaFallback(account.backend, cursor), cursor);
  (BACKENDS as SubscriptionBackend[]).push(...rows);
});
afterEach(async () => {
  setTurn('ok'); await setBridge('ok');
  anthropic.state.profile = defaultProfile; anthropic.state.replies.length = 0;
  claude.limits.restore(claudeUsageSnapshot({}));
});
afterAll(async () => {
  for (const row of rows) { const at = BACKENDS.indexOf(row); if (at >= 0) (BACKENDS as SubscriptionBackend[]).splice(at, 1); }
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  anthropic.stop();
  await rm(scratch, { recursive: true, force: true });
});

type App = Awaited<ReturnType<typeof fixtureRouter>>;
const OPUS = 'wk-claude-opus-5-5';
const FABLE = 'wk-claude-fable-5-1';
const body = (model: string, text: string) => ({ model, input: [{ role: 'user', content: text }], reasoning: { effort: 'high' } });
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
const expectTerminal = (seen: Seen[], code: string, fragment: string) => {
  for (const cell of seen) {
    expect(cell.code, cell.transport).toBe(cell.transport === 'http' ? code : 'invalid_prompt');
    expect(cell.message, cell.transport).toContain(fragment);
    if (cell.transport === 'http') expect(cell.status).toBe(400);
  }
};
const expectText = (seen: Seen[], fragment: string) => { for (const cell of seen) { expect(cell.code, cell.transport).toBe('ok'); expect(cell.message, cell.transport).toContain(fragment); } };

describe('secondary Claude account identity check', () => {
  test('a matching identity serves both models and the check runs once per token', async () => {
    const app = await fixtureRouter();
    try {
      await newToken();
      const before = profiles();
      expectText(await everyTransport(app, body(OPUS, 'hello')), 'CLAUDE_OK');
      expectText(await everyTransport(app, body(FABLE, 'hello')), 'CLAUDE_OK');
      expect(profiles()).toBe(before + 1);
    } finally { await app.close(); }
  });

  test('wrong email, wrong org, unreadable profile and a signed-out login all refuse before any turn, then recover', async () => {
    const app = await fixtureRouter();
    try {
      const turnsBefore = turns();
      const cases: Array<[() => Response, string]> = [
        [() => Response.json({ account: { email: 'other@example.com' }, organization: { uuid: 'org_work' } }), 'identity does not match'],
        [() => Response.json({ account: { email: EMAIL }, organization: { uuid: 'org_other' } }), 'identity does not match'],
        [() => new Response('not json'), 'identity does not match'],
        [() => new Response('{}', { status: 401 }), 'not logged in'],
      ];
      for (const [profile, expected] of cases) {
        anthropic.state.profile = profile;
        for (const model of [OPUS, FABLE]) {
          await newToken();
          const seen = await everyTransport(app, body(model, 'x'));
          expectTerminal(seen, 'invalid_request_error', expected);
          for (const cell of seen) expect(cell.message).not.toContain('other@example.com');
        }
      }
      expect(turns()).toBe(turnsBefore);
      expect(await count('bridge')).toBe(0);
      anthropic.state.profile = defaultProfile;
      expectText(await everyTransport(app, body(OPUS, 'recovered')), 'CLAUDE_OK');
    } finally { await app.close(); }
  });
});

describe('network drops through the router', () => {
  test('a stream cut before any text is replayed inside the same SSE or WebSocket request; plain JSON and a cut after text fail without a replay', async () => {
    const app = await fixtureRouter();
    try {
      const opened = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: {} } })}\n\n`;
      const cut = (text = '') => () => new Response(opened + text, { headers: { 'content-type': 'text/event-stream' } });
      const before = turns();
      anthropic.state.replies.push(cut(), () => say('RECOVERED'));
      expect(terminal(await (await post(app, { ...body(OPUS, 'drop'), stream: true })).text())?.response?.output?.[0]?.content?.[0]?.text).toBe('RECOVERED');
      anthropic.state.replies.push(cut(), () => say('RECOVERED'));
      expect((await socketTurn(app, body(OPUS, 'drop'))).response?.output?.[0]?.content?.[0]?.text).toBe('RECOVERED');
      expect(turns()).toBe(before + 4);
      // Plain JSON has no channel for progress frames: the drop is a retryable server error, as native.
      anthropic.state.replies.push(cut());
      const plain = await post(app, body(OPUS, 'drop'));
      expect(plain.status).toBeGreaterThanOrEqual(500);
      expect(turns()).toBe(before + 5);

      anthropic.state.replies.push(cut(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'HALF' } })}\n\n`));
      const stream = await post(app, { ...body(OPUS, 'drop after text'), stream: true });
      const events = sse(await stream.text());
      expect(events.some(event => event.type === 'response.output_text.delta' && event.delta === 'HALF')).toBe(true);
      expect(events.find(event => ['response.failed', 'response.completed'].includes(event.type))?.type).toBe('response.failed');
      expect(turns()).toBe(before + 6);
    } finally { await app.close(); }
  });
});

describe('Opus quota fallback into Cursor, end to end', () => {
  test('an Opus usage-limit refusal, with or without quota headers, falls back to Cursor Opus with the notice prepended', async () => {
    const app = await fixtureRouter();
    try {
      for (const mode of ['limit', 'limit-bare'] as const) {
        setTurn(mode);
        const before = await hits('send');
        const seen = await everyTransport(app, body(OPUS, 'needs fallback'));
        expectText(seen, 'CURSOR_OPUS_OK');
        for (const cell of seen) expect(cell.message, cell.transport).toContain('using Cursor Opus 5.5 because the direct Claude subscription reached its usage limit');
        expect(await hits('send')).toBe(before + 3);
        claude.limits.restore(claudeUsageSnapshot({}));
      }
    } finally { await app.close(); }
  });

  test('Fable at its limit never falls back; the refusal names the limit', async () => {
    const app = await fixtureRouter();
    try {
      setTurn('limit');
      const before = await hits('agent');
      expectTerminal(await everyTransport(app, body(FABLE, 'x')), 'claude_usage_limit_reached', 'limit');
      expect(await hits('agent')).toBe(before);
    } finally { await app.close(); }
  });

  test('a non-quota Opus failure never falls back', async () => {
    const app = await fixtureRouter();
    try {
      setTurn('error');
      const before = await hits('agent');
      expectTerminal(await everyTransport(app, body(OPUS, 'x')), 'invalid_request_error', 'model backend exploded');
      expect(await hits('agent')).toBe(before);
    } finally { await app.close(); }
  });

  test('when Cursor is also exhausted the fallback refusal is surfaced with no third supplier', async () => {
    const app = await fixtureRouter();
    try {
      setTurn('limit'); await setBridge('quota');
      const [agents, sends] = [await hits('agent'), await hits('send')];
      expectTerminal(await everyTransport(app, body(OPUS, 'x')), 'invalid_request_error', 'HTTP 429, resource_exhausted');
      // Cursor was asked once per transport and refused; nothing was generated there.
      expect(await hits('agent')).toBe(agents + 3);
      expect(await hits('send')).toBe(sends);
    } finally { await app.close(); }
  });

  test('once the Opus limit is recorded, the quota gate skips Claude and goes straight to Cursor; Fable stays gated', async () => {
    const app = await fixtureRouter();
    try {
      setTurn('limit');
      await post(app, body(OPUS, 'record the limit'));
      setTurn('ok');
      const before = turns();
      expectText(await everyTransport(app, body(OPUS, 'gated')), 'CURSOR_OPUS_OK');
      expectTerminal(await everyTransport(app, body(FABLE, 'gated')), 'claude_usage_limit_reached', 'limit');
      expect(turns()).toBe(before);
    } finally { await app.close(); }
  });

  test('a client cancel during the Claude turn never starts the Cursor bridge', async () => {
    const app = await fixtureRouter();
    try {
      setTurn('limit');
      const before = await hits('agent');
      const seen = await post(app, body(OPUS, 'x'), { signal: AbortSignal.abort() }).catch(error => error);
      expect(seen).toBeInstanceOf(Error);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(await hits('agent')).toBe(before);
    } finally { await app.close(); }
  });
});

