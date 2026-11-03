import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ClaudeAccount } from '../src/backends/claude';
import { createGrokBackend } from '../src/backends/grok';
import { BACKENDS } from '../src/backends/registry';
import { withOpusQuotaFallback } from '../src/backends/quota-fallback';
import { ClaudeUsageLimitError } from '../src/backends/claude-limits';
import { BackendError } from '../src/backends/contract';
import { claudeOutputFormat, checkOutputFormat, outputFormat } from '../src/protocol/output-format';
import { functionTools } from '../src/protocol/native-tools';
import { toolSchemaIssue } from '../src/protocol/tool-schema';
import { responseObject, streamResponse } from '../src/protocol/output';
import { EMPTY_OUTPUT, type ResponsesRequest, type ResponsesBody, type ProxyOutput } from '../src/protocol/types';
import { observeResponse } from '../src/router/response-history';
import { isRecord, type JsonRecord } from '../src/json';
import { anthropicFixture } from './anthropic-fixture';
import { AUTH_HEADERS, fixtureRouter } from './support';
import { scriptedCursor } from './cursor-sdk-fixture';

const schema = { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'], additionalProperties: false };
const text = { format: { type: 'json_schema', strict: true, name: 'answer', schema } };
const answer = (value = '{"ok":true}'): ProxyOutput => ({ ...EMPTY_OUTPUT, text: value });
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

test('Claude sends the exact output schema through its native enforcement mechanism', async () => {
  const f = anthropicFixture(); const file = f.credentials();
  try {
    const request = { model: 'claude-opus-5-5', input: 'answer', text };
    await new ClaudeAccount(f.options(file)).run(request);
    expect(f.messages()[0]!.body.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema } });
    expect(() => claudeOutputFormat({ text: { format: { type: 'json_object' } } })).toThrow('Unsupported Claude text.format');
  } finally { f.stop(); await rm(dirname(file), { recursive: true, force: true }); }
});

test('Grok forwards its Responses structured-output contract without weakening the schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-output-format-'));
  let sent: JsonRecord | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    sent = await req.json() as JsonRecord;
    return new Response(frame({ type: 'response.completed', response: { status: 'completed', output: [] } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const origin = String(server.url).replace(/\/$/, '');
  try {
    await Bun.write(join(root, 'auth.json'), JSON.stringify({ [`${origin}::client`]: { key: 'fixture', refresh_token: 'fixture-refresh', expires_at: new Date(Date.now() + 3600000).toISOString() } }));
    await createGrokBackend({ home: root, baseUrl: origin, issuer: origin }).run({ model: 'grok-4.7', input: 'answer', text });
    expect(sent?.text).toEqual(text);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test('Cursor rejects schemas before starting an SDK run', async () => {
  const f = await scriptedCursor();
  try {
    await expect(f.backend.run({ model: 'kimi-k3', input: 'answer', text })).rejects.toThrow('Unsupported Cursor text.format');
    expect(f.count('send')).toBe(0);
  } finally { await f.backend.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('invalid structured output is terminal without replay; tool turns and incomplete replies retain their semantics', () => {
  expect(checkOutputFormat({ text }, answer()).status).toBeUndefined();
  for (const value of ['prose', '{}', '{"ok":false}', '{"ok":true,"extra":1}']) expect(checkOutputFormat({ text }, answer(value))).toMatchObject({ status: 'failed', error: { code: 'invalid_prompt' } });
  const tool = { ...answer('working'), toolCalls: [{ name: 'write', arguments: '{}' }] };
  expect(checkOutputFormat({ text }, tool)).toBe(tool);
  const incomplete: ProxyOutput = { ...answer('{"ok":'), status: 'incomplete', incompleteReason: 'max_output_tokens' };
  expect(checkOutputFormat({ text }, incomplete)).toBe(incomplete);
  expect(() => outputFormat({ text: { format: { type: 'json_schema' } } })).toThrow('Unsupported');
  expect(() => outputFormat({ text: { format: { type: 'made-up' } } })).toThrow('Unsupported');
});

test('a failed final schema cannot rerun an already streamed action', async () => {
  const backend = BACKENDS[0]!; const original = backend.run; let calls = 0;
  backend.run = async (_request, _signal, sink) => { calls++; sink?.call?.({ name: 'write', callId: 'c', arguments: '{}' }); sink?.text('bad final JSON'); return answer('bad final JSON'); };
  const app = await fixtureRouter();
  try {
    const response = await fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify({ model: Object.keys(backend.models)[0], input: 'answer', stream: true, text, tools: [{ type: 'function', name: 'write', parameters: { type: 'object' } }] }) });
    const body = await response.text();
    expect(body).toContain('response.failed'); expect(body).toContain('invalid_prompt'); expect(body).toContain('"call_id":"c"'); expect(calls).toBe(1);
  } finally { backend.run = original; await app.close(); }
});

test('unsupported formats and oversized syntax fail before foreign bridge work', async () => {
  let upstreamCalls = 0;
  const app = await fixtureRouter({ summaryKey: Buffer.alloc(32, 5), upstreamFetch: async () => { upstreamCalls++; throw new Error('bridge must not start'); } });
  try {
    for (const extra of [{ text: { format: { type: 'json_object' } } }, { tools: [{ type: 'custom', name: 'raw', format: { type: 'grammar', syntax: 'lark', definition: 'x'.repeat(17000) } }] }]) {
      const response = await fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify({ model: 'claude-opus-5-5', input: [{ type: 'compaction', encrypted_content: 'gAAAA-foreign' }], ...extra }) });
      expect(response.status).toBe(400); expect(await response.text()).toContain('Unsupported');
    }
    expect(upstreamCalls).toBe(0);
  } finally { await app.close(); }
});

test('known quota fallback refuses an unsupported schema before restoration or generation', () => {
  let generations = 0;
  const primary = { ...BACKENDS[0]!, models: { 'team-opus': 'claude-opus-5-5' }, assertAvailable() { throw new ClaudeUsageLimitError(); }, async run() { generations++; return answer(); } };
  const fallback = { ...BACKENDS[0]!, assertRequestControls() { throw new BackendError('Unsupported Cursor text.format'); }, async run() { generations++; return answer(); } };
  const wrapped = withOpusQuotaFallback(primary, fallback);
  expect(() => wrapped.assertRequestControls?.({ model: 'team-opus', input: [], text })).toThrow('Unsupported Cursor text.format');
  expect(generations).toBe(0);
});

test('required raw syntax survives long prose, and an unrepresentable grammar is explicitly refused', () => {
  const definition = 'start: "EXACT_TOKEN_REQUIRED"';
  const descriptor = { type: 'custom' as const, proxyName: 'raw', name: 'raw', description: 'd'.repeat(17000), contract: { type: 'grammar', syntax: 'lark', definition } };
  const tool = functionTools([descriptor]).definitions.raw!;
  expect(tool.description).toContain(definition); expect(tool.description).toContain('Pass the complete raw input'); expect(tool.description.length).toBeLessThanOrEqual(16384);
  expect(() => functionTools([{ ...descriptor, contract: { definition: 'x'.repeat(17000) } }])).toThrow('Unsupported tool contract');
  const union = functionTools([{ type: 'function', proxyName: 'pick', name: 'pick', contract: { description: 'd'.repeat(9000), oneOf: [{ properties: { a: { type: 'string' } } }, { properties: { b: { type: 'string' } } }] } }]).definitions.pick!;
  expect(String(union.inputSchema.description)).toContain('original oneOf contract');
  // Anthropic refuses a top-level union key whatever its value, so malformed ones are dropped too.
  for (const contract of [{ anyOf: {} }, { oneOf: null, properties: { a: { type: 'string' } } }, { allOf: 'x' }]) {
    const schema = functionTools([{ type: 'function', proxyName: 'odd', name: 'odd', contract }]).definitions.odd!.inputSchema;
    expect(['anyOf', 'oneOf', 'allOf'].filter(key => Object.hasOwn(schema, key))).toEqual([]);
    expect(schema.type).toBe('object');
  }
});

test('prototype-named tools and union properties remain declared data', () => {
  const properties: unknown = JSON.parse('{"__proto__":{"type":"string"}}');
  const { definitions, byKey } = functionTools([{ type: 'function', proxyName: '__proto__', name: '__proto__', contract: { type: 'object', anyOf: [{ properties, required: ['__proto__'], additionalProperties: false }] } }]);
  expect([...byKey.keys()]).toEqual(['__proto__']);
  expect(Object.keys(definitions)).toEqual(['__proto__']);
  expect(Object.getPrototypeOf(definitions)).toBeNull();
  const wire: unknown = JSON.parse(JSON.stringify(definitions));
  expect(isRecord(wire) && isRecord(wire.__proto__) && wire.__proto__.inputSchema).toMatchObject({ properties: JSON.parse('{"__proto__":{"type":"string"}}'), required: ['__proto__'] });
  expect(Object.getPrototypeOf(definitions.__proto__!.inputSchema.properties)).toBeNull();
});

test('large primitive uniqueness checks keep JSON equality without exhausting pairwise work', () => {
  const schema = { type: 'array', uniqueItems: true };
  const values = Array.from({ length: 1000 }, (_, i) => i);
  expect(toolSchemaIssue(values, schema)).toBeUndefined();
  expect(toolSchemaIssue([...values, 0], schema)).toContain('must contain unique items');
  expect(toolSchemaIssue([0, '0', false, null, true, 'false'], schema)).toBeUndefined();
  expect(toolSchemaIssue([0, -0], schema)).toContain('must contain unique items');
  expect(toolSchemaIssue([{ a: 1, b: [2] }, { b: [2], a: 1 }], schema)).toContain('must contain unique items');
  expect(toolSchemaIssue([1, '1', [1], { 0: 1 }, null], schema)).toBeUndefined();
  expect(toolSchemaIssue(Array.from({ length: 1000 }, (_, i) => ({ i })), schema)).toContain('schema validation budget');
  const output = checkOutputFormat({ text: { format: { type: 'json_schema', schema } } }, answer(JSON.stringify(values)));
  expect(output.status).not.toBe('failed');
});

test('schema string lengths count Unicode code points including lone surrogates', () => {
  for (const [value, length] of [['', 0], ['abc', 3], ['😀', 1], ['a😀b', 3], ['\ud800', 1], ['\udc00', 1], ['\ud800a', 2], ['\udc00\ud800', 2]] as const) {
    expect(toolSchemaIssue(value, { type: 'string', minLength: length, maxLength: length })).toBeUndefined();
    expect(toolSchemaIssue(value, { minLength: length + 1 })).toContain('shorter than its minimum length');
    if (length) expect(toolSchemaIssue(value, { maxLength: length - 1 })).toContain('exceeds its maximum length');
  }
});

test('local schema references resolve URI-fragment pointers through own objects and arrays', () => {
  const definitions: unknown = JSON.parse('{"a/b~c":{"anyOf":[{"type":"string"},{"type":"number"}]},"foo bar":{"type":"boolean"},"%2F":{"type":"null"},"__proto__":{"type":"integer"}}');
  const contract = ($ref: string) => ({ $defs: definitions, $ref });
  const string = contract('#/$defs/a~1b~0c/anyOf/0');
  expect(toolSchemaIssue('text', string)).toBeUndefined();
  expect(toolSchemaIssue(1, string)).toContain('wrong value type');
  expect(toolSchemaIssue(true, contract('#/$defs/foo%20bar'))).toBeUndefined();
  expect(toolSchemaIssue(null, contract('#/$defs/%252F'))).toBeUndefined();
  expect(toolSchemaIssue(1, contract('#/$defs/__proto__'))).toBeUndefined();
  expect(toolSchemaIssue(false, { $defs: { forbidden: false }, $ref: '#/$defs/forbidden' })).toContain('not allowed');
  for (const reference of ['#/$defs/a~1b~0c/anyOf/01', '#/$defs/a~1b~0c/anyOf/-', '#/$defs/a~1b~0c/anyOf/length', '#/$defs/a~1b~0c/anyOf/2', '#/$defs/toString', '#/$defs/constructor', '#/$defs/bad~2escape', '#/$defs/bad~', '#/$defs/%FF', '#/$defs/%', '#named-anchor', 'https://example.com/schema']) {
    expect(toolSchemaIssue('text', contract(reference))).toContain('unresolved schema reference');
  }
});

for (const stream of [false, true]) test('HTTP GPT history supports same-provider and switched-provider continuations, stream=' + stream, async () => {
  const upstreamBodies: ResponsesBody[] = [], localBodies: ResponsesRequest[] = [];
  const backend = BACKENDS[0]!; const original = backend.run;
  backend.run = async request => { localBodies.push(request); return answer('local reply'); };
  const app = await fixtureRouter({ upstreamFetch: async (_url, init) => {
    const body = JSON.parse(String(init.body)) as ResponsesBody; upstreamBodies.push(body);
    const response = { ...responseObject(body, answer('FIRST_KEPT')), id: 'http_' + upstreamBodies.length };
    return stream ? streamResponse(response) : Response.json(response);
  } });
  const send = (body: ResponsesBody) => fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(body) });
  try {
    const first = await send({ model: 'gpt-6.1-sol', input: 'original', stream }); expect(first.status).toBe(200); await first.text();
    const second = await send({ model: 'gpt-6.1-sol', previous_response_id: 'http_1', input: 'next', stream }); expect(second.status).toBe(200); await second.text();
    const switched = await send({ model: Object.keys(backend.models)[0], previous_response_id: 'http_2', input: 'switch' }); expect(switched.status).toBe(200); await switched.text();
    expect(JSON.stringify(upstreamBodies[1]?.input)).toContain('FIRST_KEPT'); expect(upstreamBodies[1]?.previous_response_id).toBeUndefined();
    expect(JSON.stringify(localBodies[0]?.input)).toContain('original'); expect(JSON.stringify(localBodies[0]?.input)).toContain('next'); expect(JSON.stringify(localBodies[0]?.input)).toContain('switch');
  } finally { backend.run = original; await app.close(); }
});

test('HTTP observer fills sparse terminal output, preserves errors, and does not eagerly drain a slow client', async () => {
  const seen: unknown[] = [];
  const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'kept' }] };
  const raw = frame({ type: 'response.output_item.done', item }) + frame({ type: 'response.completed', response: { id: 'sparse', status: 'completed', output: [] } });
  const response = observeResponse(new Response(raw, { headers: { 'content-type': 'text/event-stream', 'x-custom': 'kept' } }), value => seen.push(value));
  expect(await response.text()).toBe(raw); expect(seen).toEqual([{ id: 'sparse', status: 'completed', output: [item] }]); expect(response.headers.get('x-custom')).toBe('kept');
  const failed = new Response('raw quota error', { status: 429, headers: { 'retry-after': '30' } });
  expect(observeResponse(failed, () => { throw new Error('must not cache'); })).toBe(failed);
  let pulls = 0, cancelled = false;
  const slow = observeResponse(new Response(new ReadableStream<Uint8Array>({ pull(out) { pulls++; out.enqueue(new TextEncoder().encode(': heartbeat\n\n')); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }), () => {});
  await Bun.sleep(10); expect(pulls).toBeLessThanOrEqual(2); await slow.body!.cancel(); expect(cancelled).toBe(true);
});

test('failed HTTP terminals and bare DONE do not create successful history', async () => {
  const seen: unknown[] = [];
  for (const event of [{ type: 'response.failed', response: { id: 'failed', status: 'failed', output: [] } }, { type: 'response.incomplete', response: { id: 'cut', status: 'incomplete', output: [] } }]) await observeResponse(new Response(frame(event), { headers: { 'content-type': 'text/event-stream' } }), response => seen.push(response)).text();
  await observeResponse(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }), response => seen.push(response)).text();
  expect(seen).toEqual([]);
});

test('HTTP history observation releases upstream locks at EOF, error and cancellation', async () => {
  for (const outcome of ['eof', 'error', 'cancel']) {
    const source = new ReadableStream<Uint8Array>({ start(out) {
      if (outcome === 'eof') out.close();
      if (outcome === 'error') out.error(new Error('source error'));
    }, cancel() { return new Promise<void>(() => {}); } });
    const observed = observeResponse(new Response(source, { headers: { 'content-type': 'text/event-stream' } }), () => {});
    if (outcome === 'cancel') await observed.body!.cancel();
    else if (outcome === 'error') await expect(observed.text()).rejects.toThrow('source error');
    else await observed.text();
    expect(source.locked).toBe(false);
  }
});

test('sparse completion history follows output indexes when parallel items finish out of order', async () => {
  const first = { type: 'function_call', call_id: 'first', name: 'one', arguments: '{}' };
  const second = { type: 'function_call', call_id: 'second', name: 'two', arguments: '{}' };
  const seen: unknown[] = [];
  const raw = frame({ type: 'response.output_item.done', output_index: 1, item: second })
    + frame({ type: 'response.output_item.done', output_index: 0, item: first })
    + frame({ type: 'response.completed', response: { id: 'ordered', status: 'completed', output: [] } });
  const response = observeResponse(new Response(raw, { headers: { 'content-type': 'text/event-stream' } }), value => seen.push(value));
  expect(await response.text()).toBe(raw);
  expect(seen).toEqual([{ id: 'ordered', status: 'completed', output: [first, second] }]);
});

test('unindexed completed items cannot overwrite sparse or later indexed output', async () => {
  const known = { type: 'function_call', call_id: 'known', name: 'one', arguments: '{}' };
  const unknown = { type: 'function_call', call_id: 'unindexed', name: 'two', arguments: '{}' };
  for (const events of [
    [{ output_index: 1, item: known }, { item: unknown }],
    [{ item: unknown }, { output_index: 0, item: known }],
  ]) {
    const seen: unknown[] = [];
    const raw = events.map(event => frame({ type: 'response.output_item.done', ...event })).join('')
      + frame({ type: 'response.completed', response: { id: 'mixed', status: 'completed', output: [] } });
    await observeResponse(new Response(raw, { headers: { 'content-type': 'text/event-stream' } }), value => seen.push(value)).text();
    expect(seen).toEqual([{ id: 'mixed', status: 'completed', output: [known, unknown] }]);
  }
});

test('malformed text controls are refused consistently', () => {
  const malformed: unknown = { text: [] };
  expect(isRecord(malformed)).toBe(true);
  expect(() => outputFormat(malformed as { text: unknown })).toThrow('Unsupported text');
});
