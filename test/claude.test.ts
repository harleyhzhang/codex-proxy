// Claude over Anthropic's Messages API against a scripted Anthropic: the request and history mapping,
// the login refresh and identity pin it owns, streaming, and every refusal Codex can receive.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { ClaudeAccount, claudeBackend, claudeMessages, resolveModel } from '../src/backends/claude';
import { ClaudeUsageLimitError } from '../src/backends/claude-limits';
import { type BackendError, estimateVisibleTokens } from '../src/backends/contract';
import type { JsonRecord } from '../src/json';
import type { ResponsesRequest } from '../src/protocol/types';
import { compactRequest } from '../src/router/capsule';
import { ProxyTransportError } from '../src/transport';
import { anthropicFixture, anthropicStream, limitHeaders } from './anthropic-fixture';

const anthropic = anthropicFixture();
const defaults = { profile: anthropic.state.profile, refresh: anthropic.state.refresh, reply: anthropic.state.reply };
afterAll(() => anthropic.stop());
beforeEach(() => {
  anthropic.state.seen.length = 0; anthropic.state.replies.length = 0; anthropic.state.refreshes = 0;
  Object.assign(anthropic.state, defaults, { profileDelayMs: 0 });
});

const account = (options: { expiresInMs?: number; expectedEmail?: string; expectedOrg?: string } = {}) => {
  const file = anthropic.credentials(options.expiresInMs);
  return { file, account: new ClaudeAccount({ ...anthropic.options(file), expectedEmail: options.expectedEmail, expectedOrg: options.expectedOrg }) };
};
const hello = (extra: Partial<ResponsesRequest> = {}): ResponsesRequest => ({ model: 'claude-opus-5-5', input: [{ role: 'user', content: 'hello' }], ...extra });
const sent = (index = 0) => anthropic.messages()[index]!.body;
const events = (...list: JsonRecord[]) => new Response(list.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const streamError = { type: 'error', error: { type: 'api_error', message: 'boom' } };
const TOOLS: ResponsesRequest['tools'] = [
  { type: 'function', name: 'exec_command', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  { type: 'custom', name: 'apply_patch', description: 'Edit files', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
  { type: 'namespace', name: 'mcp__docs', tools: [{ type: 'function', name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } } } }] },
];

test('Codex tools go out as Claude tools with the client identity; calls come back as the Codex tools they stand for', async () => {
  anthropic.state.replies.push(() => anthropicStream([
    { type: 'text', text: 'working' },
    { type: 'tool_use', id: 'toolu_1', name: 'apply_patch', input: { input: '*** Begin Patch\n*** End Patch' } },
    { type: 'tool_use', id: 'toolu_2', name: 'mcp__docs_search', input: { q: 'boron' } },
  ], 'tool_use', { input_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 7 }));
  const output = await account().account.run(hello({ instructions: 'Be brief.', reasoning: { effort: 'xhigh' }, tools: TOOLS }));

  const { headers, body } = anthropic.messages()[0]!;
  expect(headers.authorization).toBe('Bearer access-0');
  expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
  expect(headers['x-app']).toBe('cli');
  expect(headers['user-agent']).toStartWith('claude-cli/');
  expect(body).toMatchObject({ model: 'claude-opus-5-5', stream: true, thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } });
  const system = body.system as JsonRecord[];
  expect(String(system[0]!.text)).toStartWith('You are Claude Code');
  expect(String(system[1]!.text)).toEndWith('Be brief.');
  expect(system[1]!.cache_control).toEqual({ type: 'ephemeral' });
  const tools = body.tools as JsonRecord[];
  expect(tools.map(tool => tool.name)).toEqual(['exec_command', 'apply_patch', 'mcp__docs_search']);
  expect(tools[1]!.input_schema).toMatchObject({ required: ['input'] });
  expect(tools[2]!.cache_control).toEqual({ type: 'ephemeral' });

  expect(output.text).toBe('working');
  expect(output.toolCalls).toEqual([
    { name: 'apply_patch', arguments: '*** Begin Patch\n*** End Patch', callId: 'toolu_1' },
    { name: 'mcp__docs.search', arguments: '{"q":"boron"}', callId: 'toolu_2' },
  ]);
  // The prompt Claude held: uncached input plus cache writes and reads.
  expect(output.usage).toEqual({ inputTokens: 125, outputTokens: 7, totalTokens: 132 });
});

test('a forced tool choice turns thinking off; aliases resolve and unknown efforts are refused', async () => {
  const { account: claude } = account();
  await claude.run(hello({ tools: TOOLS, tool_choice: 'required' }));
  expect(sent()).toMatchObject({ tool_choice: { type: 'any' } });
  expect(sent().thinking).toBeUndefined();
  await claude.run(hello({ tools: TOOLS, tool_choice: { type: 'function', name: 'exec_command' } as never }));
  expect(sent(1)).toMatchObject({ tool_choice: { type: 'tool', name: 'exec_command' } });
  expect(['opus', 'sonnet', 'haiku', 'claude-fable-5-1'].map(model => claudeBackend.models[model])).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
  expect(() => resolveModel('gpt-6')).toThrow('Unsupported Claude model');
  await expect(claude.run(hello({ reasoning: { effort: 'ultra' } }))).rejects.toThrow('Unsupported Claude reasoning effort');
  expect(estimateVisibleTokens('hello')).toBe(2);
});

test('history keeps its structure and every call is answered exactly once in the next turn', () => {
  const keyFor = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_');
  const turns = claudeMessages({ model: 'claude-opus-5-5', input: [
    { type: 'function_call', call_id: 'orphan_first', name: 'exec_command', arguments: '{"cmd":"ls"}' },
    { role: 'developer', content: [{ type: 'input_text', text: 'House rules.' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'Patch it' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
    { type: 'reasoning', encrypted_content: 'gAAAA-openai-only' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] },
    { type: 'custom_tool_call', call_id: 'c0', name: 'apply_patch', input: '*** Begin Patch' },
    { type: 'function_call', call_id: 'c1', namespace: 'mcp__docs', name: 'search', arguments: '{"q":"a"}' },
    { type: 'custom_tool_call_output', call_id: 'c0', output: 'failed' },
    { role: 'user', content: 'interjection' },
    { type: 'function_call_output', call_id: 'stray', output: 'late' },
  ] } as ResponsesRequest, keyFor);
  expect(turns.map(turn => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  // A history that opens with a call gets a user turn in front, and the call is answered as unfinished.
  expect(turns[0]!.content).toEqual([{ type: 'text', text: '(earlier conversation)' }]);
  expect(turns[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'orphan_first' });
  expect(turns[2]!.content.slice(1)).toEqual([
    { type: 'text', text: '<developer>\nHouse rules.\n</developer>' },
    { type: 'text', text: 'Patch it' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ]);
  expect(turns[3]!.content).toEqual([
    { type: 'text', text: 'Looking.' },
    { type: 'tool_use', id: 'c0', name: 'apply_patch', input: { input: '*** Begin Patch' } },
    { type: 'tool_use', id: 'c1', name: 'mcp__docs_search', input: { q: 'a' } },
  ]);
  // Results lead the next turn (one per call, the missing one marked unfinished); a stray result is text.
  const last = turns[4]!.content;
  expect(last.slice(0, 2).map(block => [block.type, block.tool_use_id])).toEqual([['tool_result', 'c0'], ['tool_result', 'c1']]);
  expect(JSON.stringify(last[1])).toContain('did not finish');
  expect(last.slice(2).map(block => block.text)).toEqual(['interjection', '<tool_result call_id="stray">', 'late', '</tool_result>']);
});

test('Claude thinking returns in front of its own calls on the next turn', async () => {
  const { account: claude } = account();
  anthropic.state.replies.push(() => anthropicStream([
    { type: 'thinking', thinking: 'plan the listing', signature: 'sig-1' },
    { type: 'tool_use', id: 'toolu_9', name: 'exec_command', input: { cmd: 'ls' } },
  ], 'tool_use'));
  const first = await claude.run(hello({ tools: TOOLS }));
  const call = first.toolCalls[0]!;
  await claude.run(hello({ tools: TOOLS, input: [
    { role: 'user', content: 'hello' },
    { type: 'function_call', call_id: call.callId, name: call.name, arguments: call.arguments },
    { type: 'function_call_output', call_id: call.callId, output: 'a.txt' },
  ] }));
  const assistant = (sent(1).messages as JsonRecord[])[1]!.content as JsonRecord[];
  expect(assistant.map(block => block.type)).toEqual(['thinking', 'tool_use']);
  expect(assistant[0]).toEqual({ type: 'thinking', thinking: 'plan the listing', signature: 'sig-1' });
});

test('thinking, text and each finished call reach the sink as Claude writes them', async () => {
  const seen: string[] = [];
  const sink = {
    started: false,
    text(delta: string) { seen.push(`text:${delta}`); this.started = true; },
    reasoning(delta: string) { seen.push(`thinking:${delta}`); },
    call(call: { name: string; callId?: string }) { seen.push(`call:${call.name}:${call.callId}`); this.started = true; },
  };
  anthropic.state.replies.push(() => anthropicStream([
    { type: 'thinking', thinking: 'list first', signature: 'sig' },
    { type: 'text', text: 'streamed answer' },
    { type: 'tool_use', id: 'toolu_a', name: 'exec_command', input: { cmd: 'ls' } },
    { type: 'tool_use', id: 'toolu_b', name: 'mcp__docs_search', input: { q: 'x' } },
  ], 'tool_use'));
  const output = await account().account.run(hello({ tools: TOOLS }), undefined, sink);
  expect(seen).toEqual(['thinking:list first', 'text:str', 'text:eamed answer', 'call:exec_command:toolu_a', 'call:mcp__docs.search:toolu_b']);
  expect(output.text).toBe('streamed answer');
  expect(output.toolCalls.map(call => call.callId)).toEqual(['toolu_a', 'toolu_b']);
});

test('a compaction keeps the tools, system prompt and history prefix of the turns before it, so it reads them from cache', async () => {
  const { account: claude } = account();
  const turn = hello({ tools: TOOLS, instructions: 'Be brief.', input: [
    { role: 'user', content: 'list files' },
    { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'a.txt' },
  ] });
  await claude.run(turn);
  await claude.run(compactRequest(turn) as ResponsesRequest);
  const uncached = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === 'cache_control' ? undefined : item));
  const [normal, compaction] = [sent(0), sent(1)];
  expect(uncached(compaction.tools)).toEqual(uncached(normal.tools));
  expect(uncached(compaction.system)).toEqual(uncached(normal.system));
  const before = uncached(normal.messages) as JsonRecord[];
  const after = uncached(compaction.messages) as JsonRecord[];
  expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
  expect((after.at(-1)!.content as JsonRecord[]).slice(0, (before.at(-1)!.content as JsonRecord[]).length)).toEqual(before.at(-1)!.content as JsonRecord[]);
  expect(compaction).toMatchObject({ tool_choice: { type: 'none' }, thinking: normal.thinking });
});

test('an expiring login is refreshed once for concurrent turns and the rotated login is written back', async () => {
  const { file, account: claude } = account({ expiresInMs: 60_000 });
  await Promise.all([claude.run(hello()), claude.run(hello())]);
  expect(anthropic.state.refreshes).toBe(1);
  const refresh = anthropic.state.seen.find(entry => entry.path === '/v1/oauth/token')!.body;
  expect(refresh).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-0' });
  expect(anthropic.messages().map(entry => entry.headers.authorization)).toEqual(['Bearer access-1', 'Bearer access-1']);
  const stored = JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth;
  expect(stored).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1', subscriptionType: 'max' });
  expect(stored.expiresAt).toBeGreaterThan(Date.now() + 7 * 3_600_000);
});

test('a token Anthropic rejects is refreshed once; a rejected refresh or missing login asks for a new sign-in', async () => {
  const { account: claude } = account();
  anthropic.state.replies.push(() => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'expired' } }, { status: 401 }));
  expect((await claude.run(hello())).text).toBe('CLAUDE_OK');
  expect(anthropic.messages().map(entry => entry.headers.authorization)).toEqual(['Bearer access-0', 'Bearer access-1']);

  anthropic.state.refresh = () => Response.json({ error: 'invalid_grant' }, { status: 400 });
  await expect(account({ expiresInMs: 0 }).account.run(hello())).rejects.toThrow('claude auth login');
  expect(anthropic.messages()).toHaveLength(2);

  await expect(new ClaudeAccount(anthropic.options('/nonexistent/.credentials.json')).run(hello())).rejects.toThrow('not logged in');
  expect(anthropic.messages()).toHaveLength(2);
});

test('the pinned identity is checked once per token and a mismatch refuses before any generation', async () => {
  const { account: right } = account({ expectedEmail: 'work@example.com', expectedOrg: 'org_work' });
  await right.run(hello()); await right.run(hello());
  expect(anthropic.state.seen.filter(entry => entry.path === '/api/oauth/profile')).toHaveLength(1);
  for (const pins of [{ expectedEmail: 'other@example.com' }, { expectedOrg: 'org_other' }]) {
    await expect(account(pins).account.run(hello())).rejects.toThrow('identity does not match');
    expect(anthropic.messages()).toHaveLength(2);
  }
});

test('cancelling during the identity check stops the turn before generation', async () => {
  anthropic.state.profileDelayMs = 2_000;
  const controller = new AbortController();
  const started = Date.now();
  const pending = account({ expectedEmail: 'work@example.com' }).account.run(hello(), controller.signal);
  await Bun.sleep(30); controller.abort(new Error('cancelled'));
  await expect(pending).rejects.toThrow('cancelled');
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(anthropic.messages()).toHaveLength(0);
});

test('a usage-limit refusal is recorded from the headers and gates the next turn without a request', async () => {
  const { account: claude } = account();
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  anthropic.state.replies.push(() => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }), { status: 429, headers: limitHeaders(resetsAt) }));
  const reported: unknown[] = [];
  claude.onRateLimit(info => reported.push(info));
  const refused = await claude.run(hello()).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ClaudeUsageLimitError);
  expect((refused as ClaudeUsageLimitError).resetsAt).toBe(resetsAt);
  expect(reported).toHaveLength(1);
  await expect(claude.run(hello())).rejects.toThrow('Claude session limit reached');
  expect(anthropic.messages()).toHaveLength(1);
});

test('overflow and overload are terminal with native codes; server errors retry like native Codex', async () => {
  const { account: claude } = account();
  const refuse = (status: number, message: string) => () => Response.json({ type: 'error', error: { type: 'x', message } }, { status });
  anthropic.state.replies.push(refuse(400, 'prompt is too long: 1200000 tokens > 1000000 maximum'));
  expect(await claude.run(hello()).catch((error: BackendError) => error.code)).toBe('context_length_exceeded');
  anthropic.state.replies.push(refuse(500, 'internal'), refuse(502, 'bad gateway'));
  expect((await claude.run(hello())).text).toBe('CLAUDE_OK');
  for (let index = 0; index < 5; index++) anthropic.state.replies.push(refuse(529, 'Overloaded'));
  expect(await claude.run(hello()).catch((error: BackendError) => error.code)).toBe('server_is_overloaded');
  expect(anthropic.messages()).toHaveLength(9);
  anthropic.state.replies.push(refuse(400, 'tools.0: bad schema'));
  await expect(claude.run(hello())).rejects.toThrow('Claude request refused (HTTP 400: tools.0: bad schema)');
}, 10_000);

test('a stream that fails before text gets one fresh attempt, never after text; a cut stream is a network drop; a cut tool call never runs', async () => {
  const { account: claude } = account();
  anthropic.state.replies.push(() => events(streamError));
  expect((await claude.run(hello())).text).toBe('CLAUDE_OK');
  expect(anthropic.messages()).toHaveLength(2);

  const sink = { started: false, text() { this.started = true; } };
  anthropic.state.replies.push(() => events(
    { type: 'message_start', message: { usage: {} } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }, streamError,
  ));
  await expect(claude.run(hello(), undefined, sink)).rejects.toThrow('Claude stream failed');
  expect(anthropic.messages()).toHaveLength(3);

  anthropic.state.replies.push(() => events({ type: 'message_start', message: { usage: {} } }));
  await expect(claude.run(hello())).rejects.toBeInstanceOf(ProxyTransportError);

  // The output limit cut the call off: its block never closed.
  const cutCall = () => events(
    { type: 'message_start', message: { usage: {} } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_x', name: 'exec_command', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":"rm -' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
  );
  anthropic.state.replies.push(cutCall, cutCall);
  await expect(claude.run(hello({ tools: TOOLS }))).rejects.toThrow('output limit in the middle of a tool call');
});

test('the login is read once and kept; a refused token re-reads the store and uses a new sign-in without refreshing', async () => {
  const { file, account: claude } = account();
  await claude.run(hello());
  const signIn = (token: string) => writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'refresh-new', expiresAt: Date.now() + 3_600_000 } }));
  signIn('access-new');
  await claude.run(hello());
  expect(anthropic.messages().map(entry => entry.headers.authorization)).toEqual(['Bearer access-0', 'Bearer access-0']);
  anthropic.state.replies.push(() => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'expired' } }, { status: 401 }));
  await claude.run(hello());
  expect(anthropic.messages().map(entry => entry.headers.authorization).slice(2)).toEqual(['Bearer access-0', 'Bearer access-new']);
  expect(anthropic.state.refreshes).toBe(0);
});
