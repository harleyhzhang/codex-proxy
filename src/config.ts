// Runtime configuration, read once from the environment. Every path has a sensible default so a
// fresh install needs no variables at all.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Env, positiveInt } from './env';
import { DEFAULT_BRIDGE_MODELS } from './router/bridge';
import { validateAccountPrefix, type AccountOptions } from './router/account-upstream';

export type Config = {
  port: number;
  codexHome: string;
  stateDir: string;
  authFile: string;
  catalogFile: string;
  summaryKeyFile: string;
  upstreamTimeoutMs: number;
  bridgeModels: readonly string[];
  secondaryAccount?: AccountOptions;
  secondaryLabel: string;
  primaryStandard: boolean;
  pinnedEfforts: readonly (readonly [string, string])[];
};

export function loadConfig(env: Env = process.env): Config {
  const home = env.HOME || homedir();
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const stateDir = env.PROXY_STATE_DIR || join(home, '.codex-subscription-proxy');
  const port = positiveInt('PORT', 3468, env);
  if (port > 65_535) throw new Error('PORT must be at most 65535');
  const bridgeModels = (env.BRIDGE_MODELS ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  for (const [name, choices] of [['ACCOUNT_SPEED_POLICY', ['client', 'fastest']], ['PRIMARY_SPEED_POLICY', ['client', 'standard']]] as const) {
    const value = env[name];
    if (value !== undefined && !choices.some(choice => choice === value)) throw new Error(`${name} must be ${choices.join(' or ')}`);
  }
  const prefix = env.ACCOUNT_MODEL_PREFIX || 'secondary';
  const pinnedEfforts = (env.CATALOG_EFFORTS ?? '').split(',').map(rule => rule.trim()).filter(Boolean).map(rule => rule.split('='));
  if (pinnedEfforts.some(rule => rule.length !== 2 || !/^[a-z0-9.-]+$/.test(rule[0] ?? '') || !/^[a-z]+$/.test(rule[1] ?? ''))) throw new Error('CATALOG_EFFORTS must be comma-separated fragment=effort pairs');
  const models = (env.ACCOUNT_MODELS ?? '').split(',').map(model => model.trim()).filter(Boolean);
  if (models.some(model => !/^gpt-[a-z0-9][a-z0-9.-]*$/.test(model))) throw new Error('ACCOUNT_MODELS must contain native GPT model slugs');
  if (env.ACCOUNT_CODEX_HOME) {
    validateAccountPrefix(prefix);
    if (resolve(env.ACCOUNT_CODEX_HOME) === resolve(codexHome)) throw new Error('ACCOUNT_CODEX_HOME must differ from CODEX_HOME');
  }
  return {
    port,
    codexHome,
    stateDir,
    authFile: join(codexHome, 'auth.json'),
    catalogFile: env.CATALOG_FILE || join(stateDir, 'models.json'),
    summaryKeyFile: env.SUMMARY_KEY_FILE || join(stateDir, 'summary.key'),
    upstreamTimeoutMs: positiveInt('UPSTREAM_TIMEOUT_MS', 900_000, env),
    bridgeModels: bridgeModels.length ? bridgeModels : DEFAULT_BRIDGE_MODELS,
    secondaryLabel: env.ACCOUNT_LABEL || 'Secondary',
    primaryStandard: env.PRIMARY_SPEED_POLICY === 'standard',
    pinnedEfforts: pinnedEfforts.map(([fragment = '', effort = '']) => [fragment, effort] as const),
    secondaryAccount: env.ACCOUNT_CODEX_HOME ? {
      home: env.ACCOUNT_CODEX_HOME,
      prefix,
      binary: env.ACCOUNT_CODEX_BINARY || 'codex',
      expectedEmail: env.ACCOUNT_EXPECTED_EMAIL,
      expectedAccountId: env.ACCOUNT_EXPECTED_WORKSPACE,
      fastest: env.ACCOUNT_SPEED_POLICY === 'fastest',
      models: models.length ? models : undefined,
    } : undefined,
  };
}
