// Fresh-session startup against a scripted Claude CLI: the shared, binding-checked identity probe and
// the prewarmed standby worker. The mock logs every probe, launch and prompt by pid.
import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAccount } from '../src/backends/claude';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'claude-identity-'));
  const profile = join(dir, 'profile');
  await mkdir(profile);
  const binary = join(dir, 'claude');
  const file = (name: string) => JSON.stringify(join(dir, name));
  // The probe reads its answer before any delay, so a login changed mid-probe gets the old answer.
  await Bun.write(binary, `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const log = (line) => appendFileSync(${file('events')}, line + '\\n');
if (process.argv.includes('status')) {
  log('probe');
  const answer = readFileSync(${file('identity')}, 'utf8');
  const delay = existsSync(${file('delay')}) ? Number(readFileSync(${file('delay')}, 'utf8')) : 0;
  if (delay) await Bun.sleep(delay);
  console.log(answer);
  process.exit(0);
}
log('start ' + process.pid);
let prompted = false;
for await (const line of (await import('node:readline')).createInterface({ input: process.stdin })) {
  prompted = true;
  log('prompt ' + process.pid);
  console.log(JSON.stringify({ type: 'result', is_error: false, structured_output: { text: String(process.pid), tool_calls: [] } }));
}
// An idle CLI that ignores end of input, so only a kill ends it.
if (!prompted && existsSync(${file('stubborn')})) await new Promise(() => {});
`);
  await chmod(binary, 0o700);
  const record = (accountUuid: string, email: string) =>
    Bun.write(join(profile, '.claude.json'), JSON.stringify({ numStartups: 1, oauthAccount: { accountUuid, organizationUuid: 'org', emailAddress: email, profileFetchedAt: Date.now() } }));
  const signIn = async (accountUuid: string, email: string) => {
    await record(accountUuid, email);
    await Bun.write(join(dir, 'identity'), JSON.stringify({ loggedIn: true, email, orgId: 'org' }));
  };
  await signIn('account-a', 'a@example.com');
  const events = async () => (await Bun.file(join(dir, 'events')).exists() ? (await Bun.file(join(dir, 'events')).text()).trim().split('\n') : []);
  const account = new ClaudeAccount({ binary, configDir: profile, cwd: dir, expectedEmail: 'a@example.com', expectedOrg: 'org' });
  cleanups.push(async () => {
    for (const worker of account.workers.values()) worker.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    account, record, signIn, binary, setDelay: (ms: number) => Bun.write(join(dir, 'delay'), String(ms)), stubborn: () => Bun.write(join(dir, 'stubborn'), '1'),
    probes: async () => (await events()).filter((line) => line === 'probe').length,
    starts: async () => (await events()).filter((line) => line.startsWith('start ')).map((line) => line.slice(6)),
    prompts: async () => (await events()).filter((line) => line.startsWith('prompt ')).map((line) => line.slice(7)),
  };
}

const hello = (effort = 'high') => ({ model: 'claude-opus-5-5', input: 'hello', reasoning: { effort } });

/** Waits for launches to be logged; a standby is spawned in the background after its turn starts. */
async function launched(f: Awaited<ReturnType<typeof fixture>>, count: number): Promise<string[]> {
  for (let tries = 0; tries < 100; tries++) {
    const starts = await f.starts();
    if (starts.length >= count) return starts;
    await Bun.sleep(20);
  }
  return f.starts();
}

test('a verified login is reused briefly and re-probed as soon as the profile signs in elsewhere', async () => {
  const f = await fixture();
  await f.account.run(hello());
  await f.account.run(hello());
  expect(await f.probes()).toBe(1);
  // The CLI rewrites routine fields all the time; that is not a different login.
  await f.signIn('account-a', 'a@example.com');
  await f.account.run(hello());
  expect(await f.probes()).toBe(1);
  await f.signIn('account-b', 'b@example.com');
  await expect(f.account.run(hello())).rejects.toThrow('identity does not match');
  expect(await f.probes()).toBe(2);
  expect((await f.prompts()).length).toBe(3);
});

test('concurrent fresh sessions share one probe, and one cancelled caller does not cancel it for the others', async () => {
  const f = await fixture();
  await f.setDelay(300);
  const controller = new AbortController();
  const cancelled = f.account.run(hello(), controller.signal);
  const kept = [f.account.run(hello()), f.account.run(hello('low'))];
  setTimeout(() => controller.abort(), 50);
  await expect(cancelled).rejects.toThrow();
  const outputs = await Promise.all(kept);
  expect(outputs.every((output) => output.text.length > 0)).toBe(true);
  expect(await f.probes()).toBe(1);
  expect((await f.prompts()).length).toBe(2);
});

test('a login that changes while its probe runs is probed again, and the mismatch reaches no CLI', async () => {
  const f = await fixture();
  await f.account.run(hello());
  await f.setDelay(300);
  process.env.CLAUDE_IDENTITY_CACHE_MS = '0';
  try {
    const pending = f.account.run(hello());
    // The in-flight probe still answers as account A; by then the profile belongs to account B.
    setTimeout(() => void f.signIn('account-b', 'b@example.com'), 100);
    await expect(pending).rejects.toThrow('identity does not match');
  } finally { delete process.env.CLAUDE_IDENTITY_CACHE_MS; }
  expect(await f.probes()).toBe(3);
  expect((await f.prompts()).length).toBe(1);
  expect(f.account.workers.size).toBe(0);
});

test('the next fresh session with identical arguments runs in a prewarmed CLI; other arguments start their own', async () => {
  const f = await fixture();
  const first = await f.account.run(hello());
  const warm = await launched(f, 2);
  expect(warm.length).toBe(2);
  const second = await f.account.run(hello());
  expect(second.text).not.toBe(first.text);
  expect(warm).toContain(second.text);
  const before = await launched(f, 3);
  const other = await f.account.run(hello('low'));
  expect(before).not.toContain(other.text);
  // Each process received exactly one prompt: a standby never carries an earlier conversation.
  const prompts = await f.prompts();
  expect(new Set(prompts).size).toBe(prompts.length);
});

test('an expired or evicted standby is killed even when the CLI ignores end of input', async () => {
  const f = await fixture();
  await f.stubborn();
  // Counted from the process table, so a standby killed before it even logged its launch still counts.
  const running = async () => (await new Response(Bun.spawn(['ps', '-axo', 'command'], { stdout: 'pipe' }).stdout).text()).split('\n').filter((line) => line.includes(f.binary)).length;
  // Three launches with different arguments: with a cap of one, the first two standbys are evicted
  // and the last expires unclaimed after its short idle window.
  process.env.CLAUDE_STANDBY_IDLE_MS = '150';
  try {
    for (const effort of ['high', 'low', 'medium']) await f.account.run(hello(effort));
    expect(await running()).toBeGreaterThan(0);
    await Bun.sleep(500);
    expect(await running()).toBe(0);
    expect((await f.prompts()).length).toBe(3);
  } finally { delete process.env.CLAUDE_STANDBY_IDLE_MS; }
});
