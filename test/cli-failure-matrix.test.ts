// Real subprocess failure modes for the subscription CLIs, driven through the router on every
// transport. The Claude CLI and Grok Build binaries are replaced by scripted stand-ins that crash,
// hang, emit garbage, report quota or auth failures, or return malformed turns; every cell asserts
// the exact status, error code and message Codex receives, and that the router recovers afterwards.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AUTH_HEADERS, fixtureRouter } from './support';

const INTERNAL = 'Internal router error; Codex will retry.';
const TIMED_OUT = 'Model connection timed out. Retrying.';
let scratch = '';
const saved: Record<string, string | undefined> = {};
const ENV = ['CLAUDE_BIN', 'CLAUDE_TIMEOUT_MS', 'GROK_BIN', 'GROK_CWD', 'GROK_TIMEOUT_MS'];

beforeAll(async () => {
  scratch = await mkdtemp(tmpdir() + '/cli-failure-matrix-');
  for (const key of ENV) saved[key] = process.env[key];
  // Claude stand-in: a stream-json CLI keyed on tokens in the user message.
  const claude = scratch + '/claude';
  await Bun.write(claude, `#!/bin/sh
echo $$ > ${scratch}/claude.pid
while IFS= read -r input; do
  case "$input" in
    *CLI_CRASH*) echo 'claude: fatal internal panic' 1>&2; exit 3;;
    *CLI_GARBAGE*) echo 'not json at all'; echo '{"type":"unexpected"}'; sleep 30;;
    *CLI_HANG*) sleep 30;;
    *CLI_LIMIT*) echo '{"type":"result","subtype":"error","is_error":true,"result":"Claude AI usage limit reached|1760230800"}';;
    *CLI_RATE_EVENT*) echo '{"type":"assistant","error":"rate_limit"}';;
    *CLI_ERRORED*) echo '{"type":"result","subtype":"error","is_error":true,"result":"model backend exploded"}';;
    *CLI_OVERFLOW*) echo '{"type":"result","subtype":"error","is_error":true,"result":"Prompt is too long"}';;
    *CLI_OVERLOAD*) echo '{"type":"result","subtype":"error","is_error":true,"result":"API Error: 529 Overloaded"}';;
    *CLI_NETWORK*) echo '{"type":"result","subtype":"error","is_error":true,"result":"fetch failed: network error"}';;
    *CLI_BADSTRUCT*) echo '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"x"}}';;
    *CLI_BADTOOL*) echo '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"","tool_calls":[{"name":"no_such_tool","arguments":"{}"}]}}';;
    *) echo '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"CLI_OK","tool_calls":[]}}';;
  esac
done
`);
  await chmod(claude, 0o755);
  process.env.CLAUDE_BIN = claude;
  process.env.CLAUDE_TIMEOUT_MS = '400';
  // Grok stand-in: a one-shot CLI keyed on the prompt file, counting invocations per request.
  const grok = scratch + '/grok';
  await Bun.write(grok, `#!/usr/bin/env bun
const args = process.argv; const text = await Bun.file(args[args.indexOf('--prompt-file') + 1]).text();
const key = (text.match(/GROK_[A-Z]+/) ?? ['GROK_OK'])[0];
const counter = '${scratch}/grok-' + key + '.count';
await Bun.write(counter, String(Number(await Bun.file(counter).text().catch(() => '0')) + 1));
await Bun.write('${scratch}/grok.pid', String(process.pid));
if (key === 'GROK_CRASH') { console.error('grok: segmentation fault'); process.exit(7); }
if (key === 'GROK_AUTH') { console.error('error: unauthorized (401) - please run grok login'); process.exit(1); }
if (key === 'GROK_QUOTA') { console.log(JSON.stringify({type:'result',stopReason:'end_turn',is_error:true,num_turns:1,result:'rate limit exceeded: quota'})); process.exit(0); }
if (key === 'GROK_OVERFLOW') { console.log(JSON.stringify({type:'result',stopReason:'end_turn',is_error:true,num_turns:1,result:'Prompt is too long: 300000 tokens > 256000 maximum'})); process.exit(0); }
if (key === 'GROK_GARBAGE') { console.log('<<<not json>>>'); process.exit(0); }
if (key === 'GROK_HANG') { await new Promise(() => {}); }
if (key === 'GROK_EMPTY') { process.exit(0); }
console.log(JSON.stringify({type:'result',stopReason:'end_turn',num_turns:1,structuredOutput:{text:'GROK_OK',tool_calls:[]}}));
`);
  await chmod(grok, 0o700);
  process.env.GROK_BIN = grok;
  process.env.GROK_CWD = scratch;
  process.env.GROK_TIMEOUT_MS = '400';
});
afterAll(async () => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  await rm(scratch, { recursive: true, force: true });
});

type App = Awaited<ReturnType<typeof fixtureRouter>>;
const body = (model: string, text: string, extra: Record<string, unknown> = {}) => ({ model, input: [{ role: 'user', content: text }], ...extra });
const post = (app: App, payload: unknown, init: RequestInit = {}) =>
  fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(payload), ...init });
const sse = (text: string) => text.split('\n').filter(l => l.startsWith('data: ')).flatMap(l => { try { return [JSON.parse(l.slice(6)) as any]; } catch { return []; } });
const terminal = (text: string) => sse(text).find(e => ['response.failed', 'response.completed'].includes(e.type));
async function socketTurn(app: App, payload: unknown, timeoutMs = 6000): Promise<any> {
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

/** The failure Codex sees on each transport, normalised to { status, code, message }. */
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
const expectRetryable = (seen: Seen[], message: string) => {
  for (const cell of seen) {
    expect(cell.code, cell.transport).toBe('server_error');
    expect(cell.message, cell.transport).toBe(message);
    if (cell.transport === 'http') expect(cell.status, cell.transport).toBeGreaterThanOrEqual(500);
  }
};
// Plain HTTP carries the backend's own error code; streams and sockets carry native Codex's
// terminal `invalid_prompt` code so Codex never retries a refusal.
const expectTerminal = (seen: Seen[], code: string, fragment: string, streamCode = 'invalid_prompt') => {
  for (const cell of seen) {
    expect(cell.code, cell.transport).toBe(cell.transport === 'http' ? code : streamCode);
    expect(cell.message, cell.transport).toContain(fragment);
    expect(cell.message, cell.transport).not.toContain(INTERNAL);
    if (cell.transport === 'http') expect(cell.status).toBe(400);
  }
};
const expectOk = (seen: Seen[], text: string) => { for (const cell of seen) { expect(cell.code, cell.transport).toBe('ok'); expect(cell.message, cell.transport).toBe(text); } };
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Claude CLI subprocess failures through the router', () => {
  const MODEL = 'claude-opus-5-5';

  test('the stand-in serves a normal turn on every transport', async () => {
    const app = await fixtureRouter();
    try { expectOk(await everyTransport(app, body(MODEL, 'hello')), 'CLI_OK'); } finally { await app.close(); }
  });

  test('a CLI crash mid-turn is a retryable 500 with the diagnostic hidden, and the next turn works', async () => {
    const app = await fixtureRouter();
    try {
      const seen = await everyTransport(app, body(MODEL, 'CLI_CRASH'));
      expectRetryable(seen, INTERNAL);
      for (const cell of seen) expect(cell.message).not.toContain('panic');
      expectOk(await everyTransport(app, body(MODEL, 'again')), 'CLI_OK');
    } finally { await app.close(); }
  });

  test('a CLI that hangs or only prints garbage times out as a retryable 503 and the worker is killed', async () => {
    const app = await fixtureRouter();
    try {
      for (const token of ['CLI_HANG', 'CLI_GARBAGE']) {
        const seen = await everyTransport(app, body(MODEL, token));
        expectRetryable(seen, TIMED_OUT);
        expect(seen[0]!.status).toBe(503);
        const pid = Number(await readFile(scratch + '/claude.pid', 'utf8'));
        await sleep(50);
        expect(pidAlive(pid)).toBe(false);
      }
      expectOk(await everyTransport(app, body(MODEL, 'after-hang')), 'CLI_OK');
    } finally { await app.close(); }
  });

  test('a usage-limit result is a terminal quota refusal with our message and does not poison later turns', async () => {
    const app = await fixtureRouter();
    try {
      expectTerminal(await everyTransport(app, body(MODEL, 'CLI_LIMIT')), 'claude_usage_limit_reached', 'limit');
      expectTerminal(await everyTransport(app, body(MODEL, 'CLI_RATE_EVENT')), 'claude_usage_limit_reached', 'limit');
      expectOk(await everyTransport(app, body(MODEL, 'after-limit')), 'CLI_OK');
    } finally { await app.close(); }
  });

  test('a prompt over the context window is the native context_length_exceeded code, never retried', async () => {
    const app = await fixtureRouter();
    try {
      expectTerminal(await everyTransport(app, body(MODEL, 'CLI_OVERFLOW')), 'context_length_exceeded', 'context window', 'context_length_exceeded');
    } finally { await app.close(); }
  });

  test('a provider overload reported after the CLI own retries is native server_is_overloaded, not a retried 500', async () => {
    const app = await fixtureRouter();
    try {
      expectTerminal(await everyTransport(app, body(MODEL, 'CLI_OVERLOAD')), 'server_is_overloaded', 'overloaded right now', 'server_is_overloaded');
    } finally { await app.close(); }
  });

  test('an unclassified CLI error result is a retryable 500 whose text never reaches Codex', async () => {
    const app = await fixtureRouter();
    try {
      const seen = await everyTransport(app, body(MODEL, 'CLI_ERRORED'));
      expectRetryable(seen, INTERNAL);
      for (const cell of seen) expect(cell.message).not.toContain('exploded');
    } finally { await app.close(); }
  });

  test('malformed structured output or an unknown tool request is a retryable 500, not a half answer', async () => {
    const app = await fixtureRouter();
    try {
      expectRetryable(await everyTransport(app, body(MODEL, 'CLI_BADSTRUCT')), INTERNAL);
      const tools = [{ type: 'function', name: 'lookup', description: 'x', parameters: { type: 'object', properties: {} } }];
      expectRetryable(await everyTransport(app, body(MODEL, 'CLI_BADTOOL', { tools })), INTERNAL);
    } finally { await app.close(); }
  });

  test('a CLI network drop keeps the turn pending with progress until Codex cancels, then the router is free', async () => {
    const app = await fixtureRouter({ heartbeatMs: 100 });
    try {
      const controller = new AbortController();
      const response = await post(app, { ...body(MODEL, 'CLI_NETWORK'), stream: true }, { signal: controller.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const started = Date.now();
      while (Date.now() - started < 1500) {
        const chunk = await Promise.race([reader.read(), sleep(200).then(() => ({ done: false, value: undefined }))]);
        if (chunk.value) text += decoder.decode(chunk.value, { stream: true });
        if (chunk.done) break;
      }
      expect(terminal(text)).toBeUndefined();
      expect(sse(text).length).toBeGreaterThan(0);
      controller.abort();
      await sleep(100);
      expectOk(await everyTransport(app, body(MODEL, 'after-network')), 'CLI_OK');
    } finally { await app.close(); }
  });

  test('a client cancel mid-turn kills the CLI and frees the router', async () => {
    const app = await fixtureRouter();
    try {
      const controller = new AbortController();
      const pending = post(app, body(MODEL, 'CLI_HANG'), { signal: controller.signal }).catch(error => error);
      await sleep(150);
      const pid = Number(await readFile(scratch + '/claude.pid', 'utf8'));
      expect(pidAlive(pid)).toBe(true);
      controller.abort();
      await pending;
      await sleep(100);
      expect(pidAlive(pid)).toBe(false);
      expectOk(await everyTransport(app, body(MODEL, 'after-cancel')), 'CLI_OK');
    } finally { await app.close(); }
  });
});

describe('Grok Build subprocess failures through the router', () => {
  const MODEL = 'grok-4.7';
  const invocations = async (key: string) => Number(await readFile(scratch + '/grok-' + key + '.count', 'utf8').catch(() => '0'));

  test('the stand-in serves a normal turn on every transport', async () => {
    const app = await fixtureRouter();
    try { expectOk(await everyTransport(app, body(MODEL, 'hello')), 'GROK_OK'); } finally { await app.close(); }
  });

  test('a crash exit is classified, retried once, then refused with the exit code and no stderr', async () => {
    const app = await fixtureRouter();
    try {
      const seen = await everyTransport(app, body(MODEL, 'GROK_CRASH'));
      expectTerminal(seen, 'invalid_request_error', 'exit 7');
      for (const cell of seen) expect(cell.message).not.toContain('segmentation');
      expect(await invocations('GROK_CRASH')).toBe(6);
    } finally { await app.close(); }
  });

  test('an auth failure is refused immediately without a retry', async () => {
    const app = await fixtureRouter();
    try {
      expectTerminal(await everyTransport(app, body(MODEL, 'GROK_AUTH')), 'invalid_request_error', 'exit 1');
      expect(await invocations('GROK_AUTH')).toBe(3);
    } finally { await app.close(); }
  });

  test('a quota error reported by the CLI is refused without a retry', async () => {
    const app = await fixtureRouter();
    try {
      expectTerminal(await everyTransport(app, body(MODEL, 'GROK_QUOTA')), 'invalid_request_error', 'no automatic fallback');
      expect(await invocations('GROK_QUOTA')).toBe(3);
    } finally { await app.close(); }
  });

  test('a prompt over the context window is the native context_length_exceeded code and is never retried', async () => {
    const app = await fixtureRouter();
    try {
      expectTerminal(await everyTransport(app, body(MODEL, 'GROK_OVERFLOW')), 'context_length_exceeded', 'context window', 'context_length_exceeded');
      expect(await invocations('GROK_OVERFLOW')).toBe(3);
    } finally { await app.close(); }
  });

  test('garbage or empty output is retried once and then refused as invalid output', async () => {
    const app = await fixtureRouter();
    try {
      expectTerminal(await everyTransport(app, body(MODEL, 'GROK_GARBAGE')), 'invalid_request_error', 'invalid output');
      expect(await invocations('GROK_GARBAGE')).toBe(6);
      expectTerminal(await everyTransport(app, body(MODEL, 'GROK_EMPTY')), 'invalid_request_error', 'invalid output');
      expect(await invocations('GROK_EMPTY')).toBe(6);
    } finally { await app.close(); }
  });

  test('a hung CLI is killed at the Grok timeout and refused with the timeout message', async () => {
    const app = await fixtureRouter();
    try {
      const seen = await everyTransport(app, body(MODEL, 'GROK_HANG'));
      expectTerminal(seen, 'invalid_request_error', 'timed out');
      const pid = Number(await readFile(scratch + '/grok.pid', 'utf8'));
      await sleep(50);
      expect(pidAlive(pid)).toBe(false);
      expectOk(await everyTransport(app, body(MODEL, 'after-hang')), 'GROK_OK');
    } finally { await app.close(); }
  });

  test('a client cancel mid-turn kills the Grok process', async () => {
    const app = await fixtureRouter();
    try {
      const controller = new AbortController();
      const pending = post(app, body(MODEL, 'GROK_HANG'), { signal: controller.signal }).catch(error => error);
      await sleep(200);
      const pid = Number(await readFile(scratch + '/grok.pid', 'utf8'));
      expect(pidAlive(pid)).toBe(true);
      controller.abort();
      await pending;
      await sleep(100);
      expect(pidAlive(pid)).toBe(false);
    } finally { await app.close(); }
  });
});
