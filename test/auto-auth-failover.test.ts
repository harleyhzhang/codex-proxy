import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAccountBackend } from '../src/backends/claude';
import { accountAuthRequired, BackendError, type SubscriptionBackend } from '../src/backends/contract';
import { BACKENDS } from '../src/backends/registry';
import type { JsonRecord } from '../src/json';
import { pendingResponse } from '../src/protocol/pending';
import { EMPTY_OUTPUT, type ResponsesBody } from '../src/protocol/types';
import { responseObject } from '../src/protocol/output';
import { AutoFailover } from '../src/router/auto-failover';
import { DEFAULT_POLICY, SmartRouter } from '../src/router/smart-route';
import { UsagePoller } from '../src/router/usage-poller';
import { anthropicFixture, anthropicStream, say } from './anthropic-fixture';
import { AUTH_HEADERS, fixtureRouter } from './support';

const AUTO = 'auto-claude-opus-5-5';
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'auto-auth-'));
  const providers = [anthropicFixture(), anthropicFixture()];
  const rows = providers.map((provider, i) => createClaudeAccountBackend({ ...provider.options(), configDir: join(dir, `profile-${i}`), prefix: `auth${i}`, label: `Fixture ${i}`, expectedEmail: 'work@example.com', expectedOrg: 'org_work', models: ['claude-opus-5-5'] }));
  (BACKENDS as SubscriptionBackend[]).push(...rows.map(row => row.backend));
  const candidates = rows.map((row, i) => ({ slug: Object.keys(row.backend.models)[0]!, usage: `fixture-${i}`, tier: 'work' as const }));
  const poller = new UsagePoller({}, dir);
  const router = new SmartRouter({ policy: DEFAULT_POLICY, routes: { [AUTO]: candidates } }, () => poller.snapshots());
  const routing = { router, authFailed: (id: string) => poller.markAuthFailure(id) };
  const app = await fixtureRouter({ autoRouting: routing });
  return { app, providers, rows, candidates, poller, routing, async close() {
    await app.close();
    for (const row of rows) (BACKENDS as SubscriptionBackend[]).splice(BACKENDS.indexOf(row.backend), 1);
    for (const provider of providers) provider.stop();
    await rm(dir, { recursive: true, force: true });
  } };
}
const post = (app: Awaited<ReturnType<typeof fixtureRouter>>, body: unknown) => fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(body) });
function events(text: string): JsonRecord[] {
  return text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)) as JsonRecord);
}
async function socketTurn(app: Awaited<ReturnType<typeof fixtureRouter>>, body: ResponsesBody): Promise<JsonRecord[]> {
  const Socket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
  const ws = new Socket(app.url('/v1/responses').replace('http:', 'ws:'), { headers: AUTH_HEADERS });
  const seen: JsonRecord[] = [];
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket timeout')), 3000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'response.create', ...body }));
      ws.onerror = () => { clearTimeout(timer); reject(new Error('socket failed')); };
      ws.onmessage = event => {
        const parsed = JSON.parse(String(event.data)) as JsonRecord; seen.push(parsed);
        if (['response.completed', 'response.failed', 'error'].includes(String(parsed.type))) { clearTimeout(timer); resolve(seen); }
      };
    });
  } finally { ws.close(); }
}

for (const transport of ['http', 'sse', 'ws'] as const) test(`${transport}: a warm account's revoked login fails over with full tool history, then stays on the healthy login`, async () => {
  const f = await setup();
  try {
    f.providers[0]!.state.reply = () => anthropicStream([{ type: 'tool_use', id: 'read-1', name: 'read', input: {} }], 'tool_use');
    const tools = [{ type: 'function' as const, name: 'read', parameters: { type: 'object', properties: {} } }];
    const initial = await (await post(f.app, { model: AUTO, input: 'original question', tools, prompt_cache_key: 'warm' })).json() as JsonRecord;
    f.providers[0]!.state.reply = () => new Response('{}', { status: 401 });
    f.providers[0]!.state.refresh = () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    f.providers[1]!.state.reply = () => say('RECOVERED');
    const body: ResponsesBody = { model: AUTO, previous_response_id: String(initial.id), input: [{ type: 'function_call_output', call_id: 'read-1', output: 'file contents' }], tools, prompt_cache_key: 'warm' };
    let serialized: string;
    if (transport === 'ws') serialized = JSON.stringify(await socketTurn(f.app, body));
    else {
      const result = await post(f.app, { ...body, stream: transport === 'sse' });
      expect(result.status).toBe(200);
      const text = await result.text(); serialized = transport === 'sse' ? JSON.stringify(events(text)) : text;
    }
    expect(serialized).toContain('RECOVERED');
    expect(serialized).not.toContain('response.failed');
    const replay = JSON.stringify(f.providers[1]!.messages()[0]!.body);
    expect(replay).toContain('original question'); expect(replay).toContain('file contents'); expect(replay).toContain('read-1');
    const failedCalls = f.providers[0]!.messages().length;
    await post(f.app, { model: AUTO, input: 'next', prompt_cache_key: 'warm' }).then(response => response.text());
    expect(f.providers[0]!.messages()).toHaveLength(failedCalls);
    expect(f.providers[1]!.messages()).toHaveLength(2);
  } finally { await f.close(); }
});

test('explicit account choices do not fall back; all broken auto accounts are bounded and skipped on later requests', async () => {
  const f = await setup();
  try {
    for (const provider of f.providers) {
      provider.state.profile = () => new Response('{}', { status: 401 });
      provider.state.refresh = () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    expect((await post(f.app, { model: f.candidates[0]!.slug, input: 'explicit' })).status).toBe(400);
    expect(f.providers[1]!.state.seen).toHaveLength(0);
    expect((await post(f.app, { model: AUTO, input: 'auto' })).status).toBe(400);
    expect(f.providers.map(p => p.state.refreshes)).toEqual([2, 1]);
    const calls = f.providers.map(p => p.state.seen.length);
    const later = await post(f.app, { model: AUTO, input: 'later' });
    expect(await later.text()).toContain('No eligible account');
    expect(f.providers.map(p => p.state.seen.length)).toEqual(calls);
  } finally { await f.close(); }
});

test('an authentication refusal after streamed reasoning quarantines the account without replaying that turn', async () => {
  const f = await setup();
  try {
    f.providers[0]!.state.reply = () => new Response([
      { type: 'message_start', message: { usage: {} } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'already visible' } },
      { type: 'error', error: { type: 'authentication_error', message: 'revoked' } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    const result = events(await (await post(f.app, { model: AUTO, input: 'hello', stream: true })).text());
    expect(result.filter(event => event.type === 'response.reasoning_summary_text.delta')).toHaveLength(1);
    expect(result.at(-1)?.type).toBe('response.failed');
    expect(f.providers[0]!.messages()).toHaveLength(1); expect(f.providers[1]!.messages()).toHaveLength(0);
    await post(f.app, { model: AUTO, input: 'next' }).then(response => response.text());
    expect(f.providers[1]!.messages()).toHaveLength(1);
  } finally { await f.close(); }
});

test('reasoning or tools already exposed, cancellation and invalid prompts never replay on another account', async () => {
  const f = await setup();
  try {
    const failover = new AutoFailover(f.routing);
    const body: ResponsesBody = { model: f.candidates[0]!.slug, input: [] };
    failover.track(body, AUTO);
    const seen: JsonRecord[] = [];
    let attempts = 0;
    await expect(pendingResponse(body, (signal, sink) => failover.run(body, signal, async () => {
      attempts++; sink.reasoning?.('thinking'); throw accountAuthRequired('revoked');
    }, () => seen.some(event => event.type === 'response.reasoning_summary_text.delta')), new AbortController().signal, e => seen.push(e))).rejects.toThrow('revoked');
    expect(attempts).toBe(1); expect(seen.filter(e => e.type === 'response.reasoning_summary_text.delta')).toHaveLength(1);
    const next: ResponsesBody = { model: f.candidates[1]!.slug, input: [] }; failover.track(next, AUTO);
    await expect(failover.run(next, undefined, async () => { throw new BackendError('bad prompt'); })).rejects.toThrow('bad prompt');
    expect(f.poller.snapshots()['fixture-1']?.blocked).toBeUndefined();
    const controller = new AbortController(); controller.abort();
    await expect(failover.run(next, controller.signal, async () => responseObject(next, EMPTY_OUTPUT))).rejects.toThrow();
  } finally { await f.close(); }
});

test('usage polling quarantines failed auth across restarts, preserves it over newer usage, then recovers without restarting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-auth-'));
  let broken = true, finish: (() => void) | undefined;
  const source = { team: { kind: 'claude' as const, configDir: '/fixture', routerSnapshot: 'team.json' } };
  const readUsage = async () => {
    if (broken) throw accountAuthRequired('revoked');
    return { seven_day: { utilization: 10, resets_at: new Date(Date.now() + 86400000).toISOString() } };
  };
  try {
    const poller = new UsagePoller(source, dir, 1000, { readClaudeUsage: readUsage });
    await poller.poll(); expect(poller.snapshots().team?.blocked).toBe('authentication required');
    await Bun.write(join(dir, 'team.json'), JSON.stringify({ updated_at: Date.now() / 1000 + 10, seven_day: { used_percent: 1 } }));
    const restored = new UsagePoller(source, dir, 1000, { readClaudeUsage: readUsage });
    expect(restored.snapshots().team?.blocked).toBe('authentication required');
    broken = false; await restored.poll(); expect(restored.snapshots().team?.blocked).toBeUndefined();
    const raced = new UsagePoller(source, dir, 1000, { readClaudeUsage: async () => {
      await new Promise<void>(resolve => { finish = resolve; }); return readUsage();
    } });
    const flight = raced.poll(); raced.markAuthFailure('team'); finish!(); await flight;
    expect(raced.snapshots().team?.blocked).toBe('authentication required');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const transport of ['http', 'sse', 'ws'] as const) test(`${transport}: native GPT 401 skips the rejected account after its own refresh attempt`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-gpt-auth-'));
  const jwt = (value: unknown) => 'fixture.' + Buffer.from(JSON.stringify(value)).toString('base64url') + '.fixture';
  await Bun.write(join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt({ exp: Date.now() / 1000 + 3600 }), id_token: jwt({ email: 'team@example.com' }), account_id: 'team' } }));
  await Bun.write(join(dir, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] }));
  const poller = new UsagePoller({}, dir);
  const candidates = [{ slug: 'team-gpt-6.1-sol', usage: 'team', tier: 'work' as const }, { slug: 'gpt-6.1-sol', usage: 'personal', tier: 'personal' as const }];
  const model = 'auto-gpt-6.1-sol';
  const router = new SmartRouter({ policy: DEFAULT_POLICY, routes: { [model]: candidates } }, () => poller.snapshots());
  let refreshes = 0; const requests: string[] = [];
  const app = await fixtureRouter({
    autoRouting: { router, authFailed: id => poller.markAuthFailure(id) },
    secondaryAccount: { home: dir, prefix: 'team', binary: 'unused', refresh: async () => { refreshes++; throw accountAuthRequired('revoked'); } },
    upstreamFetch: async (_url, init) => {
      const account = new Headers(init.headers).get('chatgpt-account-id')!; requests.push(account);
      if (account === 'team') return new Response('{}', { status: 401 });
      const body = JSON.parse(String(init.body)) as ResponsesBody;
      const response = responseObject(body, { ...EMPTY_OUTPUT, text: 'GPT_RECOVERED' });
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  try {
    const result = transport === 'ws' ? JSON.stringify(await socketTurn(app, { model, input: 'hello' }))
      : await (await post(app, { model, input: 'hello', stream: transport === 'sse' })).text();
    expect(result).toContain('GPT_RECOVERED'); expect(refreshes).toBe(1); expect(requests).toEqual(['team', 'fixture-account']);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an auth notification receives only the account id, once per incident', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-notify-'));
  const file = join(dir, 'notifications');
  const recoveredFile = join(dir, 'recovered');
  const source = { team: { kind: 'claude' as const, configDir: '/fixture' } };
  try {
    const poller = new UsagePoller(source, dir, 1000, {
      readClaudeUsage: async () => ({ seven_day: { utilization: 1 } }),
      authFailureCommand: [process.execPath, '-e', 'require("node:fs").appendFileSync(Bun.argv[1], Bun.argv[2]+"\\n")', file],
      authRecoveryCommand: [process.execPath, '-e', 'require("node:fs").appendFileSync(Bun.argv[1], Bun.argv[2]+"\\n")', recoveredFile],
    });
    poller.markAuthFailure('team'); poller.markAuthFailure('team');
    for (let n = 0; n < 100 && !await Bun.file(file).exists(); n++) await Bun.sleep(5);
    expect(await Bun.file(file).text()).toBe('team\n');
    await poller.poll(); poller.markAuthFailure('team');
    for (let n = 0; n < 100 && (await Bun.file(file).text()).split('\n').length < 3; n++) await Bun.sleep(5);
    expect(await Bun.file(file).text()).toBe('team\nteam\n');
    for (let n = 0; n < 100 && !await Bun.file(recoveredFile).exists(); n++) await Bun.sleep(5);
    expect(await Bun.file(recoveredFile).text()).toBe('team\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
