// The native Cursor tool path against a scripted bridge that behaves like the real one: Codex tools
// arrive as SDK custom tools, the model's calls come back over the host callback, and the run waits
// for the router's answer before it continues. The script is chosen by a word in the prompt.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createCursorBackend, type CursorBackend } from '../src/backends/cursor';
import { isRecord, sha256, type JsonRecord } from '../src/json';
import { responseObject } from '../src/protocol/output';
import type { ProxyOutput, ResponseInputItem, ResponsesRequest } from '../src/protocol/types';

const saved = { native: process.env.CURSOR_NATIVE_TOOLS, settle: process.env.CURSOR_TOOL_SETTLE_MS };
beforeAll(() => { process.env.CURSOR_NATIVE_TOOLS = '1'; process.env.CURSOR_TOOL_SETTLE_MS = '60'; });
afterAll(() => {
  if (saved.native === undefined) delete process.env.CURSOR_NATIVE_TOOLS; else process.env.CURSOR_NATIVE_TOOLS = saved.native;
  if (saved.settle === undefined) delete process.env.CURSOR_TOOL_SETTLE_MS; else process.env.CURSOR_TOOL_SETTLE_MS = saved.settle;
});

type Fixture = { backend: CursorBackend; events(): Promise<JsonRecord[]> };
async function fixture(run: (fixture: Fixture) => Promise<void>, limit?: number): Promise<void> {
  const root = await mkdtemp(tmpdir() + '/cursor-native-');
  const binary = root + '/bridge', auth = root + '/auth.json';
  const source = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const root = ${JSON.stringify(root)};
const event = (operation, fields = {}) => appendFileSync(root + '/events.jsonl', JSON.stringify({ operation, pid: process.pid, ...fields }) + '\\n');
const FINISHED = 'RUN_LIFECYCLE_STATUS_FINISHED';
const frame = (value) => { const data = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(5); header.writeUInt32BE(data.length, 1); return Buffer.concat([header, data]); };
let callback; const agents = new Map(); let next = 0;
const say = (text) => frame({ sdkMessage: { type: 'assistant', message: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } } } });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 255, async fetch(req) {
  const method = new URL(req.url).pathname.split('/').at(-1);
  if (method === 'Me') return Response.json({ user: { userEmail: 'test@example.com', userId: 'fixture' } });
  if (method === 'ListModels') return Response.json({ items: [{ id: 'kimi-k3', parameters: [{ id: 'reasoning', values: [{ value: 'high' }] }] }] });
  const bytes = Buffer.from(await req.arrayBuffer());
  const body = JSON.parse((method === 'Send' ? bytes.subarray(5) : bytes).toString());
  if (method === 'SetToolCallback') { callback = body; event('callback-set'); return Response.json({}); }
  if (method === 'CreateAgent') { const agentId = 'agent-' + (++next); agents.set(agentId, body.options); event('create', { agentId, tools: body.options.tools, disallowed: body.options.disallowedTools, custom: body.options.local.customTools ?? null }); return Response.json({ agentId }); }
  if (method === 'CancelRun') { event('cancel', { agentId: body.agentId }); return Response.json({}); }
  if (method === 'CloseAgent') { event('close', { agentId: body.agentId }); return Response.json({}); }
  if (method !== 'Send') return new Response('{}', { status: 404 });
  const agentId = body.agentId, prompt = body.message.text, runId = 'run-' + agentId;
  event('send', { agentId, text: prompt });
  // Like a model, act on the newest user message; a replay carries the whole transcript.
  const text = prompt.slice(prompt.lastIndexOf('<user>'));
  const call = async (toolName, args) => {
    const response = await fetch(callback.url + '/sdk.v1.SdkCustomToolCallbackService/CallCustomTool', { method: 'POST', headers: { authorization: 'Bearer ' + callback.authToken, 'content-type': 'application/json' }, body: JSON.stringify({ toolName, args, toolCallId: 'tc-' + toolName, agentId }) });
    const result = (await response.json()).result;
    event('tool-result', { agentId, toolName, result });
    return result;
  };
  const textOf = (result) => result.content.map(part => part.type === 'text' ? part.text : 'image:' + part.mimeType).join('|');
  const stream = new ReadableStream({ async start(c) {
    const running = (toolName, args) => c.enqueue(frame({ sdkMessage: { type: 'tool_call', message: { type: 'tool_call', run_id: runId, name: 'mcp', status: 'running', args: { providerIdentifier: 'custom-user-tools', toolName, args } } } }));
    let final = 'hello';
    try {
      if (text.includes('HANG')) { c.enqueue(say('thinking')); await new Promise(() => {}); }
      if (text.includes('NATIVE_SHELL')) { c.enqueue(frame({ sdkMessage: { type: 'tool_call', message: { type: 'tool_call', run_id: runId, name: 'shell', status: 'running', args: { command: 'touch x' } } } })); }
      if (text.includes('ONE_TOOL') || text.includes('TWO_STEPS')) {
        c.enqueue(say('working')); running('echo', { value: 'v1' });
        final = 'got:' + textOf(await call('echo', { value: 'v1' }));
        if (text.includes('TWO_STEPS')) { c.enqueue(say('again')); running('echo', { value: 'v2' }); final += ',' + textOf(await call('echo', { value: 'v2' })); }
      }
      if (text.includes('PARALLEL')) {
        running('echo', { value: 'a' }); const first = call('echo', { value: 'a' });
        await Bun.sleep(20); running('echo', { value: 'b' }); const second = call('echo', { value: 'b' });
        final = 'got:' + textOf(await first) + '|' + textOf(await second);
      }
      if (text.includes('PATCH')) { running('apply_patch', { input: '*** Begin Patch' }); final = 'patched:' + textOf(await call('apply_patch', { input: '*** Begin Patch' })); }
      if (text.includes('BAD_RAW')) { const result = await call('apply_patch', { a: 1, b: 2 }); final = 'refused:' + String(result.isError); }
      if (text.includes('BAD_ARGS')) { const result = await call('echo', { input: 'x' }); final = 'refused:' + String(result.isError) + ':' + textOf(result); }
      c.enqueue(say(final));
      c.enqueue(frame({ result: { status: FINISHED, runId, result: { status: FINISHED, result: final, model: agents.get(agentId).model, usage: { inputTokens: 10, outputTokens: 2 } } } }));
      c.enqueue(frame({ done: { runId } })); c.close();
    } catch { try { c.close(); } catch {} }
  } });
  return new Response(stream, { headers: { 'content-type': 'application/connect+json' } });
} });
await Bun.write(root + '/token', 'fixture-token');
console.error('cursor-sdk-bridge ready ' + JSON.stringify({ schemaVersion: 1, host: '127.0.0.1', protocol: 'connect', transport: 'tcp', port: server.port, url: 'http://127.0.0.1:' + server.port, authTokenFile: root + '/token' }));
await new Promise(() => {});
`;
  await writeFile(binary, source, { mode: 0o700 });
  await writeFile(auth, JSON.stringify({ apiKey: 'fixture-key', email: 'test@example.com', backendUrl: 'https://api2.cursor.sh' }), { mode: 0o600 });
  const savedLimit = process.env.CURSOR_MAX_BRIDGES;
  if (limit) process.env.CURSOR_MAX_BRIDGES = String(limit);
  const backend = createCursorBackend({ binary, binaryHash: sha256(source), authFile: auth, cwd: root, expectedEmail: 'test@example.com', expectedUserId: 'fixture', prefix: 'fixture', label: 'Fixture' });
  const events = async () => (await readFile(root + '/events.jsonl', 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown).filter(isRecord);
  try { await run({ backend, events }); }
  finally {
    await backend.close(); await rm(root, { recursive: true, force: true });
    if (savedLimit === undefined) delete process.env.CURSOR_MAX_BRIDGES; else process.env.CURSOR_MAX_BRIDGES = savedLimit;
  }
}

const TOOLS: ResponsesRequest['tools'] = [
  { type: 'function', name: 'echo', description: 'Echo a value', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } },
  { type: 'custom', name: 'apply_patch', description: 'Apply a patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
];
const request = (text: string, tools = TOOLS): ResponsesRequest => ({ model: 'kimi-k3', input: [{ role: 'user', content: text }], instructions: 'Follow the user request.', tools, reasoning: { effort: 'high' } });
/** What Codex sends next: the history, this turn's output items and one result per call. */
function nextTurn(prior: ResponsesRequest, output: ProxyOutput, results: unknown[]): ResponsesRequest {
  if (!Array.isArray(prior.input)) throw new Error('expected input array');
  const items = responseObject(prior, output).output as ResponseInputItem[];
  const answers = output.toolCalls.map((call, index) => ({ type: items.find(item => item.call_id === call.callId)?.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output', call_id: call.callId, output: results[index] }));
  return { ...prior, input: [...prior.input, ...items, ...answers] as ResponseInputItem[] };
}
const count = (events: JsonRecord[], operation: string) => events.filter(event => event.operation === operation).length;

test('Codex tools are the only tools: registered as custom tools behind the MCP group alone', () => fixture(async f => {
  await f.backend.run(request('PLAIN'));
  await f.backend.run(request('PLAIN', []));
  const creates = (await f.events()).filter(event => event.operation === 'create');
  expect(creates[0]?.tools).toEqual({ names: ['mcp'] });
  expect(creates[0]?.disallowed).toEqual(['task']);
  expect(Object.keys(creates[0]?.custom as JsonRecord)).toEqual(['echo', 'apply_patch']);
  const echo = (creates[0]?.custom as JsonRecord).echo as JsonRecord;
  expect(echo.inputSchema).toEqual({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false });
  const patch = (creates[0]?.custom as JsonRecord).apply_patch as JsonRecord;
  expect(patch.inputSchema).toEqual({ type: 'object', properties: { input: { type: 'string', description: 'The complete raw input for this tool.' } }, required: ['input'], additionalProperties: false });
  expect(String(patch.description)).toContain('start: /.+/');
  // Without Codex tools even the MCP group is off.
  expect(creates[1]?.tools).toEqual({ names: [] });
  expect(creates[1]?.custom).toBeNull();
}));

test('a tool call reaches Codex as a call and its result continues the same run, with no new agent or prompt', () => fixture(async f => {
  const first = request('ONE_TOOL');
  const calling = await f.backend.run(first);
  expect(calling.text).toBe('working');
  expect(calling.toolCalls).toHaveLength(1);
  expect(calling.toolCalls[0]).toMatchObject({ name: 'echo', arguments: '{"value":"v1"}' });
  const done = await f.backend.run(nextTurn(first, calling, ['fixture-result']));
  expect(done).toMatchObject({ text: 'got:fixture-result', toolCalls: [] });
  const events = await f.events();
  expect(count(events, 'create')).toBe(1);
  expect(count(events, 'send')).toBe(1);
  // The prompt carries no JSON envelope rules: the tools are real.
  expect(String(events.find(event => event.operation === 'send')?.text)).not.toContain('tool_calls');
}));

test('several tool steps in one run each become one Codex turn', () => fixture(async f => {
  const first = request('TWO_STEPS');
  const one = await f.backend.run(first);
  const second = nextTurn(first, one, ['r1']);
  const two = await f.backend.run(second);
  expect(two).toMatchObject({ text: 'again', toolCalls: [{ name: 'echo', arguments: '{"value":"v2"}' }] });
  const done = await f.backend.run(nextTurn(second, two, ['r2']));
  expect(done.text).toBe('got:r1,r2');
  expect(count(await f.events(), 'send')).toBe(1);
}));

test('parallel calls made close together are delivered together and answered together', () => fixture(async f => {
  const first = request('PARALLEL');
  const calling = await f.backend.run(first);
  expect(calling.toolCalls.map(call => call.arguments)).toEqual(['{"value":"a"}', '{"value":"b"}']);
  const done = await f.backend.run(nextTurn(first, calling, ['ra', 'rb']));
  expect(done.text).toBe('got:ra|rb');
}));

test('raw-input tools pass their input string through, and a malformed raw input is refused to the model, not Codex', () => fixture(async f => {
  const first = request('PATCH');
  const calling = await f.backend.run(first);
  expect(calling.toolCalls[0]).toMatchObject({ name: 'apply_patch', arguments: '*** Begin Patch' });
  expect((await f.backend.run(nextTurn(first, calling, ['Success']))).text).toBe('patched:Success');
  const refused = await f.backend.run(request('BAD_RAW'));
  expect(refused).toMatchObject({ text: 'refused:true', toolCalls: [] });
}));

test('an image in a tool result reaches the model as an image', () => fixture(async f => {
  const first = request('ONE_TOOL');
  const calling = await f.backend.run(first);
  const done = await f.backend.run(nextTurn(first, calling, [[{ type: 'input_text', text: 'shot' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]]));
  expect(done.text).toBe('got:shot|image:image/png');
}));

test('a changed history replays a fresh agent, and the abandoned run is cancelled with its call released', () => fixture(async f => {
  const first = request('ONE_TOOL');
  const calling = await f.backend.run(first);
  const changed = nextTurn(first, calling, ['fixture-result']);
  (changed.input as ResponseInputItem[]).push({ role: 'user', content: 'PLAIN and also this' });
  expect((await f.backend.run(changed)).text).toBe('hello');
  await Bun.sleep(50);
  const events = await f.events();
  expect(count(events, 'create')).toBe(2);
  expect(count(events, 'cancel')).toBe(1);
  expect((events.find(event => event.operation === 'tool-result')?.result as JsonRecord).isError).toBe(true);
}));

test('a held run that Codex never continues expires, releasing its call and cancelling the run', () => fixture(async f => {
  const savedIdle = process.env.CURSOR_SESSION_IDLE_MS;
  process.env.CURSOR_SESSION_IDLE_MS = '150';
  try {
    const first = request('ONE_TOOL');
    const calling = await f.backend.run(first);
    await Bun.sleep(400);
    const events = await f.events();
    expect(count(events, 'cancel')).toBe(1);
    expect((events.find(event => event.operation === 'tool-result')?.result as JsonRecord).isError).toBe(true);
    // A late result is replayed in a fresh agent rather than lost.
    await f.backend.run(nextTurn(first, calling, ['late']));
    expect(count(await f.events(), 'create')).toBe(2);
  } finally { if (savedIdle === undefined) delete process.env.CURSOR_SESSION_IDLE_MS; else process.env.CURSOR_SESSION_IDLE_MS = savedIdle; }
}));

test('runs waiting on Codex give their bridge to new work at the cap, and replay if continued later', () => fixture(async f => {
  const first = request('ONE_TOOL');
  const calling = await f.backend.run(first);
  const started = performance.now();
  expect((await f.backend.run(request('PLAIN other chat'))).text).toBe('hello');
  expect(performance.now() - started).toBeLessThan(3000);
  await f.backend.run(nextTurn(first, calling, ['late']));
  const events = await f.events();
  expect(count(events, 'create')).toBe(3);
  expect(count(events, 'cancel')).toBe(1);
}, 1));

test('any tool other than the router\'s MCP tools stops the turn as a native action', () => fixture(async f => {
  await expect(f.backend.run(request('NATIVE_SHELL'))).rejects.toThrow(/native action/);
}));

test('cancelling a turn while the model works cancels the run', () => fixture(async f => {
  const controller = new AbortController();
  const pending = f.backend.run(request('HANG'), controller.signal);
  await Bun.sleep(200);
  controller.abort();
  await expect(pending).rejects.toThrow();
}));

test('function arguments that miss a required field go back to the model and never reach Codex', () => fixture(async f => {
  const output = await f.backend.run(request('BAD_ARGS'));
  expect(output.toolCalls).toEqual([]);
  expect(output.text).toBe('refused:true:echo needs value; its parameters are value. The tool did not run.');
}));

test('the prompt lists each tool schema and names the raw-input tools, so no discovery step is needed', () => fixture(async f => {
  await f.backend.run(request('PLAIN'));
  const prompt = String((await f.events()).find(event => event.operation === 'send')?.text);
  expect(prompt).toContain('- echo: {"type":"object","properties":{"value":{"type":"string"}}');
  expect(prompt).toContain('Only apply_patch takes one raw string');
}));
