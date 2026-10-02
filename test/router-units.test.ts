import { afterAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeBody, MAX_BODY_BYTES } from '../src/protocol/stream';
import type { ResponseObject } from '../src/protocol/types';
import { equalSecret, NativeAuth } from '../src/router/auth';
import { FOREIGN_HISTORY_ERROR, SummaryCodec } from '../src/router/capsule';
import { HistoryCache, HistoryMiss } from '../src/router/history';
import { jsonHeaders, upstreamErrorDetail, upstreamHeaders } from '../src/router/upstream';

const dir = mkdtempSync(join(tmpdir(), 'csp-units-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeAuth(token: string, account = 'acct'): string {
  const file = join(dir, 'auth.json');
  writeFileSync(file, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, account_id: account } }));
  return file;
}

describe('NativeAuth', () => {
  test('compares secrets exactly', () => {
    expect(equalSecret('abc', 'abc')).toBe(true);
    expect(equalSecret('abc', 'abd')).toBe(false);
    expect(equalSecret('abc', 'abcd')).toBe(false);
  });

  test('accepts only the token Codex stores, with a matching account', async () => {
    const auth = new NativeAuth(writeAuth('one'));
    expect(await auth.accepts(new Headers({ authorization: 'Bearer one' }))).toBe(true);
    expect(await auth.accepts(new Headers({ authorization: 'Bearer one', 'chatgpt-account-id': 'acct' }))).toBe(true);
    expect(await auth.accepts(new Headers({ authorization: 'Bearer one', 'chatgpt-account-id': 'other' }))).toBe(false);
    expect(await auth.accepts(new Headers({ authorization: 'Bearer two' }))).toBe(false);
    expect(await auth.accepts(new Headers())).toBe(false);
  });

  test('rejects browser requests even with a valid token', async () => {
    const auth = new NativeAuth(writeAuth('one'));
    expect(await auth.accepts(new Headers({ authorization: 'Bearer one', origin: 'https://evil.example' }))).toBe(false);
  });

  test('keeps the previous token valid briefly after a rotation', async () => {
    const auth = new NativeAuth(writeAuth('old'));
    expect(await auth.accepts(new Headers({ authorization: 'Bearer old' }))).toBe(true);
    writeAuth('new');
    expect(await auth.accepts(new Headers({ authorization: 'Bearer new' }))).toBe(true);
    expect(await auth.accepts(new Headers({ authorization: 'Bearer old' }))).toBe(true);
  });

  test('fails closed when auth.json is missing or not a ChatGPT login', async () => {
    expect(await new NativeAuth(join(dir, 'missing.json')).accepts(new Headers({ authorization: 'Bearer x' }))).toBe(false);
    const apiKey = join(dir, 'apikey.json');
    writeFileSync(apiKey, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'x' }));
    expect(await new NativeAuth(apiKey).accepts(new Headers({ authorization: 'Bearer x' }))).toBe(false);
  });
});

describe('HistoryCache', () => {
  const response = (id: string, output: ResponseObject['output']): ResponseObject =>
    ({ id, object: 'response', status: 'completed', model: 'm', output }) as ResponseObject;

  test('replays the stored conversation in place of previous_response_id', () => {
    const cache = new HistoryCache();
    const first = { type: 'message', role: 'user', content: 'hi' };
    const reply = { type: 'message', role: 'assistant', content: 'hello' };
    cache.remember({ input: [first] }, response('r1', [reply]));
    const expanded = cache.expand({ previous_response_id: 'r1', input: 'next' });
    expect(expanded).not.toHaveProperty('previous_response_id');
    expect(expanded.input).toEqual([first, reply, { role: 'user', content: 'next' }]);
  });

  test('a compaction starts a fresh history', () => {
    const cache = new HistoryCache();
    const compaction = { type: 'compaction', encrypted_content: 'c' };
    cache.remember({ input: [{ role: 'user', content: 'old' }] }, response('r1', [compaction]));
    expect(cache.expand({ previous_response_id: 'r1', input: [] }).input).toEqual([compaction]);
  });

  test('an unknown id asks Codex to resend everything', () => {
    expect(() => new HistoryCache().expand({ previous_response_id: 'gone', input: [] })).toThrow(HistoryMiss);
  });

  test('bodies without previous_response_id pass through untouched', () => {
    const body = { input: [] };
    expect(new HistoryCache().expand(body)).toBe(body);
  });
});

describe('upstream headers', () => {
  const incoming = new Headers({
    authorization: 'Bearer t',
    host: 'localhost',
    origin: 'x',
    'content-length': '5',
    'content-encoding': 'zstd',
    'sec-websocket-key': 'k',
    'x-codex-turn-metadata': 'm',
  });

  test('strips hop-by-hop and browser headers', () => {
    const headers = upstreamHeaders(incoming);
    expect(headers.get('authorization')).toBe('Bearer t');
    for (const name of ['host', 'origin', 'content-length', 'sec-websocket-key']) expect(headers.has(name)).toBe(false);
  });

  test('JSON headers describe the re-serialised body', () => {
    const headers = jsonHeaders(incoming);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.has('content-encoding')).toBe(false);
    expect(headers.get('x-codex-turn-metadata')).toBe('m');
    expect(jsonHeaders(incoming, { eventStream: false }).has('accept')).toBe(false);
    expect(jsonHeaders(incoming, { stripCodexMetadata: true }).has('x-codex-turn-metadata')).toBe(false);
  });

  test('error details are short and never throw', async () => {
    expect(await upstreamErrorDetail(new Response(JSON.stringify({ error: { message: 'nope' } })))).toBe('nope');
    expect(await upstreamErrorDetail(new Response(JSON.stringify({ detail: 'x'.repeat(500) })))).toHaveLength(300);
    expect(await upstreamErrorDetail(new Response('<html>'))).toBe('');
  });
});

describe('decodeBody', () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request('http://localhost/', { method: 'POST', body, headers });

  test('reads plain and zstd JSON objects', async () => {
    expect(await decodeBody(post('{"a":1}'))).toEqual({ a: 1 });
    const zstd = new Uint8Array(Bun.zstdCompressSync(Buffer.from('{"b":2}')));
    expect(await decodeBody(post(zstd, { 'content-encoding': 'zstd' }))).toEqual({ b: 2 });
  });

  test('rejects anything that is not a JSON object', async () => {
    for (const body of ['[1]', '"text"', 'null', '3']) {
      await expect(decodeBody(post(body))).rejects.toThrow('Request body must be a JSON object');
    }
    await expect(decodeBody(post('{'))).rejects.toThrow();
  });

  test('rejects unknown encodings and oversized bodies', async () => {
    await expect(decodeBody(post('{}', { 'content-encoding': 'gzip' }))).rejects.toThrow('Unsupported request encoding');
    await expect(decodeBody(post('{}', { 'content-length': String(MAX_BODY_BYTES + 1) }))).rejects.toThrow('Request too large');
  });
});

describe('SummaryCodec', () => {
  const codec = new SummaryCodec(randomBytes(32));

  test('requires a 256-bit key', () => {
    expect(() => new SummaryCodec(randomBytes(16))).toThrow('Invalid local summary key');
  });

  test('round-trips text and never repeats a ciphertext', () => {
    const sealed = codec.seal('secret context');
    expect(sealed.startsWith('ccp_v1.')).toBe(true);
    expect(sealed).not.toBe(codec.seal('secret context'));
    expect(codec.open(sealed)).toBe('secret context');
  });

  test('rejects tampered capsules, foreign keys and OpenAI ciphertext', () => {
    const sealed = codec.seal('payload');
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA');
    expect(() => codec.open(tampered)).toThrow();
    expect(() => new SummaryCodec(randomBytes(32)).open(sealed)).toThrow();
    expect(() => codec.open('gAAAAforeign')).toThrow(FOREIGN_HISTORY_ERROR);
  });
});
