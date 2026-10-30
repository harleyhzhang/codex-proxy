// Grok process lifecycle against a scripted CLI: a run must end promptly and leave no process behind,
// whatever the CLI does with signals or with the pipes it hands to its own children.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grokProfileHash, runGrok } from '../src/backends/grok';
import { sha256 } from '../src/json';
import type { ResponsesRequest } from '../src/protocol/types';

const ENV = ['GROK_BIN', 'GROK_CWD', 'GROK_TIMEOUT_MS', 'GROK_KILL_GRACE_MS', 'GROK_BIN_SHA256', 'GROK_PROFILE_SHA256', 'GROK_HOME'] as const;
const saved: Partial<Record<string, string>> = {};
let dir = '';

const result = (text: string) => JSON.stringify({ type: 'result', stopReason: 'end_turn', num_turns: 1, structuredOutput: { text, tool_calls: [] } });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pids = async (name: string) => (await Bun.file(join(dir, name)).text().catch(() => '')).split('\n').filter(Boolean).map(Number);

/** A stand-in CLI whose behaviour is chosen by a token in the prompt. Every pid it starts is logged. */
async function cli(body: string): Promise<void> {
  const binary = join(dir, 'grok');
  await Bun.write(binary, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const args = process.argv;
const prompt = await Bun.file(args[args.indexOf('--prompt-file') + 1]).text();
appendFileSync(${JSON.stringify(join(dir, 'cli.pids'))}, process.pid + '\\n');
const child = () => { const c = Bun.spawn(['sleep', '30'], { stdout: 'inherit', stderr: 'inherit' }); appendFileSync(${JSON.stringify(join(dir, 'child.pids'))}, c.pid + '\\n'); c.unref(); };
${body}
`);
  await chmod(binary, 0o700);
  process.env.GROK_BIN = binary;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grok-lifecycle-'));
  for (const key of ENV) saved[key] = process.env[key];
  delete process.env.GROK_BIN_SHA256; delete process.env.GROK_PROFILE_SHA256;
  process.env.GROK_CWD = dir;
  process.env.GROK_TIMEOUT_MS = '5000';
  process.env.GROK_KILL_GRACE_MS = '200';
});
afterEach(async () => {
  for (const pid of [...await pids('cli.pids'), ...await pids('child.pids')]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  await rm(dir, { recursive: true, force: true });
});

async function settledWithin<T>(ms: number, work: Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
  const started = performance.now();
  const outcome = await Promise.race([
    work.then((value) => ({ value }), (error: unknown) => ({ error })),
    Bun.sleep(ms).then(() => ({ error: new Error(`still running after ${ms} ms`) })),
  ]);
  return { ...outcome, ms: performance.now() - started };
}

test('a cancelled turn ends promptly even when the CLI ignores SIGTERM, and nothing it started survives', async () => {
  await cli(`process.on('SIGTERM', () => {}); child(); await new Promise(() => {});`);
  const controller = new AbortController();
  const pending = runGrok({ model: 'grok-4.7', input: 'HANG' }, controller.signal);
  await Bun.sleep(300);
  controller.abort();
  const outcome = await settledWithin(3000, pending);
  expect(String(outcome.error)).toContain('cancel');
  await Bun.sleep(100);
  expect([...await pids('cli.pids'), ...await pids('child.pids')].filter(alive)).toEqual([]);
  expect((await readdir(dir)).filter((name) => name.startsWith('request-'))).toEqual([]);
});

test('a silent CLI that ignores SIGTERM still times out, on both attempts, without hanging the router', async () => {
  await cli(`process.on('SIGTERM', () => {}); await new Promise(() => {});`);
  // Long enough for the stand-in to start and install its SIGTERM handler before the window closes.
  process.env.GROK_TIMEOUT_MS = '700';
  const outcome = await settledWithin(4000, runGrok({ model: 'grok-4.7', input: 'SILENT' }));
  expect(String(outcome.error)).toContain('timed out');
  const started = await pids('cli.pids');
  expect(started.length).toBe(2);
  expect(started.filter(alive)).toEqual([]);
});

test('a finished run is returned at once even if a helper the CLI spawned still holds its output pipes', async () => {
  await cli(`child(); console.log(${JSON.stringify(result('DONE'))}); process.exit(0);`);
  const outcome = await settledWithin(3000, runGrok({ model: 'grok-4.7', input: 'FINISH' }));
  expect(outcome.error).toBeUndefined();
  expect(outcome.value?.text).toBe('DONE');
  await Bun.sleep(100);
  // Codex owns execution: a process left behind by the CLI is ended with the run.
  expect((await pids('child.pids')).filter(alive)).toEqual([]);
});

test('output over the safety limit ends the run without waiting for a CLI that ignores SIGTERM', async () => {
  await cli(`process.on('SIGTERM', () => {}); const line = 'x'.repeat(1 << 20) + '\\n'; for (let i = 0; i < 40; i++) process.stdout.write(line); await new Promise(() => {});`);
  const outcome = await settledWithin(4000, runGrok({ model: 'grok-4.7', input: 'FLOOD' }));
  expect(String(outcome.error)).toContain('safety limit');
  await Bun.sleep(100);
  expect((await pids('cli.pids')).filter(alive)).toEqual([]);
});

test('the pinned binary hash is reused only while the file is unchanged; a rewritten binary is refused before it runs', async () => {
  await cli(`console.log(${JSON.stringify(result('PINNED'))});`);
  process.env.GROK_BIN_SHA256 = new Bun.CryptoHasher('sha256').update(await Bun.file(process.env.GROK_BIN!).arrayBuffer()).digest('hex');
  expect((await runGrok({ model: 'grok-4.7', input: 'one' })).text).toBe('PINNED');
  expect((await runGrok({ model: 'grok-4.7', input: 'two' })).text).toBe('PINNED');
  // Same length, same path, different bytes: only a fresh hash can tell.
  const source = await Bun.file(process.env.GROK_BIN!).text();
  await Bun.write(process.env.GROK_BIN!, source.replace('PINNED', 'EVILED'));
  const runs = (await pids('cli.pids')).length;
  await expect(runGrok({ model: 'grok-4.7', input: 'three' })).rejects.toThrow('pinned binary changed');
  expect((await pids('cli.pids')).length).toBe(runs);
});

test('the CLI runs with session search off, so it never indexes its stored sessions before a turn', async () => {
  await cli(`console.log(${JSON.stringify(result('__SEEN__'))}.replace('__SEEN__', String(process.env.GROK_SESSION_SEARCH)));`);
  // The CLI's session-search index reads every stored session before each request; the router never uses it.
  expect((await runGrok({ model: 'grok-4.7', input: 'ENV' })).text).toBe('0');
});

test('attachments Grok cannot read are refused before any process starts; ordinary JSON that mentions media stays text', async () => {
  await cli(`const seen = prompt.includes('https://example.com/report.png') && prompt.includes('file-abc123'); console.log(${JSON.stringify(result('__SEEN__'))}.replace('__SEEN__', String(seen)));`);
  // Shapes the router's types do not model on purpose: these arrive as untrusted JSON from Codex.
  const user = (content: unknown[]) => ({ model: 'grok-4.7', input: [{ role: 'user', content }] }) as unknown as ResponsesRequest;
  const refused = [
    [{ type: 'input_image', image_url: 'https://example.com/remote.png' }],
    [{ type: 'input_image', file_id: 'file-uploaded' }],
    [{ type: 'input_file', file_data: 'data:application/pdf;base64,AAAA', filename: 'a.pdf' }],
    [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }],
    [{ type: 'input_video', video_url: 'https://example.com/v.mp4' }],
  ];
  for (const content of refused) await expect(runGrok(user(content))).rejects.toThrow(/attachment|no image input/);
  expect(await pids('cli.pids')).toEqual([]);
  // A tool result whose JSON merely names a URL and a file id is ordinary data, kept verbatim for Grok.
  const output = await runGrok({ model: 'grok-4.7', input: [
    { role: 'user', content: 'list uploads' },
    { type: 'function_call', name: 'lookup', call_id: 'call_1', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ link: 'https://example.com/report.png', file_id: 'file-abc123' }) },
  ] });
  expect(output.text).toBe('true');
});

test('a signed-out CLI is refused at once with a sign-in instruction, not retried as a generic process failure', async () => {
  // The real 1.0.46 wording after an expired session's refresh token is rejected (October 30, 2026).
  const expired = 'Your session has expired. Run grok login to sign in again.';
  await cli(`console.log(JSON.stringify({ type: 'result', is_error: true, subtype: 'error', result: ${JSON.stringify(expired)} }));
console.error('Alternatively set the XAI_API_KEY environment variable or run grok login on a machine with a browser.');
process.exit(1);`);
  await expect(runGrok({ model: 'grok-4.7', input: 'SIGNED_OUT' })).rejects.toThrow('grok login');
  expect((await pids('cli.pids')).length).toBe(1);
  // The same refusal arrives in-band when the CLI exits 0 with an error result.
  await cli(`console.log(JSON.stringify({ type: 'result', stopReason: 'end_turn', num_turns: 1, is_error: true, result: ${JSON.stringify(expired)} }));`);
  await expect(runGrok({ model: 'grok-4.7', input: 'SIGNED_OUT' })).rejects.toThrow('signed out');
  expect((await pids('cli.pids')).length).toBe(2);
});

test('the CLI gets a zero-tool boundary: a recognized allowlist entry that is also denied, exact internal IDs, and the MCP meta tools denied', async () => {
  // An unknown --tools name makes Grok Build keep its full native toolset, so the allowlist must be a
  // real ID; denying that same ID leaves the session with no tools to dispatch.
  await cli(`const tools = args[args.indexOf('--tools') + 1]; const denied = args[args.indexOf('--disallowed-tools') + 1].split(',');
const ok = tools === 'read_file' && ['read_file', 'run_terminal_cmd', 'write', 'search_tool', 'use_tool', 'bash', 'web_fetch', 'Agent'].every((t) => denied.includes(t))
  && args.includes('--verbatim') && args[args.indexOf('--permission-mode') + 1] === 'dontAsk' && ['Bash', 'Read', 'Write'].every((t) => args.includes(t));
console.log(${JSON.stringify(result('__OK__'))}.replace('__OK__', String(ok)));`);
  expect((await runGrok({ model: 'grok-4.7', input: 'ARGS' })).text).toBe('true');
});

test('a prompt well over the CLI offload threshold reaches the prompt file whole, with --verbatim so the CLI sends it as given', async () => {
  await cli(`console.log(${JSON.stringify(result('__SEEN__'))}.replace('__SEEN__', String(args.includes('--verbatim')) + '|' + String(prompt.length) + '|' + String(prompt.includes(process.env.LARGE_HEAD)) + String(prompt.includes(process.env.LARGE_MID)) + String(prompt.includes(process.env.LARGE_TAIL))));`);
  const [head, mid, tail] = ['LARGE_HEAD_7Q2', 'LARGE_MID_4K9', 'LARGE_TAIL_1Z8'];
  Object.assign(process.env, { LARGE_HEAD: head, LARGE_MID: mid, LARGE_TAIL: tail });
  const pad = 'synthetic padding line for the offload threshold\n'.repeat(3000);
  const input = `${head}\n${pad}${mid}\n${pad}${tail}`;
  try {
    const [verbatim, length, markers] = (await runGrok({ model: 'grok-4.7', input })).text.split('|');
    expect(verbatim).toBe('true');
    expect(Number(length)).toBeGreaterThan(input.length);
    expect(input.length).toBeGreaterThan(250_000);
    expect(markers).toBe('truetruetrue');
  } finally { for (const key of ['LARGE_HEAD', 'LARGE_MID', 'LARGE_TAIL']) delete process.env[key]; }
});

test('user text and tool output reach the prompt file byte for byte, vendor phrases included', async () => {
  const phrase = "Claude Code's native tools";
  await cli(`console.log(${JSON.stringify(result('__SEEN__'))}.replace('__SEEN__', String(prompt.split(${JSON.stringify(phrase)}).length - 1) + '|' + String(prompt.includes("Grok Build's native tools are"))));`);
  const output = await runGrok({ model: 'grok-4.7', input: [
    { role: 'user', content: `Keep this literal: ${phrase}` },
    { type: 'function_call', name: 'lookup', call_id: 'call_1', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: `const note = "${phrase}";` },
  ] });
  // At least the two literal copies survive, and no copy was rewritten into a Grok phrase.
  const [count, rewritten] = output.text.split('|');
  expect(Number(count)).toBeGreaterThanOrEqual(2);
  expect(rewritten).toBe('false');
});

test('an in-band context overflow is the native overflow code, never an outage or a quota refusal, and is not retried', async () => {
  for (const text of ['fetch failed: prompt is too long', 'prompt is too long: input_tokens 429001 > 256000']) {
    await cli(`console.log(JSON.stringify({ type: 'result', stopReason: 'end_turn', num_turns: 1, is_error: true, result: ${JSON.stringify(text)} }));`);
    const before = (await pids('cli.pids')).length;
    const outcome = await settledWithin(3000, runGrok({ model: 'grok-4.7', input: 'HUGE' }));
    expect((outcome.error as { code?: string }).code).toBe('context_length_exceeded');
    expect((await pids('cli.pids')).length).toBe(before + 1);
  }
});

/** The one-level scan the router used before nested hooks and plugins were covered. */
function flatProfileHash(home: string, folders: Record<string, string[]>): string {
  const parts: Buffer[] = [];
  for (const folder of ['hooks', 'plugins']) {
    for (const name of [...(folders[folder] ?? [])].sort()) {
      const file = `${join(home, folder)}/${name}`;
      parts.push(Buffer.from(file));
      try { parts.push(readFileSync(file)); } catch {}
    }
  }
  return sha256(Buffer.concat(parts));
}

test('the profile hash covers nested hooks and plugins, keeps flat pins valid, and refuses symlinks', async () => {
  const home = join(dir, 'home');
  process.env.GROK_HOME = home;
  await mkdir(join(home, 'hooks'), { recursive: true });
  await mkdir(join(home, 'plugins'), { recursive: true });
  await writeFile(join(home, 'hooks', 'deny.json'), '{"deny":true}');
  // A flat profile hashes exactly as before, so an existing pin still matches.
  expect(grokProfileHash()).toBe(flatProfileHash(home, { hooks: ['deny.json'] }));

  await mkdir(join(home, 'plugins', 'tool', 'hooks'), { recursive: true });
  await writeFile(join(home, 'plugins', 'tool', 'hooks', 'pre.sh'), 'exit 0');
  await cli(`console.log(${JSON.stringify(result('PROFILE_OK'))});`);
  process.env.GROK_PROFILE_SHA256 = grokProfileHash();
  expect((await runGrok({ model: 'grok-4.7', input: 'pinned' })).text).toBe('PROFILE_OK');
  // Editing a file two levels down pauses the backend before any process starts.
  await writeFile(join(home, 'plugins', 'tool', 'hooks', 'pre.sh'), 'curl attacker');
  const runs = (await pids('cli.pids')).length;
  await expect(runGrok({ model: 'grok-4.7', input: 'edited' })).rejects.toThrow('configuration changed');
  expect((await pids('cli.pids')).length).toBe(runs);

  await writeFile(join(home, 'plugins', 'tool', 'hooks', 'pre.sh'), 'exit 0');
  expect(grokProfileHash()).toBe(process.env.GROK_PROFILE_SHA256!);

  // A file symlink to a target outside the tree: its bytes could change behind the unchanged link,
  // so the link itself pauses the backend before any process starts, whatever the target holds.
  const outside = join(dir, 'outside.sh');
  await writeFile(outside, 'exit 0');
  await symlink(outside, join(home, 'hooks', 'linked.sh'));
  expect(() => grokProfileHash()).toThrow('symlink');
  await writeFile(outside, 'curl attacker');
  const before = (await pids('cli.pids')).length;
  await expect(runGrok({ model: 'grok-4.7', input: 'linked' })).rejects.toThrow('symlink');
  expect((await pids('cli.pids')).length).toBe(before);
  await rm(join(home, 'hooks', 'linked.sh'));

  // A directory symlink cycle refuses promptly instead of looping.
  await symlink(join(home, 'plugins'), join(home, 'plugins', 'tool', 'loop'));
  const looped = await settledWithin(2000, Promise.resolve().then(() => grokProfileHash()));
  expect(String(looped.error)).toContain('symlink');
  expect(await readFile(join(home, 'hooks', 'deny.json'), 'utf8')).toBe('{"deny":true}');
});
