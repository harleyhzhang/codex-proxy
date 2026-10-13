// End to end with the real `codex` binary: Codex -> this router -> a scripted OpenAI. Proves, by
// counting upstream attempts, that (1) the router absorbs a short 5xx burst so Codex never sees it,
// and (2) when the burst outlasts the router's budget, the real status reaches native Codex and
// Codex itself retries, so the chat still completes. Skipped when `codex` is not installed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureRouter } from './support';

const codexBin = Bun.which('codex');
const savedBase = process.env.UPSTREAM_RETRY_BASE_MS;
let home = '';

beforeAll(async () => {
  process.env.UPSTREAM_RETRY_BASE_MS = '1';
  home = await mkdtemp(join(tmpdir(), 'codex-e2e-home-'));
});
afterAll(async () => {
  if (savedBase === undefined) delete process.env.UPSTREAM_RETRY_BASE_MS; else process.env.UPSTREAM_RETRY_BASE_MS = savedBase;
  await rm(home, { recursive: true, force: true });
});

const sseAnswer = (text: string) => {
  const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: 'resp_1', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } };
  const events = [
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  return events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ sequence_number: i, ...e })}\n\n`).join('');
};

/** A scripted OpenAI that answers 507 for the first `failures` /responses calls, then streams an answer. */
function scriptedOpenAI(failures: number, answer: string) {
  const calls: string[] = [];
  const upstreamFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (!path.endsWith('/responses')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    const attempt = calls.filter(p => p.endsWith('/responses')).length;
    if (attempt <= failures) return new Response('', { status: 507 });
    void init;
    return new Response(sseAnswer(answer), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { calls, upstreamFetch };
}

async function runCodex(routerUrl: string, prompt: string): Promise<{ code: number; stdout: string; stderr: string }> {
  // Codex parses (but does not verify) the ID token for the account/plan claims.
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const idToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ email: 'fixture@example.com', exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_plan_type: 'pro', chatgpt_user_id: 'user_fixture' } })}.sig`;
  await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: idToken, access_token: 'fixture-token', refresh_token: 'fixture-refresh', account_id: 'fixture-account' }, last_refresh: new Date().toISOString() }));
  await writeFile(join(home, 'config.toml'), [
    'model = "gpt-6.1-sol"',
    'model_provider = "openai"',
    `openai_base_url = "${routerUrl.replace(/\/$/, '')}/v1"`,
    'preferred_auth_method = "chatgpt"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '[features]',
    'web_search_request = false',
  ].join('\n'));
  const proc = Bun.spawn([codexBin!, 'exec', '--skip-git-repo-check', '-C', home, prompt], {
    env: { ...process.env, CODEX_HOME: home, RUST_LOG: 'codex_core=debug,codex_api=debug', OPENAI_API_KEY: '' },
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const timer = setTimeout(() => proc.kill(), 90_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

describe.skipIf(!codexBin)('native Codex end to end through the router', () => {
  test('a short OpenAI 5xx burst is absorbed by the router; Codex never sees an error', async () => {
    const upstream = scriptedOpenAI(2, 'ABSORBED_BY_ROUTER');
    const app = await fixtureRouter({ upstreamFetch: upstream.upstreamFetch });
    try {
      const run = await runCodex(app.url('/'), 'Reply with exactly the word from the model.');
      expect(run.stdout + run.stderr).toContain('ABSORBED_BY_ROUTER');
      expect(upstream.calls.filter(p => p.endsWith('/responses')).length).toBe(3);
      // Word boundaries: debug-log timestamps such as `47.511507Z` contain the digits 507.
      expect(run.stderr).not.toMatch(/\b507\b|server_error/);
    } finally { await app.close(); }
  }, 120_000);

  test('a burst longer than the router budget surfaces the real 507 and native Codex retries it to completion', async () => {
    // Router tries 5 (1 + 4 retries) and fails them all; Codex retries; the router's 6th upstream
    // call fails and the 7th succeeds. Total upstream attempts: 7.
    const upstream = scriptedOpenAI(6, 'RECOVERED_BY_CODEX');
    const app = await fixtureRouter({ upstreamFetch: upstream.upstreamFetch });
    try {
      const run = await runCodex(app.url('/'), 'Reply with exactly the word from the model.');
      expect(run.stdout + run.stderr).toContain('RECOVERED_BY_CODEX');
      expect(upstream.calls.filter(p => p.endsWith('/responses')).length).toBe(7);
    } finally { await app.close(); }
  }, 120_000);
});
