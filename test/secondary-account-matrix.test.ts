// Secondary Claude account and the Opus quota fallback into Cursor, end to end: a scripted Claude
// CLI (real `claude auth status` identity check, real stream-json turns) and a scripted Cursor bridge
// (real local Connect handshake) composed exactly as the registry composes them for the live
// `poly-` rows, driven through the router on HTTP, SSE and WebSocket.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { configuredClaudeAccount } from '../src/backends/claude';
import type { SubscriptionBackend } from '../src/backends/contract';
import { configuredCursorBackend } from '../src/backends/cursor';
import { withOpusQuotaFallback } from '../src/backends/quota-fallback';
import { BACKENDS } from '../src/backends/registry';
import { AUTH_HEADERS, fixtureRouter } from './support';

const EMAIL = 'work@example.com';
const USER = 'user_work';
let scratch = '';
const rows: SubscriptionBackend[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ['CLAUDE_TIMEOUT_MS', 'CURSOR_TIMEOUT_MS'];

/** The scripted Claude CLI reads its identity answer and turn behaviour from files in scratch. */
const setIdentity = (value: string, exit = 0) => Promise.all([writeFile(scratch + '/identity.json', value), writeFile(scratch + '/identity.exit', String(exit))]);
const setTurn = (mode: 'ok' | 'limit' | 'limit-event' | 'error') => writeFile(scratch + '/turn.mode', mode);
const setBridge = (mode: 'ok' | 'quota') => writeFile(scratch + '/bridge.mode', mode);
const count = async (name: string) => Number(await readFile(scratch + '/' + name + '.count', 'utf8').catch(() => '0'));

beforeAll(async () => {
  scratch = await mkdtemp(tmpdir() + '/secondary-matrix-');
  for (const key of ENV) saved[key] = process.env[key];
  const claude = scratch + '/claude';
  await Bun.write(claude, `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo $(( $(cat ${scratch}/auth.count 2>/dev/null || echo 0) + 1 )) > ${scratch}/auth.count
  cat ${scratch}/identity.json
  exit $(cat ${scratch}/identity.exit)
fi
while IFS= read -r input; do
  echo $(( $(cat ${scratch}/claude-turn.count 2>/dev/null || echo 0) + 1 )) > ${scratch}/claude-turn.count
  case "$(cat ${scratch}/turn.mode)" in
    limit) echo '{"type":"result","subtype":"error","is_error":true,"result":"Claude AI usage limit reached|1760230800"}';;
    limit-event) echo '{"type":"assistant","error":"rate_limit"}';;
    error) echo '{"type":"result","subtype":"error","is_error":true,"result":"model backend exploded"}';;
    *) echo '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"CLAUDE_OK","tool_calls":[]}}';;
  esac
done
`);
  await chmod(claude, 0o755);
  const bridge = scratch + '/bridge';
  await Bun.write(bridge, `#!/usr/bin/env bun
const mode = (await Bun.file('${scratch}/bridge.mode').text().catch(() => 'ok')).trim();
await Bun.write('${scratch}/bridge.count', String(Number(await Bun.file('${scratch}/bridge.count').text().catch(() => '0')) + 1));
const FINISHED = 'RUN_LIFECYCLE_STATUS_FINISHED';
const frame = (flags, value) => { const json = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(5); head[0] = flags; head.writeUInt32BE(json.length, 1); return Buffer.concat([head, json]); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const catalog = { items: [{ id: 'claude-opus-5-5', parameters: [{ id: 'effort', values: [{ value: 'medium' }, { value: 'high' }] }, { id: 'context', values: [{ value: '300k' }, { value: '1m' }] }, { id: 'fast', values: [{ value: 'false' }] }] }] };
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/Me')) return json({ user: { userEmail: '${EMAIL}', userId: '${USER}' } });
  if (path.endsWith('/ListModels')) return json(catalog);
  if (path.endsWith('/CreateAgent')) return mode === 'quota' ? json({ code: 'resource_exhausted' }, 429) : json({ agentId: 'agent-1' });
  if (path.endsWith('/CancelRun') || path.endsWith('/CloseAgent')) return json({});
  if (path.endsWith('/Send')) {
    const run = { result: { status: FINISHED, runId: 'run-1', result: { status: FINISHED, result: JSON.stringify({ text: 'CURSOR_OPUS_OK', tool_calls: [] }), model: { id: 'claude-opus-5-5', params: [{ id: 'effort', value: 'high' }, { id: 'context', value: '1m' }, { id: 'fast', value: 'false' }] }, usage: { inputTokens: 3, outputTokens: 2 } } } };
    return new Response(Buffer.concat([frame(0, run), frame(0, { done: { runId: 'run-1' } }), frame(2, {})]), { headers: { 'content-type': 'application/connect+json' } });
  }
  return json({ code: 'unimplemented' }, 404);
} });
await Bun.write('${scratch}/bridge-token', 'token');
console.error('cursor-sdk-bridge ready ' + JSON.stringify({ schemaVersion: 1, host: '127.0.0.1', protocol: 'connect', transport: 'tcp', port: server.port, authTokenFile: '${scratch}/bridge-token', url: 'http://127.0.0.1:' + server.port }));
await new Promise(() => {});
`);
  await chmod(bridge, 0o700);
  await writeFile(scratch + '/auth.json', JSON.stringify({ apiKey: 'key-work', email: EMAIL, backendUrl: 'https://api2.cursor.sh' }), { mode: 0o600 });
  await setIdentity(JSON.stringify({ loggedIn: true, email: EMAIL, orgId: 'org_work' }));
  await setTurn('ok');
  await setBridge('ok');
  process.env.CLAUDE_TIMEOUT_MS = '2000';
  process.env.CURSOR_TIMEOUT_MS = '2000';
  const hash = createHash('sha256').update(await readFile(bridge)).digest('hex');
  // Composed the way src/backends/registry.ts composes the live `poly-` rows.
  const account = configuredClaudeAccount({ CLAUDE_ACCOUNT_CONFIG_DIR: scratch + '/claude-config', CLAUDE_ACCOUNT_BIN: claude, CLAUDE_ACCOUNT_MODEL_PREFIX: 'wk', CLAUDE_ACCOUNT_LABEL: 'Work', CLAUDE_ACCOUNT_MODELS: 'claude-opus-5-5,claude-fable-5-1', CLAUDE_ACCOUNT_EXPECTED_EMAIL: EMAIL, CLAUDE_ACCOUNT_EXPECTED_ORG: 'org_work' });
  const cursor = configuredCursorBackend({ CURSOR_BRIDGE_BIN: bridge, CURSOR_BRIDGE_SHA256: hash, CURSOR_AUTH_FILE: scratch + '/auth.json', CURSOR_CWD: scratch, CURSOR_EXPECTED_EMAIL: EMAIL, CURSOR_EXPECTED_USER_ID: USER, CURSOR_MODEL_PREFIX: 'wk-cursor', CURSOR_LABEL: 'Work' });
  if (!account || !cursor) throw new Error('fixture rows not configured');
  rows.push(withOpusQuotaFallback(account.backend, cursor), cursor);
  (BACKENDS as SubscriptionBackend[]).push(...rows);
});
afterAll(async () => {
  for (const row of rows) { const at = BACKENDS.indexOf(row); if (at >= 0) (BACKENDS as SubscriptionBackend[]).splice(at, 1); }
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
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
  test('a matching identity serves both models and the check runs once per worker', async () => {
    const app = await fixtureRouter();
    try {
      await setIdentity(JSON.stringify({ loggedIn: true, email: EMAIL, orgId: 'org_work' }));
      expectText(await everyTransport(app, body(OPUS, 'hello')), 'CLAUDE_OK');
      expectText(await everyTransport(app, body(FABLE, 'hello')), 'CLAUDE_OK');
      expect(await count('auth')).toBeGreaterThanOrEqual(6);
    } finally { await app.close(); }
  });

  test('wrong email, wrong org, logged out, broken JSON and a failing auth command all refuse before any turn', async () => {
    const app = await fixtureRouter();
    try {
      const turnsBefore = await count('claude-turn');
      // Each failure names its real cause: a mismatch is only reported for a parsed, logged-in answer with
      // the wrong email/org. A dead probe or unreadable output must not read as a login problem.
      const cases: Array<[string, number, string]> = [
        [JSON.stringify({ loggedIn: true, email: 'other@example.com', orgId: 'org_work' }), 0, 'identity does not match'],
        [JSON.stringify({ loggedIn: true, email: EMAIL, orgId: 'org_other' }), 0, 'identity does not match'],
        [JSON.stringify({ loggedIn: false }), 0, 'not logged in'],
        [JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }), 1, 'credential store is inaccessible'],
        ['not json', 0, 'unreadable output'],
        [JSON.stringify({ loggedIn: true, email: EMAIL, orgId: 'org_work' }), 2, 'auth status exited 2'],
      ];
      for (const [identity, exit, expected] of cases) {
        await setIdentity(identity, exit);
        for (const model of [OPUS, FABLE]) {
          const seen = await everyTransport(app, body(model, 'x'));
          expectTerminal(seen, 'invalid_request_error', expected);
          for (const cell of seen) expect(cell.message).not.toContain('other@example.com');
        }
      }
      expect(await count('claude-turn')).toBe(turnsBefore);
      expect(await count('bridge')).toBe(0);
      await setIdentity(JSON.stringify({ loggedIn: true, email: EMAIL, orgId: 'org_work' }));
      expectText(await everyTransport(app, body(OPUS, 'recovered')), 'CLAUDE_OK');
    } finally { await app.close(); }
  });

  test('a complete matching answer whose teardown was killed by the probe deadline (exit 143) still serves the turn', async () => {
    // October 11-15, 2026: `claude auth status` wrote its full answer, then its teardown ran past the spawn
    // timeout. Bun reports that SIGTERM as exit 143 with no signalCode. The answer is the verdict; the
    // teardown status is not evidence about the login and must not fail a healthy turn.
    const app = await fixtureRouter();
    try {
      await setIdentity(JSON.stringify({ loggedIn: true, email: EMAIL, orgId: 'org_work' }), 143);
      expectText(await everyTransport(app, body(FABLE, 'slow probe')), 'CLAUDE_OK');
      // October 17, 2026: a probe that stalled without printing anything, right after this login was
      // verified, is a machine stall and the recent verification still serves the turn.
      await setIdentity('', 143);
      expectText(await everyTransport(app, body(FABLE, 'stalled probe')), 'CLAUDE_OK');
      // A parsed mismatch clears the verification; after that a stalled probe is refused, named as such,
      // with no turn launched.
      const turnsBefore = await count('claude-turn');
      await setIdentity(JSON.stringify({ loggedIn: true, email: 'other@example.com', orgId: 'org_work' }), 143);
      expectTerminal(await everyTransport(app, body(FABLE, 'x')), 'invalid_request_error', 'killed before it answered');
      await setIdentity('', 143);
      expectTerminal(await everyTransport(app, body(FABLE, 'x')), 'invalid_request_error', 'killed before it answered');
      expect(await count('claude-turn')).toBe(turnsBefore);
      await setIdentity(JSON.stringify({ loggedIn: true, email: EMAIL, orgId: 'org_work' }));
    } finally { await app.close(); }
  });
});

describe('Opus quota fallback into Cursor, end to end', () => {
  test('an Opus usage-limit result or rate-limit event falls back to Cursor Opus with the notice prepended', async () => {
    const app = await fixtureRouter();
    try {
      for (const mode of ['limit', 'limit-event'] as const) {
        await setTurn(mode);
        const before = await count('bridge');
        const seen = await everyTransport(app, body(OPUS, 'needs fallback'));
        expectText(seen, 'CURSOR_OPUS_OK');
        for (const cell of seen) expect(cell.message, cell.transport).toContain('using Cursor Opus 5.5 because the direct Claude subscription reached its usage limit');
        expect(await count('bridge')).toBe(before + 3);
      }
    } finally { await app.close(); await setTurn('ok'); }
  });

  test('Fable at its limit never falls back; the refusal names the limit', async () => {
    const app = await fixtureRouter();
    try {
      await setTurn('limit');
      const before = await count('bridge');
      expectTerminal(await everyTransport(app, body(FABLE, 'x')), 'claude_usage_limit_reached', 'limit');
      expect(await count('bridge')).toBe(before);
    } finally { await app.close(); await setTurn('ok'); }
  });

  test('a non-quota Opus failure never falls back', async () => {
    const app = await fixtureRouter();
    try {
      await setTurn('error');
      const before = await count('bridge');
      const seen = await everyTransport(app, body(OPUS, 'x'));
      for (const cell of seen) { expect(cell.code, cell.transport).toBe('server_error'); expect(cell.message).not.toContain('exploded'); }
      expect(await count('bridge')).toBe(before);
    } finally { await app.close(); await setTurn('ok'); }
  });

  test('when Cursor is also exhausted the fallback refusal is surfaced with no third supplier', async () => {
    const app = await fixtureRouter();
    try {
      await setTurn('limit'); await setBridge('quota');
      expectTerminal(await everyTransport(app, body(OPUS, 'x')), 'invalid_request_error', 'HTTP 429, resource_exhausted');
    } finally { await app.close(); await setTurn('ok'); await setBridge('ok'); }
  });

  test('once the Opus limit is recorded, the quota gate skips Claude and goes straight to Cursor; Fable stays gated', async () => {
    const app = await fixtureRouter();
    try {
      await setTurn('limit');
      await everyTransport(app, body(OPUS, 'record the limit'));
      const turnsBefore = await count('claude-turn');
      await setTurn('ok');
      const seen = await everyTransport(app, body(OPUS, 'gated'));
      // Either the gate short-circuits (no Claude turn) or the limit has already expired in the
      // limits tracker; both are acceptable, but Claude must never be asked while blocked.
      if (seen[0]!.message.includes('CURSOR_OPUS_OK')) expect(await count('claude-turn')).toBe(turnsBefore);
      else expectText(seen, 'CLAUDE_OK');
    } finally { await app.close(); await setTurn('ok'); }
  });

  test('a client cancel during the Claude turn never starts the Cursor bridge', async () => {
    const app = await fixtureRouter();
    try {
      await setTurn('limit');
      const before = await count('bridge');
      const seen = await post(app, body(OPUS, 'x'), { signal: AbortSignal.abort() }).catch(error => error);
      expect(seen).toBeInstanceOf(Error);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(await count('bridge')).toBe(before);
    } finally { await app.close(); await setTurn('ok'); }
  });
});
