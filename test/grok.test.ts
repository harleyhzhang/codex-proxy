// Grok over xAI's Responses endpoint against a scripted xAI, OAuth issuer and npm registry: the tool and
// history mapping, the login refresh it owns, and every refusal Codex can receive.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrokBackend } from '../src/backends/grok';
import type { JsonRecord } from '../src/json';
import { responseObject } from '../src/protocol/output';
import type { ResponsesRequest } from '../src/protocol/types';

type Seen = { path: string; headers: Record<string, string>; body: JsonRecord };
type Handler = (body: JsonRecord) => Response | Promise<Response>;
const seen: Seen[] = [];
let replies: Handler[] = [];
let refreshes = 0;
let refreshReply: () => Response = () => Response.json({ access_token: `access-${++refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 21600, token_type: 'Bearer' });
let latestVersion = '1.0.46';

const sse = (...events: JsonRecord[]) => new Response(events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const completed = (output: JsonRecord[], usage: JsonRecord = { input_tokens: 40, output_tokens: 5, input_tokens_details: { cached_tokens: 32 } }) =>
  sse({ type: 'response.created', response: { status: 'in_progress' } }, { type: 'response.completed', response: { status: 'completed', output, usage } });
const say = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req): Promise<Response> {
  const path = new URL(req.url).pathname;
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => { headers[key] = value; });
  if (path === '/.well-known/openid-configuration') return Response.json({ token_endpoint: `${origin}/oauth2/token` });
  if (path === '/oauth2/token') { const form = new URLSearchParams(await req.text()); seen.push({ path, headers, body: Object.fromEntries(form) }); return refreshReply(); }
  if (path === '/npm') return Response.json({ version: latestVersion });
  const body = await req.json() as JsonRecord;
  seen.push({ path, headers, body });
  if (headers['x-grok-client-version'] !== latestVersion) return Response.json({ code: 'upgrade-required', error: 'Client too old' }, { status: 426 });
  const handler = replies.shift();
  return handler ? handler(body) : completed([say('ok')]);
} });
const origin: string = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

function login(expiresInMs: number): string {
  const home = mkdtempSync(join(tmpdir(), 'grok-test-'));
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ [`${origin}::client`]: { key: 'access-0', refresh_token: 'refresh-0', expires_at: new Date(Date.now() + expiresInMs).toISOString(), email: 'grok@example.com', team_id: 'team' } }), { mode: 0o600 });
  return home;
}
const backend = (home: string) => createGrokBackend({ home, baseUrl: `${origin}/v1`, issuer: origin, versionUrl: `${origin}/npm` });
const responses = () => seen.filter(entry => entry.path === '/v1/responses');
const hello = (extra: Partial<ResponsesRequest> = {}): ResponsesRequest => ({ model: 'grok-4.7', input: [{ role: 'user', content: 'hello' }], ...extra });

beforeEach(() => {
  seen.length = 0; replies = []; refreshes = 0; latestVersion = '1.0.46';
  refreshReply = () => Response.json({ access_token: `access-${++refreshes}`, refresh_token: `refresh-${refreshes}`, expires_in: 21600, token_type: 'Bearer' });
});

const TOOLS: ResponsesRequest['tools'] = [
  { type: 'function', name: 'exec_command', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  { type: 'custom', name: 'apply_patch', description: 'Edit files', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
  { type: 'namespace', name: 'mcp__docs', tools: [{ type: 'function', name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } } } }] },
];

test('Codex tools go out as function tools and history keeps its shape; calls come back as the Codex tools they stand for', async () => {
  replies.push(() => completed([
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'xai-thoughts', summary: [] },
    say('working'),
    { type: 'function_call', call_id: 'call_x1', name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }) },
    { type: 'function_call', call_id: 'call_x2', name: 'mcp__docs_search', arguments: '{"q":"boron"}' },
  ]));
  const request: ResponsesRequest = { model: 'grok-4.7', instructions: 'Be brief.', reasoning: { effort: 'xhigh' }, tools: TOOLS, prompt_cache_key: 'thread-1', input: [
    { role: 'developer', content: [{ type: 'input_text', text: 'House rules.' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'Patch it' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
    { type: 'reasoning', encrypted_content: 'gAAAA-openai-only' },
    { id: 'msg_from_gpt', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Looking.' }] },
    { type: 'custom_tool_call', call_id: 'c0', name: 'apply_patch', input: '*** Begin Patch' },
    { type: 'custom_tool_call_output', call_id: 'c0', output: 'failed' },
    { type: 'function_call', call_id: 'c1', namespace: 'mcp__docs', name: 'search', arguments: '{"q":"a"}' },
    { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'shot' }, { type: 'input_image', image_url: 'data:image/png;base64,BBBB' }] },
  ] } as ResponsesRequest;
  const output = await backend(login(3_600_000)).run(request);

  const sent = responses()[0]!.body;
  expect(sent).toMatchObject({ model: 'grok-4.7', instructions: 'Be brief.', reasoning: { effort: 'xhigh' }, prompt_cache_key: 'thread-1', stream: true, store: false, parallel_tool_calls: true });
  expect((sent.tools as JsonRecord[]).map(tool => [tool.type, tool.name])).toEqual([['function', 'exec_command'], ['function', 'apply_patch'], ['function', 'mcp__docs_search']]);
  expect((sent.tools as JsonRecord[])[1]!.parameters).toMatchObject({ required: ['input'] });
  expect(sent.input).toEqual([
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'House rules.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Patch it' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] },
    { type: 'function_call', call_id: 'c0', name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' },
    { type: 'function_call_output', call_id: 'c0', output: 'failed' },
    { type: 'function_call', call_id: 'c1', name: 'mcp__docs_search', arguments: '{"q":"a"}' },
    { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'shot' }, { type: 'input_image', image_url: 'data:image/png;base64,BBBB' }] },
  ]);

  expect(output.text).toBe('working');
  expect(output.toolCalls).toEqual([
    { name: 'apply_patch', arguments: '*** Begin Patch\n*** End Patch', callId: 'call_x1' },
    { name: 'mcp__docs.search', arguments: '{"q":"boron"}', callId: 'call_x2' },
  ]);
  expect(output.usage).toEqual({ inputTokens: 40, outputTokens: 5, totalTokens: 45 });
  // The router renders them as Codex's own item types.
  expect(responseObject(request, output).output.map(item => [item.type, item.name ?? null, item.namespace ?? null])).toEqual([
    ['message', null, null], ['custom_tool_call', 'apply_patch', null], ['function_call', 'search', 'mcp__docs'],
  ]);
});

test('Grok reasoning is put back before its own calls on the next turn', async () => {
  const grok = backend(login(3_600_000));
  replies.push(() => completed([{ type: 'reasoning', id: 'rs_1', encrypted_content: 'xai-thoughts', summary: [] }, { type: 'function_call', call_id: 'call_r', name: 'exec_command', arguments: '{"cmd":"ls"}' }]));
  const first = hello({ tools: TOOLS });
  const output = await grok.run(first);
  const next = { ...first, input: [...(first.input as JsonRecord[]), ...responseObject(first, output).output, { type: 'function_call_output', call_id: 'call_r', output: 'a b' }] } as ResponsesRequest;
  await grok.run(next);
  const input = responses()[1]!.body.input as JsonRecord[];
  expect(input.map(item => item.type)).toEqual(['message', 'reasoning', 'function_call', 'function_call_output']);
  expect(input[1]).toMatchObject({ encrypted_content: 'xai-thoughts' });
});

test('an expiring login refreshes once for concurrent turns and writes the rotated tokens back, keeping other fields', async () => {
  const home = login(60_000);
  const grok = backend(home);
  await Promise.all([grok.run(hello()), grok.run(hello())]);
  expect(seen.filter(entry => entry.path === '/oauth2/token')).toHaveLength(1);
  expect(seen.find(entry => entry.path === '/oauth2/token')!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-0' });
  expect(responses().map(entry => entry.headers.authorization)).toEqual(['Bearer access-1', 'Bearer access-1']);
  const stored = Object.values(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')))[0] as JsonRecord;
  expect(stored).toMatchObject({ key: 'access-1', refresh_token: 'refresh-1', email: 'grok@example.com', team_id: 'team' });
  expect(Date.parse(String(stored.expires_at)) - Date.now()).toBeGreaterThan(21_000_000);
  expect(statSync(join(home, 'auth.json')).mode & 0o777).toBe(0o600);
  // A valid token is used as is.
  await grok.run(hello());
  expect(refreshes).toBe(1);
});

test('a 401 refreshes and retries once; a rejected refresh tells the user to sign in again', async () => {
  const home = login(3_600_000);
  replies.push(() => Response.json({ error: 'expired' }, { status: 401 }));
  expect((await backend(home).run(hello())).text).toBe('ok');
  expect(responses().map(entry => entry.headers.authorization)).toEqual(['Bearer access-0', 'Bearer access-1']);

  refreshReply = () => Response.json({ error: 'invalid_grant' }, { status: 400 });
  await expect(backend(login(0)).run(hello())).rejects.toThrow(/signed out.*grok login/);
  await expect(backend(mkdtempSync(join(tmpdir(), 'grok-empty-'))).run(hello())).rejects.toThrow(/signed out/);
});

test('a server that rejects the client version is retried with the current Grok Build version', async () => {
  latestVersion = '1.0.52';
  expect((await backend(login(3_600_000)).run(hello())).text).toBe('ok');
  expect(responses().map(entry => [entry.headers['x-grok-client-version'], entry.headers['user-agent']])).toEqual([['1.0.46', 'xai-grok-workspace/1.0.46'], ['1.0.52', 'xai-grok-workspace/1.0.52']]);
});

test('refusals reach Codex with the code it acts on', async () => {
  const grok = backend(login(3_600_000));
  replies.push(() => Response.json({ code: 'invalid-argument', error: 'Failed to start sampling: [input_too_large] The prompt is too long for this model\'s context window' }, { status: 400 }));
  await expect(grok.run(hello())).rejects.toMatchObject({ code: 'context_length_exceeded' });
  replies.push(() => Response.json({ error: 'Rate limit exceeded' }, { status: 429 }));
  await expect(grok.run(hello())).rejects.toThrow('Grok usage limit reached: Rate limit exceeded');
  replies.push(() => Response.json({ error: 'overloaded' }, { status: 503 }));
  await expect(grok.run(hello())).rejects.toMatchObject({ code: 'server_is_overloaded' });
  replies.push(() => Response.json({ error: 'The model does not exist' }, { status: 404 }));
  await expect(grok.run(hello())).rejects.toThrow('xAI HTTP 404: The model does not exist');
  await expect(grok.run(hello({ reasoning: { effort: 'max' } }))).rejects.toThrow('Unsupported Grok reasoning effort');
});

test('a 5xx is retried like native Codex, and a stream that fails after opening gets one fresh attempt', async () => {
  const grok = backend(login(3_600_000));
  replies.push(() => new Response('{}', { status: 500 }), () => new Response('{}', { status: 502 }));
  expect((await grok.run(hello())).text).toBe('ok');
  expect(responses()).toHaveLength(3);
  seen.length = 0;
  replies.push(() => sse({ type: 'response.failed', response: { error: { message: 'sampler crashed' } } }));
  expect((await grok.run(hello())).text).toBe('ok');
  expect(responses()).toHaveLength(2);
  replies.push(() => sse({ type: 'response.failed', response: { error: { message: 'prompt is too long' } } }));
  await expect(grok.run(hello())).rejects.toMatchObject({ code: 'context_length_exceeded' });
});

test('a stream that ends without a terminal event is a dropped connection, and silence trips the idle timeout', async () => {
  const grok = backend(login(3_600_000));
  replies.push(() => sse({ type: 'response.created', response: {} }));
  await expect(grok.run(hello())).rejects.toMatchObject({ name: 'ProxyTransportError', reconnectable: true });
  const saved = process.env.GROK_TIMEOUT_MS;
  process.env.GROK_TIMEOUT_MS = '150';
  try {
    replies.push(() => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } }));
    const failure = await grok.run(hello()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    // The router reads a TimeoutError as a timed-out connection, which Codex retries.
    expect((failure as Error).name).toBe('TimeoutError');
  } finally { if (saved === undefined) delete process.env.GROK_TIMEOUT_MS; else process.env.GROK_TIMEOUT_MS = saved; }
});

test('the catalog row advertises images and the real 500K window', () => {
  expect(backend(login(0)).catalog).toEqual([expect.objectContaining({ slug: 'grok-4.7', inputModalities: ['text', 'image'], contextWindow: 500_000, efforts: ['low', 'medium', 'high', 'xhigh'] })]);
});

test('xAI text deltas stream through the sink, and a stream failure after text is not retried', async () => {
  const grok = backend(login(3_600_000));
  const deltas: string[] = [];
  const sink = { text: (delta: string) => { deltas.push(delta); }, get started() { return deltas.length > 0; } };
  replies.push(() => sse({ type: 'response.output_text.delta', delta: 'Hel' }, { type: 'response.output_text.delta', delta: 'lo' }, { type: 'response.completed', response: { status: 'completed', output: [say('Hello')], usage: {} } }));
  expect((await grok.run(hello(), undefined, sink)).text).toBe('Hello');
  expect(deltas).toEqual(['Hel', 'lo']);
  seen.length = 0;
  replies.push(() => sse({ type: 'response.output_text.delta', delta: 'x' }, { type: 'response.failed', response: { error: { message: 'sampler crashed' } } }));
  await expect(grok.run(hello(), undefined, sink)).rejects.toThrow('sampler crashed');
  expect(responses()).toHaveLength(1);
});

test('Grok asks for a reasoning summary; it streams as thinking and each finished call reaches the sink at once', async () => {
  const grok = backend(login(3_600_000));
  const seen: string[] = [];
  const sink = { started: false, text(delta: string) { seen.push(`text:${delta}`); }, reasoning(delta: string) { seen.push(`thinking:${delta}`); }, call(call: { name: string; arguments: string; callId?: string }) { seen.push(`call:${call.name}:${call.arguments}:${call.callId}`); } };
  const call = { type: 'function_call', call_id: 'call_g1', name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch' }) };
  replies.push(() => sse(
    { type: 'response.reasoning_summary_text.delta', delta: 'Checking.' },
    { type: 'response.output_item.done', item: call },
    { type: 'response.completed', response: { status: 'completed', output: [call], usage: {} } },
  ));
  const output = await grok.run(hello({ tools: TOOLS }), undefined, sink);
  expect(responses()[0]!.body.reasoning).toEqual({ effort: 'high', summary: 'auto' });
  expect(seen).toEqual(['thinking:Checking.', 'call:apply_patch:*** Begin Patch:call_g1']);
  expect(output.toolCalls).toEqual([{ name: 'apply_patch', arguments: '*** Begin Patch', callId: 'call_g1' }]);
});
