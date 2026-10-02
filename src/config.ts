// Runtime configuration, read once from the environment. Every path has a sensible default so a
// fresh install needs no variables at all.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Env, positiveInt } from './env';
import { DEFAULT_BRIDGE_MODELS } from './router/bridge';

export type Config = {
  port: number;
  codexHome: string;
  stateDir: string;
  authFile: string;
  catalogFile: string;
  summaryKeyFile: string;
  upstreamTimeoutMs: number;
  bridgeModels: readonly string[];
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
  return {
    port,
    codexHome,
    stateDir,
    authFile: join(codexHome, 'auth.json'),
    catalogFile: env.CATALOG_FILE || join(stateDir, 'models.json'),
    summaryKeyFile: env.SUMMARY_KEY_FILE || join(stateDir, 'summary.key'),
    upstreamTimeoutMs: positiveInt('UPSTREAM_TIMEOUT_MS', 900_000, env),
    bridgeModels: bridgeModels.length ? bridgeModels : DEFAULT_BRIDGE_MODELS,
  };
}
