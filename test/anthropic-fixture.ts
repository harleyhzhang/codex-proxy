// A scripted Anthropic for Claude tests: the Messages stream, the OAuth profile and token endpoints, and a
// Claude Code credential file. Replies are queued per test; without one, a turn gets `reply` (`CLAUDE_OK`).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonRecord } from '../src/json';

export type Seen = { path: string; headers: Record<string, string>; body: JsonRecord };
type Handler = (body: JsonRecord) => Response | Promise<Response>;

/** A Messages SSE stream holding these content blocks, streamed the way Anthropic streams them. */
export function anthropicStream(blocks: JsonRecord[], stop = 'end_turn', usage: JsonRecord = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 }, headers: Record<string, string> = {}): Response {
  const events: JsonRecord[] = [{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage } }];
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'text') {
      const text = String(block.text);
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const piece of [text.slice(0, 3), text.slice(3)]) if (piece) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
    } else if (block.type === 'tool_use') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else if (block.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    }
    events.push({ type: 'content_block_stop', index });
  }
  events.push({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: usage.output_tokens } }, { type: 'message_stop' });
  return new Response(events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', ...headers } });
}

export const say = (text: string) => anthropicStream([{ type: 'text', text }]);

/** Headers Anthropic sends when the five-hour allowance is used up until `resetsAt` (epoch seconds). */
export const limitHeaders = (resetsAt: number) => ({
  'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-5h-utilization': '1', 'anthropic-ratelimit-unified-5h-reset': String(resetsAt),
});

export function anthropicFixture(identity: { email: string; org: string } = { email: 'work@example.com', org: 'org_work' }) {
  const state = {
    seen: [] as Seen[],
    replies: [] as Handler[],
    reply: (() => say('CLAUDE_OK')) as Handler,
    refreshes: 0,
    profile: (): Response => Response.json({ account: { uuid: 'acct', email: identity.email }, organization: { uuid: identity.org } }),
    refresh: (): Response => Response.json({ access_token: `access-${state.refreshes}`, refresh_token: `refresh-${state.refreshes}`, expires_in: 28_800 }),
    profileDelayMs: 0,
  };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req): Promise<Response> {
    const path = new URL(req.url).pathname;
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => { headers[key] = value; });
    const body = req.method === 'POST' ? await req.json() as JsonRecord : {};
    state.seen.push({ path, headers, body });
    if (path === '/api/oauth/profile') { if (state.profileDelayMs) await Bun.sleep(state.profileDelayMs); return state.profile(); }
    if (path === '/v1/oauth/token') { state.refreshes++; return state.refresh(); }
    return (state.replies.shift() ?? state.reply)(body);
  } });
  const url = `http://127.0.0.1:${server.port}`;
  /** A Claude Code credential file whose access token expires in `expiresInMs`. */
  const credentials = (expiresInMs = 3_600_000): string => {
    const file = join(mkdtempSync(join(tmpdir(), 'claude-login-')), '.credentials.json');
    writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'access-0', refreshToken: 'refresh-0', expiresAt: Date.now() + expiresInMs, scopes: ['user:inference'], subscriptionType: 'max' } }), { mode: 0o600 });
    return file;
  };
  const messages = () => state.seen.filter(entry => entry.path === '/v1/messages');
  return { state, url, credentials, messages, options: (file = credentials()) => ({ apiUrl: url, tokenUrl: `${url}/v1/oauth/token`, credentialsFile: file }), stop: () => server.stop(true) };
}
