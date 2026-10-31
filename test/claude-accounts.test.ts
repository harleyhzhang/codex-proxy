import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAccount, configuredClaudeAccount, createClaudeAccountBackend } from '../src/backends/claude';
import { anthropicFixture, limitHeaders, say } from './anthropic-fixture';

const personal = anthropicFixture({ email: 'personal@example.com', org: 'org_personal' });
const work = anthropicFixture({ email: 'work@example.com', org: 'org_work' });
afterAll(() => { personal.stop(); work.stop(); });

test('separate Claude logins serve the same model concurrently and keep their own tokens and quota', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-accounts-'));
  try {
    const mine = new ClaudeAccount({ ...personal.options(), expectedEmail: 'personal@example.com' });
    const team = createClaudeAccountBackend({ ...work.options(), configDir: join(dir, 'work'), prefix: 'team', label: 'Team', expectedEmail: 'work@example.com', expectedOrg: 'org_work' });
    personal.state.replies.push(() => say('personal'));
    work.state.replies.push(() => say('work'));
    const request = { model: 'claude-opus-5-5', input: 'hello' };
    // The router has already mapped the public slug to the native model when a backend runs.
    const [a, b] = await Promise.all([mine.run(request), team.backend.run(request)]);
    expect([a.text, b.text]).toEqual(['personal', 'work']);
    expect(personal.messages()).toHaveLength(1); expect(work.messages()).toHaveLength(1);

    personal.state.replies.push(() => new Response('{}', { status: 429, headers: limitHeaders(Math.floor(Date.now() / 1000) + 1000) }));
    await expect(mine.run(request)).rejects.toThrow('limit reached');
    await expect(mine.run(request)).rejects.toThrow('limit reached');
    expect(personal.messages()).toHaveLength(2);
    expect((await team.backend.run(request)).text).toBe('CLAUDE_OK');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('second Claude account is opt-in with explicit labels, namespaces and native-model selection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-accounts-'));
  const primary = join(dir, 'personal'), secondary = join(dir, 'work');
  await mkdir(primary); await mkdir(secondary);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = primary;
  try {
    expect(configuredClaudeAccount({})).toBeUndefined();
    const configured = configuredClaudeAccount({ CLAUDE_ACCOUNT_CONFIG_DIR: secondary, CLAUDE_ACCOUNT_MODEL_PREFIX: 'team', CLAUDE_ACCOUNT_LABEL: 'Team', CLAUDE_ACCOUNT_MODELS: 'claude-opus-5-5' })!;
    expect(configured.backend.models).toEqual({ 'team-claude-opus-5-5': 'claude-opus-5-5' });
    expect(configured.backend.reservedPrefix).toBe('team-claude-');
    expect(configured.backend.catalog?.map(row => row.displayName)).toEqual(['Opus 5.5 (Team)']);
    await symlink(primary, join(dir, 'alias'));
    for (const configDir of [primary, join(dir, 'alias')]) expect(() => createClaudeAccountBackend({ configDir, prefix: 'team', label: 'Team' })).toThrow('must differ');
    expect(() => createClaudeAccountBackend({ configDir: 'relative', prefix: 'team', label: 'Team' })).toThrow('absolute');
    for (const prefix of ['gpt', 'grok', 'claude', 'gpt-team', 'bad/name']) expect(() => createClaudeAccountBackend({ configDir: secondary, prefix, label: 'Team' })).toThrow('namespace');
    expect(() => createClaudeAccountBackend({ configDir: secondary, prefix: 'team', label: 'Team', models: ['claude-unknown'] })).toThrow('supported native');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
