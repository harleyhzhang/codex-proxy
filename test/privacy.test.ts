import { expect, test } from 'bun:test';
import { BackendError, retryOnce } from '../src/backends/contract';
import { EMPTY_OUTPUT } from '../src/protocol/types';
import { AUTH_HEADERS, fixtureRouter } from './support';

const PRIVATE_TEXT = 'unquoted private prompt fixture';

async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const warn = console.warn, log = console.log;
  console.warn = console.log = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
  try { return { result: await run(), lines }; }
  finally { console.warn = warn; console.log = log; }
}

async function socketTurn(router: Awaited<ReturnType<typeof fixtureRouter>>, body: unknown): Promise<string> {
  const Socket = WebSocket as unknown as { new (url: string, options: { headers: Record<string, string> }): WebSocket };
  const socket = new Socket(router.url('/v1/responses').replace('http:', 'ws:'), { headers: AUTH_HEADERS });
  try {
    return await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('fixture socket timeout')), 2000);
      socket.onopen = () => socket.send(JSON.stringify(body));
      socket.onmessage = event => { clearTimeout(timeout); resolve(String(event.data)); };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('fixture socket connection failed')); };
    });
  } finally { socket.close(); }
}

test('provider refusals retain client diagnostics without logging their text or the supplied model', async () => {
  const { result, lines } = await captureLogs(async () => {
    const router = await fixtureRouter({ upstreamFetch: async () => Response.json({ error: { message: PRIVATE_TEXT } }, { status: 400 }) });
    try {
      return await socketTurn(router, { type: 'response.create', model: 'gpt-unquoted-private-model-fixture', input: [{ role: 'user', content: PRIVATE_TEXT }] });
    } finally { await router.close(); }
  });
  expect(result).toContain(PRIVATE_TEXT);
  expect(lines.join('\n')).not.toContain(PRIVATE_TEXT);
  expect(lines.join('\n')).not.toContain('gpt-unquoted-private-model-fixture');
  expect(lines.some(line => JSON.parse(line).event === 'upstream')).toBe(true);
});

test('HTTP and socket router failures omit freeform error names, messages and unknown endpoint paths from logs', async () => {
  const { result, lines } = await captureLogs(async () => {
    const router = await fixtureRouter({ upstreamFetch: async () => {
      const error = new Error(`Unsupported ${PRIVATE_TEXT}`);
      error.name = PRIVATE_TEXT;
      throw error;
    } });
    try {
      const body = { model: 'gpt-fixture', input: [] };
      const http = await fetch(router.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify(body) });
      const socket = await socketTurn(router, { type: 'response.create', ...body });
      await fetch(router.url('/private-endpoint-fixture'), { headers: AUTH_HEADERS });
      return { http: await http.text(), socket };
    } finally { await router.close(); }
  });
  expect(result.http).toContain(PRIVATE_TEXT);
  expect(result.socket).toContain(PRIVATE_TEXT);
  expect(lines.join('\n')).not.toContain(PRIVATE_TEXT);
  expect(lines.join('\n')).not.toContain('private-endpoint-fixture');
  expect(lines.some(line => JSON.parse(line).event === 'http-failed')).toBe(true);
  expect(lines.some(line => JSON.parse(line).event === 'failed')).toBe(true);
});

test('retry logging never copies a retryable backend diagnostic', async () => {
  let attempts = 0;
  const { result, lines } = await captureLogs(() => retryOnce('fixture', undefined, async () => {
    if (++attempts === 1) throw new BackendError(PRIVATE_TEXT, { retryable: true });
    return EMPTY_OUTPUT;
  }));
  expect(result).toBe(EMPTY_OUTPUT);
  expect(attempts).toBe(2);
  expect(lines.join('\n')).not.toContain(PRIVATE_TEXT);
  expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'backend-retry', retryable: true, message_chars: PRIVATE_TEXT.length });
});
