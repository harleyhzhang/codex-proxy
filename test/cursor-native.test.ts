// The native Cursor tool path against a scripted SDK that behaves like the real one: Codex tools
// arrive as SDK custom tools, the model's calls come back through their `execute` callbacks, and the
// run waits for the router's answer before it continues. The script is chosen by a word in the prompt.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmod, readdir, rm, writeFile } from 'node:fs/promises';
import type { JsonRecord } from '../src/json';
import { responseObject } from '../src/protocol/output';
import type { ProxyOutput, ResponseInputItem, ResponsesRequest, ToolCall } from '../src/protocol/types';
import { scriptedCursor } from './cursor-sdk-fixture';

const savedSettle = process.env.CURSOR_TOOL_SETTLE_MS;
beforeAll(() => { process.env.CURSOR_TOOL_SETTLE_MS = '60'; });
afterAll(() => { if (savedSettle === undefined) delete process.env.CURSOR_TOOL_SETTLE_MS; else process.env.CURSOR_TOOL_SETTLE_MS = savedSettle; });

type Fixture = Awaited<ReturnType<typeof scriptedCursor>>;
async function fixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const f = await scriptedCursor();
  try { await run(f); }
  finally { await f.backend.close(); await rm(f.root, { recursive: true, force: true }); }
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
const find = (f: Fixture, operation: string) => f.events.filter(event => event.operation === operation);

test('Codex tools are the only tools: custom tools behind the MCP group alone, on an empty file tree with no settings', () => fixture(async f => {
  await f.backend.run(request('PLAIN'));
  await f.backend.run(request('PLAIN', []));
  const [create] = find(f, 'create');
  expect(create).toMatchObject({ tools: ['mcp'], disallowed: ['task'], settingSources: [], fs: { empty: true }, apiKey: 'fixture-key' });
  const [withTools, withoutTools] = find(f, 'send');
  expect(withTools?.tools).toEqual(['echo', 'apply_patch']);
  expect((withTools?.schemas as JsonRecord).echo).toEqual({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false });
  expect((withTools?.schemas as JsonRecord).apply_patch).toEqual({ type: 'object', properties: { input: { type: 'string', description: 'The complete raw input for this tool.' } }, required: ['input'], additionalProperties: false });
  expect(withTools?.model).toEqual({ id: 'kimi-k3', params: [{ id: 'reasoning', value: 'high' }] });
  expect(withoutTools?.tools).toEqual([]);
}));

test('a turn that forbids calls (compaction) gets no tools', () => fixture(async f => {
  await f.backend.run({ ...request('PLAIN'), tool_choice: 'none' });
  expect(find(f, 'send')[0]?.tools).toEqual([]);
}));

test('a tool call reaches Codex as a call and its result continues the same run, with no new agent or prompt', () => fixture(async f => {
  const first = request('ONE_TOOL');
  const calling = await f.backend.run(first);
  expect(calling.text).toBe('working');
  expect(calling.toolCalls).toHaveLength(1);
  expect(calling.toolCalls[0]).toMatchObject({ name: 'echo', arguments: '{"value":"v1"}' });
  const done = await f.backend.run(nextTurn(first, calling, ['fixture-result']));
  expect(done).toMatchObject({ text: 'got:fixture-result', toolCalls: [] });
  expect(find(f, 'send')).toHaveLength(1);
  expect(String(find(f, 'send')[0]?.text)).not.toContain('tool_calls');
}));

test('the agent for the next turn is ready before it starts', () => fixture(async f => {
  f.backend.prewarm?.(request('PLAIN'));
  for (let i = 0; i < 100 && f.count('create') < 1; i++) await Bun.sleep(5);
  expect(f.count('create')).toBe(1);
  await f.backend.run(request('PLAIN'));
  // The turn used the ready agent and a new one was readied behind it.
  for (let i = 0; i < 100 && f.count('create') < 2; i++) await Bun.sleep(5);
  expect(f.count('create')).toBe(2);
  expect(find(f, 'send')[0]?.agentId).toBe('agent-1');
}));

test('several tool steps in one run each become one Codex turn', () => fixture(async f => {
  const first = request('TWO_STEPS');
  const one = await f.backend.run(first);
  const second = nextTurn(first, one, ['r1']);
  const two = await f.backend.run(second);
  expect(two).toMatchObject({ text: 'again', toolCalls: [{ name: 'echo', arguments: '{"value":"v2"}' }] });
  const done = await f.backend.run(nextTurn(second, two, ['r2']));
  expect(done.text).toBe('got:r1,r2');
  expect(find(f, 'send')).toHaveLength(1);
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
  expect(await f.backend.run(request('BAD_RAW'))).toMatchObject({ text: 'refused:true', toolCalls: [] });
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
  expect(find(f, 'send')).toHaveLength(2);
  expect(f.count('cancel')).toBe(1);
  expect((find(f, 'tool-result')[0]?.result as JsonRecord).isError).toBe(true);
}));

test('a held run that Codex never continues expires, releasing its call and cancelling the run', () => fixture(async f => {
  const savedIdle = process.env.CURSOR_SESSION_IDLE_MS;
  process.env.CURSOR_SESSION_IDLE_MS = '150';
  try {
    const first = request('ONE_TOOL');
    const calling = await f.backend.run(first);
    await Bun.sleep(400);
    expect(f.count('cancel')).toBe(1);
    expect((find(f, 'tool-result')[0]?.result as JsonRecord).isError).toBe(true);
    // A late result is replayed in a fresh agent rather than lost.
    await f.backend.run(nextTurn(first, calling, ['late']));
    expect(find(f, 'send')).toHaveLength(2);
  } finally { if (savedIdle === undefined) delete process.env.CURSOR_SESSION_IDLE_MS; else process.env.CURSOR_SESSION_IDLE_MS = savedIdle; }
}));

test('past the cap of runs waiting on Codex, the oldest is ended and replays if continued later', () => fixture(async f => {
  const saved = process.env.CURSOR_MAX_HELD_RUNS;
  process.env.CURSOR_MAX_HELD_RUNS = '1';
  try {
    const first = request('ONE_TOOL');
    const calling = await f.backend.run(first);
    expect((await f.backend.run(request('PLAIN other chat'))).text).toBe('hello');
    await f.backend.run(nextTurn(first, calling, ['late']));
    expect(find(f, 'send')).toHaveLength(3);
    expect(f.count('cancel')).toBe(1);
  } finally { if (saved === undefined) delete process.env.CURSOR_MAX_HELD_RUNS; else process.env.CURSOR_MAX_HELD_RUNS = saved; }
}));

test('any tool other than Codex\'s stops the turn as a native action', () => fixture(async f => {
  await expect(f.backend.run(request('NATIVE_SHELL'))).rejects.toThrow(/native action/);
}));

test('Cursor summarizing its own context is a context overflow, so Codex compacts', () => fixture(async f => {
  expect(await f.backend.run(request('SUMMARY')).catch((error: { code?: string }) => error.code)).toBe('context_length_exceeded');
}));

test('cancelling a turn while the model works cancels the run and cleans up its agent', () => fixture(async f => {
  const controller = new AbortController();
  const pending = f.backend.run(request('HANG'), controller.signal);
  for (let i = 0; i < 100 && f.count('send') < 1; i++) await Bun.sleep(5);
  controller.abort();
  await expect(pending).rejects.toThrow();
  await Bun.sleep(20);
  expect(f.count('cancel')).toBe(1);
  expect(find(f, 'close').map(event => event.agentId)).toContain('agent-1');
}));

test('function arguments that miss a required field go back to the model and never reach Codex', () => fixture(async f => {
  const output = await f.backend.run(request('BAD_ARGS'));
  expect(output.toolCalls).toEqual([]);
  expect(output.text).toBe('refused:true:echo needs value; its parameters are value. The tool did not run.');
}));

test('the prompt lists each tool schema and names the raw-input tools, so no discovery step is needed', () => fixture(async f => {
  await f.backend.run(request('PLAIN'));
  const prompt = String(find(f, 'send')[0]?.text);
  expect(prompt).toContain('- echo: {"type":"object","properties":{"value":{"type":"string"}}');
  expect(prompt).toContain('Only apply_patch takes one raw string');
}));

test('recognized image parts travel as SDK attachments while ordinary tool metadata stays in text', () => fixture(async f => {
  const inline = 'data:image/png;base64,AAAA';
  await f.backend.run({ ...request('PLAIN'), tools: [], input: [
    { role: 'user', content: [{ type: 'input_text', text: 'PLAIN describe' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] },
    { type: 'computer_call_output', call_id: 'typed', output: { type: 'computer_screenshot', image_url: inline } },
    { type: 'computer_call_output', call_id: 'legacy', output: { image_url: inline } },
    { type: 'function_call_output', call_id: 'metadata', output: { image_url: 'https://example.invalid/metadata.png', file_id: 'database-row' } },
  ] as ResponseInputItem[] });
  const [send] = find(f, 'send');
  expect(send?.images).toBe(3);
  expect(String(send?.text)).toContain('https://example.invalid/metadata.png');
  expect(f.backend.catalog.find(model => model.slug === 'fixture-grok-4.7')?.inputModalities).toEqual(['text', 'image']);
  expect(f.backend.catalog.find(model => model.slug === 'fixture-kimi-k3')?.inputModalities).toEqual(['text']);
}));

test('a held run never continues under a rotated, exposed or foreign credential', () => fixture(async f => {
  const first = request('ONE_TOOL');
  const calling = await f.backend.run(first);
  await writeFile(f.auth, JSON.stringify({ apiKey: 'rotated-key', email: 'test@example.com', backendUrl: 'https://api2.cursor.sh' }));
  await f.backend.run(nextTurn(first, calling, ['r']));
  expect(find(f, 'send')).toHaveLength(2);
  expect(f.count('cancel')).toBe(1);

  const again = await f.backend.run(first);
  await chmod(f.auth, 0o644);
  await expect(f.backend.run(nextTurn(first, again, ['r']))).rejects.toThrow('owner-only');
  await chmod(f.auth, 0o600);
  const third = await f.backend.run(first);
  await writeFile(f.auth, JSON.stringify({ apiKey: 'foreign-key', email: 'test@example.com', backendUrl: 'https://api2.cursor.sh' }));
  f.state.me = () => ({ userEmail: 'other@example.com', userId: 'fixture' });
  await expect(f.backend.run(nextTurn(first, third, ['r']))).rejects.toThrow('differs from the pinned identity');
}));

test('each Codex turn streams the run written for it: thinking, text, and calls as soon as the model makes them', () => fixture(async f => {
  const first = request('TWO_STEPS THINK');
  const seen: string[][] = [[], [], []];
  const sink = (i: number) => ({
    text: (delta: string) => { seen[i]!.push(delta); },
    reasoning: (delta: string) => { seen[i]!.push(`thinking:${delta}`); },
    call: (call: ToolCall) => { seen[i]!.push(`call:${call.arguments}`); },
    get started() { return seen[i]!.length > 0; },
  });
  const one = await f.backend.run(first, undefined, sink(0));
  const second = nextTurn(first, one, ['r1']);
  const two = await f.backend.run(second, undefined, sink(1));
  const done = await f.backend.run(nextTurn(second, two, ['r2']), undefined, sink(2));
  expect(seen).toEqual([['thinking:pondering', 'working', 'call:{"value":"v1"}'], ['again', 'call:{"value":"v2"}'], ['got:r1,r2']]);
  expect([one.toolCalls.length, two.toolCalls.length, done.text]).toEqual([1, 1, 'got:r1,r2']);
}));

test('every finished or abandoned agent leaves no working directory behind', () => fixture(async f => {
  const first = request('ONE_TOOL');
  await f.backend.run(first);
  await f.backend.run(request('PLAIN'));
  await f.backend.close();
  expect((await readdir(f.root)).filter(name => name.startsWith('agent-'))).toEqual([]);
}));

test('a router that exits (restart, SIGTERM) leaves no agent folder behind', () => fixture(async f => {
  const script = `
    import { createCursorBackend } from ${JSON.stringify(import.meta.dir + '/../src/backends/cursor.ts')};
    import { scriptedSdk } from ${JSON.stringify(import.meta.dir + '/cursor-sdk-fixture.ts')};
    const scripted = scriptedSdk();
    const backend = createCursorBackend({ authFile: ${JSON.stringify(f.auth)}, cwd: ${JSON.stringify(f.root)}, expectedEmail: 'test@example.com', expectedUserId: 'fixture', prefix: 'exitfixture', label: 'Fixture', sdk: async () => scripted.sdk });
    await backend.run({ model: 'kimi-k3', input: [{ role: 'user', content: 'PLAIN' }], reasoning: { effort: 'high' } });
    for (let i = 0; i < 100 && scripted.events.filter(e => e.operation === 'create').length < 2; i++) await Bun.sleep(5);
    process.once('SIGTERM', () => process.exit(143));
    console.log('ready');
    await new Promise(() => {});
  `;
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'ignore' });
  const reader = child.stdout.getReader();
  let out = '';
  while (!out.includes('ready')) { const { value, done } = await reader.read(); if (done) break; out += new TextDecoder().decode(value); }
  expect((await readdir(f.root)).filter(name => name.startsWith('agent-'))).toHaveLength(1);
  child.kill('SIGTERM');
  expect(await child.exited).toBe(143);
  expect((await readdir(f.root)).filter(name => name.startsWith('agent-'))).toEqual([]);
}));
