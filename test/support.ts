// Shared fixtures for tests that exercise the router end to end.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLocalModel } from '../src/backends/registry';
import type { ResponseInputItem, ResponsesBody } from '../src/protocol/types';
import type { ForeignSummary, SummaryCodec } from '../src/router/capsule';
import { type RouterOptions, startRouter } from '../src/router/server';

/** Unwraps capsules the way the router does, routing by the body's own model. */
export function unwrap(codec: SummaryCodec, body: ResponsesBody, foreign?: ForeignSummary) {
  return codec.unwrap(body, isLocalModel(body.model), foreign);
}

/** The body's input as items; fails the test if it is missing or a bare string. */
export function items(body: ResponsesBody): ResponseInputItem[] {
  if (!Array.isArray(body.input)) throw new Error('expected input items');
  return body.input;
}

/** The text of a message item's first content part. */
export function firstText(item: ResponseInputItem | undefined): string {
  const content = item?.content;
  if (typeof content === 'string') return content;
  return content?.[0]?.text ?? '';
}

export const AUTH_HEADERS = {
  authorization: 'Bearer fixture-token',
  'chatgpt-account-id': 'fixture-account',
  'content-type': 'application/json',
};

/** Starts a router on a random port with fixture credentials and an empty catalog. */
export async function fixtureRouter(options: Partial<RouterOptions> & { summaryKey?: Buffer } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'csp-router-'));
  await Bun.write(
    join(dir, 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-token', account_id: 'fixture-account' } }),
  );
  await Bun.write(join(dir, 'catalog.json'), '{"models":[]}');
  if (options.summaryKey) await Bun.write(join(dir, 'summary.key'), options.summaryKey);
  const server = startRouter({
    port: 0,
    authFile: join(dir, 'auth.json'),
    catalog: join(dir, 'catalog.json'),
    ...(options.summaryKey ? { summaryKeyFile: join(dir, 'summary.key') } : {}),
    ...options,
  });
  return {
    dir,
    server,
    url: (path: string) => new URL(path, server.url).toString(),
    async close() {
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
