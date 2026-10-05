#!/usr/bin/env bun
// Starts the router with configuration from the environment. See README.md for the variables.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config';
import { log } from './log';
import { startRouter } from './router/server';

// Last-resort guard. A broken pipe to an exited CLI child must fail only that request; letting it
// escape kills the router and every open chat. Anything else is a real bug: log its shape (never
// its message, which may hold content) and exit so the supervisor restarts a clean process.
for (const kind of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(kind, (error: unknown) => {
    const fields = (error ?? {}) as { code?: unknown; name?: unknown };
    const code = typeof fields.code === 'string' ? fields.code.replace(/[^A-Z_]/g, '').slice(0, 32) : '';
    const name = String(fields.name ?? '').replace(/[^A-Za-z]/g, '').slice(0, 40);
    log.warn(`process-${kind}`, { code, name });
    if (code !== 'EPIPE' && code !== 'ECONNRESET') process.exit(1);
  });
}

const config = loadConfig();
if (!existsSync(config.catalogFile)) {
  console.error(`Model catalog not found at ${config.catalogFile}. Run \`bun run catalog\` first.`);
  process.exit(1);
}
if (!existsSync(config.summaryKeyFile)) {
  mkdirSync(dirname(config.summaryKeyFile), { recursive: true, mode: 0o700 });
  writeFileSync(config.summaryKeyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
}

const server = startRouter({
  port: config.port,
  authFile: config.authFile,
  catalog: config.catalogFile,
  summaryKeyFile: config.summaryKeyFile,
  upstreamTimeoutMs: config.upstreamTimeoutMs,
  bridgeModels: config.bridgeModels,
  secondaryAccount: config.secondaryAccount,
  primaryStandard: config.primaryStandard,
});
console.log(`codex-subscription-proxy listening on http://127.0.0.1:${server.port}`);
