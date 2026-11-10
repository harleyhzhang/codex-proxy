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

test('secondary Fable 5.2 and Opus 5.5 pin medium effort and fast speed without changing the primary account', async () => {
  const fixture = anthropicFixture();
  const dir = await mkdtemp(join(tmpdir(), 'claude-fixed-controls-'));
  try {
    const team = createClaudeAccountBackend({ ...fixture.options(), configDir: dir, prefix: 'team', label: 'Team', models: ['claude-fable-5-2', 'claude-opus-5-5'], reasoningEffort: 'medium', fastMode: true });
    expect(team.backend.catalog.map(row => [row.slug, row.displayName, row.efforts, row.defaultEffort])).toEqual([
      ['team-claude-fable-5-2', 'Fable 5.2 (Team)', ['medium'], 'medium'],
      ['team-claude-opus-5-5', 'Opus 5.5 (Team)', ['medium'], 'medium'],
    ]);
    for (const model of Object.values(team.backend.models)) {
      await team.backend.run({ model, input: 'hello', reasoning: { effort: 'max' } });
    }
    for (const { body } of fixture.messages()) expect(body).toMatchObject({ speed: 'fast', output_config: { effort: 'medium' } });
    expect(fixture.messages()[0]!.body.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(fixture.messages()[0]!.headers['anthropic-beta']).toContain('thinking-binding-controls-2026-08-01');
    expect(fixture.messages()[1]!.body.thinking).toEqual({ type: 'adaptive' });
    const primary = new ClaudeAccount(fixture.options());
    await primary.run({ model: 'claude-opus-5-5', input: 'hello', reasoning: { effort: 'high' } });
    expect(fixture.messages().at(-1)!.body.output_config).toEqual({ effort: 'high' });
    expect(fixture.messages().at(-1)!.body.speed).toBeUndefined();
  } finally { fixture.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('secondary Claude validates and loads fixed effort and speed policies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-controls-env-'));
  const env = { CLAUDE_ACCOUNT_CONFIG_DIR: dir, CLAUDE_ACCOUNT_MODELS: 'claude-fable-5-2,claude-opus-5-5', CLAUDE_ACCOUNT_REASONING_EFFORT: 'medium', CLAUDE_ACCOUNT_SPEED_POLICY: 'fastest' };
  try {
    const configured = configuredClaudeAccount(env)!;
    expect(configured.account.options).toMatchObject({ reasoningEffort: 'medium', fastMode: true });
    expect(() => configuredClaudeAccount({ ...env, CLAUDE_ACCOUNT_REASONING_EFFORT: 'unknown' })).toThrow('reasoning effort');
    expect(() => configuredClaudeAccount({ ...env, CLAUDE_ACCOUNT_SPEED_POLICY: 'unknown' })).toThrow('SPEED_POLICY');
    expect(configuredClaudeAccount({ CLAUDE_ACCOUNT_CONFIG_DIR: dir })!.account.options.fastMode).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
