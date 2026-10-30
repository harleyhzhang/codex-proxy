import { expect, test } from 'bun:test';
import { assertNotLooping, checkArgumentShape, functionArguments, GrokError, grokOutputSchema, latestStepRecap, parseGrokOutput, repairJsonStrings } from '../src/backends/grok';
import type { ResponseInputItem, ResponsesRequest, ResponseTool } from '../src/protocol/types';

const tool: ResponseTool = { type: 'function', name: 'read', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
} };
const request = (tools: ResponseTool[] = [tool], input: ResponseInputItem[] = []): ResponsesRequest => ({ model: 'grok-4.7', input, tools });
const call = (args: unknown, name = 'read', req = request()) => parseGrokOutput(JSON.stringify({ text: '', tool_calls: [{ name, arguments: args }] }), req);
const step = (id: string, name: string, args: string | object, output: string): ResponseInputItem[] => [
  { type: 'function_call', name, call_id: id, arguments: args }, { type: 'function_call_output', call_id: id, output },
];

test('Grok preserves every already-valid JSON escape and whitespace byte instead of rewriting valid control escapes', () => {
  const valid = String.raw`{ "path": "a\bb\fc\nd\re\tf\u0000g\uD83D\uDE00 \\ \/ \"" }`;
  expect(functionArguments(valid)).toBe(valid);
  expect(JSON.parse(functionArguments(valid))).toEqual(JSON.parse(valid));
  expect(JSON.parse(functionArguments(JSON.stringify(valid)))).toEqual(JSON.parse(valid));
});

test('Grok still repairs invalid string escapes/control characters without inventing missing structure', () => {
  const raw = '{"path":"a\\.b\nsecond\tline"}';
  expect(JSON.parse(repairJsonStrings(raw))).toEqual({ path: 'a\\.b\nsecond\tline' });
  expect(JSON.parse(functionArguments(raw))).toEqual({ path: 'a\\.b\nsecond\tline' });
  for (const malformed of ['{"path":"unterminated', '{"path":"ok",}', '{path:"ok"}', '["path"]']) {
    expect(() => functionArguments(malformed)).toThrow(GrokError);
  }
});

test('Grok required properties must be own properties, including names inherited by plain objects', () => {
  for (const name of ['toString', 'constructor', '__proto__']) {
    const contract = JSON.parse('{"type":"object","properties":{"' + name + '":{"type":"string"}},"required":["' + name + '"]}') as unknown;
    expect(() => checkArgumentShape('read', '{}', contract)).toThrow(/required/);
  }
  expect(() => checkArgumentShape('read', '{}', { type: 'object', required: ['path'] })).toThrow(/required/);
});

test('Grok validates nested object/array required fields, types, enums and numeric bounds before any tool can execute', () => {
  const parameters = { type: 'object', properties: {
    targets: { type: 'array', minItems: 1, items: { type: 'object', properties: { id: { type: 'string' }, retries: { type: 'integer', minimum: 0 }, mode: { enum: ['read', 'write'] } }, required: ['id', 'mode'], additionalProperties: false } },
  }, required: ['targets'], additionalProperties: false };
  const req = request([{ ...tool, parameters }]);
  expect(call({ targets: [{ id: 'fixture', retries: 2, mode: 'read' }] }, 'read', req).toolCalls).toHaveLength(1);
  for (const args of [
    { targets: [] }, { targets: [{ mode: 'read' }] }, { targets: [{ id: 7, mode: 'read' }] },
    { targets: [{ id: 'fixture', mode: 'delete' }] }, { targets: [{ id: 'fixture', mode: 'read', retries: -1 }] },
    { targets: [{ id: 'fixture', mode: 'read', retries: 0.5 }] }, { targets: [{ id: 'fixture', mode: 'read', surprise: true }] },
  ]) expect(() => call(args, 'read', req)).toThrow(GrokError);
});

test('Grok validates union/composition/ref contracts and rejects invalid values instead of forwarding them', () => {
  const parameters = { type: 'object', $defs: { target: { type: ['string', 'null'], minLength: 2 } }, properties: {
    target: { $ref: '#/$defs/target' }, count: { anyOf: [{ type: 'integer', minimum: 1 }, { const: 'auto' }] },
    options: { oneOf: [{ type: 'object', required: ['read'] }, { type: 'object', required: ['write'] }] },
  }, required: ['target', 'count', 'options'] };
  const req = request([{ ...tool, parameters }]);
  expect(call({ target: null, count: 'auto', options: { read: true } }, 'read', req).toolCalls).toHaveLength(1);
  for (const args of [
    { target: 'x', count: 1, options: { read: true } }, { target: 'ok', count: 0, options: { read: true } },
    { target: 'ok', count: 'auto', options: { read: true, write: true } }, { target: 'ok', count: 'auto', options: {} },
  ]) expect(() => call(args, 'read', req)).toThrow(GrokError);
  expect(() => call({}, 'read', request([{ ...tool, parameters: false }]))).toThrow(GrokError);
});

test('Grok drops harmless top-level extras as before but validates typed additional properties', () => {
  expect(JSON.parse(call({ path: '/fixture', description: 'extra narration' }).toolCalls[0]!.arguments)).toEqual({ path: '/fixture' });
  const req = request([{ ...tool, parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: { type: 'integer' } } }]);
  expect(call({ path: '/fixture', extra: 1 }, 'read', req).toolCalls).toHaveLength(1);
  expect(() => call({ path: '/fixture', extra: 'wrong' }, 'read', req)).toThrow(GrokError);
});

test('Grok unwraps an unambiguous custom payload without reformatting its raw bytes and refuses ambiguous wrappers', () => {
  const req = request([{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] }]);
  const raw = ' // @exec: {"yield_time_ms":1000}\nawait tools.read({path:"a\\\\b"});\n';
  for (const args of [raw, { code: raw }, { input: raw }, { argument: raw, call_id: 'ignored-model-id' }]) {
    expect(call(args, 'functions.exec', req).toolCalls[0]?.arguments).toBe(raw);
  }
  for (const args of [{ code: raw, patch: 'different' }, { code: raw, other: 1 }, { code: 3 }, ['raw']]) {
    expect(() => call(args, 'functions.exec', req)).toThrow(GrokError);
  }
});

test('Grok normalizes explicit declared namespaces and OpenAI function envelopes without inventing tool aliases', () => {
  expect(call({ path: '/fixture' }, 'functions.read').toolCalls[0]?.name).toBe('read');
  const namespaced = request([{ type: 'namespace', name: 'files', tools: [{ ...tool }] }]);
  const parsed = parseGrokOutput(JSON.stringify({ text: '', tool_calls: [{ namespace: 'files', name: 'read', arguments: { path: '/fixture' } }] }), namespaced);
  expect(parsed.toolCalls[0]?.name).toBe('files.read');
  const openai = parseGrokOutput(JSON.stringify({ text: '', tool_calls: [{ type: 'function', function: { name: 'read', arguments: { path: '/fixture' } } }] }), request());
  expect(openai.toolCalls[0]?.name).toBe('read');
  expect(() => call({ path: '/fixture' }, 'unlisted.read')).toThrow(GrokError);
  expect(() => call({ path: '/fixture' }, 'read', namespaced)).toThrow(GrokError);
});

test('Grok accepts only complete fenced envelopes/string repairs and refuses unknown or conflicting action payloads', () => {
  const raw = JSON.stringify({ text: '', tool_calls: [{ name: 'read', arguments: { path: '/fixture' } }] });
  expect(parseGrokOutput('```json\n' + raw + '\n```', request()).toolCalls).toHaveLength(1);
  expect(parseGrokOutput('{"text":"first\nsecond","tool_calls":[]}', request()).text).toBe('first\nsecond');
  expect(() => parseGrokOutput('some prose ' + raw, request())).toThrow(GrokError);
  expect(() => parseGrokOutput(JSON.stringify({ text: '', tool_calls: [{ name: 'read', arguments: { path: '/a' }, input: '{"path":"/b"}' }] }), request())).toThrow(GrokError);
  expect(() => parseGrokOutput(JSON.stringify({ text: '', tool_calls: [{ name: 'read', function: { name: 'other', arguments: { path: '/a' } } }] }), request())).toThrow(GrokError);
});

test('Grok does not mistake a new user request or a namespaced polling tool for an autonomous repeat loop', () => {
  const args = '{"path":"/fixture"}', repeated = [...step('a', 'read', args, 'unchanged'), ...step('b', 'read', args, 'unchanged')];
  expect(() => assertNotLooping(request([tool], repeated), [{ name: 'read', arguments: args }])).toThrow(/third time/);
  expect(() => assertNotLooping(request([tool], [...repeated, { role: 'user', content: 'Run that same check again.' }]), [{ name: 'read', arguments: args }])).not.toThrow();
  expect(() => assertNotLooping(request([tool], [...step('a', 'read', args, 'unchanged'), { role: 'user', content: 'Run twice more.' }, ...step('b', 'read', args, 'unchanged')]), [{ name: 'read', arguments: args }])).not.toThrow();
  for (const name of ['functions.write_stdin', 'functions.wait', 'clock.sleep', 'functions.clock__sleep', 'collaboration.wait_agent', 'functions.wait_agent', 'mcp__codex_app__wait_threads', 'functions.mcp__codex_app__wait_threads']) {
    expect(() => assertNotLooping(request([], [...step('a', name, '{}', 'pending'), ...step('b', name, '{}', 'pending')]), [{ name, arguments: '{}' }])).not.toThrow();
  }
  for (const name of ['functions.read', 'mcp__codex_app__get_threads', 'mcp__codex_app__read_thread', 'arbitrary__wait_threads', 'mcp__wait_threads']) {
    expect(() => assertNotLooping(request([], [...step('a', name, '{}', 'same'), ...step('b', name, '{}', 'same')]), [{ name, arguments: '{}' }])).toThrow(/third time/);
  }
});

test('Grok loop evidence keeps real output lines intact and the recap follows actual completion order', () => {
  const args = '{"path":"/fixture"}';
  const changed = [...step('a', 'read', args, 'Output:\nWall time: original file content'), ...step('b', 'read', args, 'Output:\nWall time: changed file content')];
  expect(() => assertNotLooping(request([tool], changed), [{ name: 'read', arguments: args }])).not.toThrow();
  const parallel: ResponseInputItem[] = [
    { type: 'function_call', name: 'read', call_id: 'a', arguments: args }, { type: 'function_call', name: 'read', call_id: 'b', arguments: args },
    { type: 'function_call_output', call_id: 'b', output: 'B completed first' }, { type: 'function_call_output', call_id: 'a', output: 'A completed last' },
  ];
  expect(latestStepRecap(request([tool], parallel))).toContain('A completed last');
  const duplicated = [...step('same-id', 'read', args, 'same receipt'), ...step('same-id', 'read', args, 'same receipt')];
  expect(() => assertNotLooping(request([tool], duplicated), [{ name: 'read', arguments: args }])).not.toThrow();
});

test('Grok autonomous repeat detection survives equivalent parameter member order and declared wrapper names', () => {
  const tools = [{ ...tool, parameters: { type: 'object', properties: { path: { type: 'string' }, encoding: { type: 'string' } } } }];
  const prior = [...step('a', 'functions.read', '{"path":"/fixture","encoding":"utf8"}', 'same'), ...step('b', 'read', { encoding: 'utf8', path: '/fixture' }, 'same')];
  expect(() => assertNotLooping(request(tools, prior), [{ name: 'read', arguments: '{"encoding":"utf8","path":"/fixture"}' }])).toThrow(/third time/);
});

test('Grok polling recaps permit repeated waits for pending work and require using completed results', () => {
  for (const name of ['collaboration.wait_agent', 'mcp__codex_app__wait_threads', 'functions.mcp__codex_app__wait_threads', 'functions.write_stdin']) {
    const pending = latestStepRecap(request([], step('wait-1', name, '{"timeout_ms":1000}', 'Still running; wait timed out.')));
    expect(pending).toContain('Identical polling arguments are allowed');
    expect(pending).toContain('still running');
    expect(pending).toContain('timed out');
    expect(pending).not.toContain('Do not repeat an identical call');
    const done = latestStepRecap(request([], step('wait-2', name, '{"timeout_ms":1000}', 'Completed: actual helper result.')));
    expect(done).toContain('use the actual result');
    expect(done).toContain('remaining requested work');
    expect(done).toContain('actual helper result');
  }
  const read = latestStepRecap(request([tool], step('read-1', 'read', '{"path":"/fixture"}', 'actual file contents')));
  expect(read).toContain('Do not repeat an identical call unless something has changed');
  expect(read).not.toContain('Identical polling arguments are allowed');
});

test('Grok generated output schemas cap actions and teach raw strings for custom-only tools', () => {
  const custom = grokOutputSchema([{ type: 'custom', name: 'exec' }]);
  expect(custom).toHaveProperty('properties.tool_calls.maxItems', 64);
  expect(custom).toHaveProperty('properties.tool_calls.items.properties.arguments.type', 'string');
  expect(grokOutputSchema([])).toHaveProperty('properties.tool_calls.maxItems', 0);
});

test('Grok schema depth exhaustion fails closed even inside negation and conditional alternatives', () => {
  let deep: unknown = false;
  for (let i = 0; i < 65; i++) deep = { not: deep };
  for (const parameters of [deep, { if: deep, then: true, else: true }, { anyOf: [deep, true] }]) {
    expect(() => call({}, 'read', request([{ ...tool, parameters }]))).toThrow(/validation budget/);
  }
});

test('Grok schema work-budget exhaustion cannot become success through not', () => {
  const parameters = { not: { anyOf: Array.from({ length: 100_001 }, () => false) } };
  expect(() => call({}, 'read', request([{ ...tool, parameters }]))).toThrow(/validation budget/);
});
