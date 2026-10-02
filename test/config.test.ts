import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildCatalog } from '../src/catalog';
import { loadConfig } from '../src/config';
import { positiveInt } from '../src/env';
import { BACKENDS } from '../src/backends/registry';
import { DEFAULT_BRIDGE_MODELS } from '../src/router/bridge';

describe('loadConfig', () => {
  test('derives every path from HOME when nothing is set', () => {
    const config = loadConfig({ HOME: '/home/user' });
    expect(config).toEqual({
      port: 3468,
      codexHome: '/home/user/.codex',
      stateDir: '/home/user/.codex-subscription-proxy',
      authFile: '/home/user/.codex/auth.json',
      catalogFile: '/home/user/.codex-subscription-proxy/models.json',
      summaryKeyFile: '/home/user/.codex-subscription-proxy/summary.key',
      upstreamTimeoutMs: 900_000,
      bridgeModels: DEFAULT_BRIDGE_MODELS,
    });
  });

  test('honours explicit overrides', () => {
    const config = loadConfig({
      HOME: '/home/user',
      PORT: '4000',
      CODEX_HOME: '/codex',
      PROXY_STATE_DIR: '/state',
      CATALOG_FILE: '/catalog.json',
      SUMMARY_KEY_FILE: '/key',
      UPSTREAM_TIMEOUT_MS: '1000',
      BRIDGE_MODELS: ' gpt-a , ,gpt-b ',
    });
    expect(config.port).toBe(4000);
    expect(config.authFile).toBe(join('/codex', 'auth.json'));
    expect(config.catalogFile).toBe('/catalog.json');
    expect(config.summaryKeyFile).toBe('/key');
    expect(config.upstreamTimeoutMs).toBe(1000);
    expect(config.bridgeModels).toEqual(['gpt-a', 'gpt-b']);
  });

  test('rejects invalid numbers instead of guessing', () => {
    for (const PORT of ['0', '-1', '3.5', 'abc']) {
      expect(() => loadConfig({ HOME: '/h', PORT })).toThrow('PORT must be a positive integer');
    }
    expect(() => loadConfig({ HOME: '/h', PORT: '70000' })).toThrow('PORT must be at most 65535');
    expect(() => loadConfig({ HOME: '/h', UPSTREAM_TIMEOUT_MS: 'soon' })).toThrow('UPSTREAM_TIMEOUT_MS');
  });

  test('backend timeouts share the same strict parser', () => {
    expect(positiveInt('GROK_TIMEOUT_MS', 5, {})).toBe(5);
    expect(positiveInt('GROK_TIMEOUT_MS', 5, { GROK_TIMEOUT_MS: '60000' })).toBe(60_000);
    expect(() => positiveInt('GROK_TIMEOUT_MS', 5, { GROK_TIMEOUT_MS: 'NaN' })).toThrow('GROK_TIMEOUT_MS');
  });
});

describe('buildCatalog', () => {
  const localSlugs = BACKENDS.flatMap((backend) => backend.catalog.map((model) => model.slug));
  const native = {
    models: [
      { slug: 'gpt-hidden', visibility: 'hide', priority: 1 },
      { slug: 'gpt-main', visibility: 'list', priority: 7, service_tiers: ['priority'], upgrade: { to: 'x' }, shell_type: 'shell' },
      { slug: localSlugs[0], visibility: 'list', priority: 99 },
    ],
  };

  test('keeps native rows, replaces stale local rows and appends every subscription model', () => {
    const { models } = buildCatalog(native);
    expect(models.map((row) => row.slug)).toEqual(['gpt-hidden', 'gpt-main', ...localSlugs]);
    const local = models.slice(2);
    expect(local.map((row) => row.priority)).toEqual(local.map((_, index) => 8 + index));
  });

  test('local rows inherit the listed template minus GPT-only fields', () => {
    const row = buildCatalog(native).models.at(-1)!;
    expect(row.shell_type).toBe('shell');
    expect(row.visibility).toBe('list');
    expect(row.context_window).toBe(200_000);
    expect(row).not.toHaveProperty('service_tiers');
    expect(row).not.toHaveProperty('upgrade');
    expect(Array.isArray(row.supported_reasoning_levels)).toBe(true);
  });

  test('refuses an empty or malformed cache', () => {
    for (const cache of [undefined, {}, { models: [] }, { models: ['x', 1] }]) {
      expect(() => buildCatalog(cache)).toThrow('Codex models cache has no models');
    }
  });
});
