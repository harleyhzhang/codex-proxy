import { expect, spyOn, test } from 'bun:test';
import { isRecord } from '../src/json';
import { AccountUpstream, standardPrimaryFetch } from '../src/router/account-upstream';
import { requestJson, requestOptions, rewriteJson } from '../src/router/json-request';
import { postJson, type UpstreamFetch } from '../src/router/upstream';

const target = 'https://chatgpt.com/backend-api/codex/responses';
const body = {
  model: 'gpt-6.1-sol', service_tier: 'default', reasoning: { effort: 'high' },
  benchmark_marker: 'prepared-json', input: [{ role: 'user', content: 'synthetic\\n"value"' }],
  future_field: { nested: [null, true, { opaque: 'preserve exactly' }] },
};
const chain = (base: UpstreamFetch) => standardPrimaryFetch(new AccountUpstream({ home: '/unused', prefix: 'secondary', binary: 'unused' }, base).fetch);

test('GPT policies share one parse and one initial serialization, preserving the exact default-tier body and signal', async () => {
  const encoded = JSON.stringify(body);
  const parses = spyOn(JSON, 'parse');
  const serializes = spyOn(JSON, 'stringify');
  const controller = new AbortController();
  controller.abort();
  try {
    let sent: RequestInit | undefined;
    await postJson(chain(async (_url, init) => { sent = init; return new Response('{}'); }), '/responses', new Headers(), body, controller.signal);
    expect(parses.mock.calls.filter(([text]) => text === encoded)).toHaveLength(1);
    expect(serializes.mock.calls.filter(([value]) => isRecord(value) && value.benchmark_marker === 'prepared-json')).toHaveLength(1);
    expect(sent?.body).toBe(encoded);
    expect(sent?.signal).toBe(controller.signal);
    expect(sent?.signal?.aborted).toBe(true);
    expect(sent?.redirect).toBe('error');
    expect(JSON.parse(String(sent?.body))).toEqual(body);
    expect(body.service_tier).toBe('default');
  } finally { parses.mockRestore(); serializes.mockRestore(); }
});

test('a needed tier rewrite is serialized once and its parsed snapshot survives the next account adapter', async () => {
  const original = { ...body, service_tier: 'priority' };
  const encoded = JSON.stringify(original);
  const parses = spyOn(JSON, 'parse');
  const serializes = spyOn(JSON, 'stringify');
  try {
    let sent: RequestInit | undefined;
    const init: RequestInit = { body: encoded, headers: { 'content-length': '999' }, cache: 'no-store' };
    await chain(async (_url, forwarded) => { sent = forwarded; return new Response('{}'); })(target, init);
    expect(parses.mock.calls.filter(([text]) => text === encoded)).toHaveLength(1);
    expect(serializes.mock.calls.filter(([value]) => isRecord(value) && value.benchmark_marker === 'prepared-json')).toHaveLength(1);
    expect(new Headers(sent?.headers).has('content-length')).toBe(false);
    expect(sent?.cache).toBe('no-store');
    expect(JSON.parse(String(sent?.body))).toEqual({ ...body, service_tier: 'default' });
    expect(init.body).toBe(encoded);
  } finally { parses.mockRestore(); serializes.mockRestore(); }
});

test('external initializers, replaced bodies and transport copies never reuse a stale parsed value', () => {
  const init: RequestInit = { body: '{"model":"gpt-first","future":1}' };
  const first = requestJson(init);
  expect(requestJson(init)).toBe(first);
  const copied = requestOptions(init, { credentials: 'omit' });
  expect(requestJson(copied)).toBe(first);
  init.body = '{"model":"gpt-second","future":2}';
  expect(requestJson(init)).toEqual({ model: 'gpt-second', future: 2 });
  expect(requestJson(copied)).toEqual({ model: 'gpt-first', future: 1 });
  const rewritten = rewriteJson(init, { service_tier: 'priority' });
  expect(requestJson(rewritten)).toEqual({ model: 'gpt-second', future: 2, service_tier: 'priority' });
  rewritten.body = '{"model":"gpt-third"}';
  expect(requestJson(rewritten)).toEqual({ model: 'gpt-third' });
  init.body = 'not json'; expect(requestJson(init)).toBeUndefined();
  init.body = '[]'; expect(requestJson(init)).toBeUndefined();
  init.body = new Uint8Array([123, 125]); expect(requestJson(init)).toBeUndefined();
});

test('a default-tier external request still strips a stale length without reserializing unknown fields', async () => {
  const encoded = '{ "model":"gpt-6.1-sol", "service_tier":"default", "future": [1,2] }';
  const init: RequestInit = { body: encoded, headers: { 'content-length': '999' } };
  await chain(async (_url, sent) => {
    expect(sent.body).toBe(encoded);
    expect(new Headers(sent.headers).has('content-length')).toBe(false);
    return new Response('{}');
  })(target, init);
});
