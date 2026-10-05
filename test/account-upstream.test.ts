import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AccountUpstream, nativeAccountRequest, standardPrimaryFetch, type AccountOptions } from '../src/router/account-upstream';
import { startRouter } from '../src/router/server';
import { buildCatalog } from '../src/catalog';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const jwt = (value: unknown) => 'fixture.' + Buffer.from(JSON.stringify(value)).toString('base64url') + '.fixture';
async function fixture(expires = Date.now() / 1000 + 3600) {
  const home = await mkdtemp(tmpdir() + '/secondary-auth-'); dirs.push(home);
  const options: AccountOptions = { home, prefix: 'secondary', binary: 'unused', expectedEmail: 'secondary@example.com', expectedAccountId: 'secondary-space' };
  const write = (exp: number, email = 'secondary@example.com', account = 'secondary-space') => Bun.write(home + '/auth.json', JSON.stringify({
    auth_mode: 'chatgpt', tokens: { access_token: jwt({ exp }), id_token: jwt({ email }), account_id: account },
  }));
  await write(expires);
  await Bun.write(home + '/models_cache.json', JSON.stringify({ models: [
    { slug: 'gpt-6-astra', visibility: 'list', service_tiers: [{ id: 'priority' }, { id: 'ultrafast' }] },
    { slug: 'gpt-6.1-sol', visibility: 'list', service_tiers: [{ id: 'priority' }] },
  ] }));
  return { home, options, write };
}
const target = 'https://chatgpt.com/backend-api/codex/responses';
const request = (model: string, service_tier = 'default', effort = 'high'): RequestInit => ({
  method: 'POST', headers: { authorization: 'Bearer primary-token', 'chatgpt-account-id': 'primary-space' },
  body: JSON.stringify({ model, service_tier, reasoning: { effort }, input: [{ role: 'user', content: 'synthetic' }] }),
});

test('only account aliases replace credentials; effort and service tier survive every variant', async () => {
  const { options } = await fixture();
  const calls: Request[] = [];
  const router = new AccountUpstream(options, async (url, init) => { calls.push(new Request(url, init)); return new Response('{}'); });
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
    for (const speed of model === 'gpt-6-astra' ? ['default', 'priority', 'ultrafast'] : ['default', 'priority']) {
      for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
        await router.fetch(target, request('secondary-' + model, speed, effort));
        const call = calls.at(-1)!;
        expect(call.headers.get('authorization')).not.toBe('Bearer primary-token');
        expect(call.headers.get('chatgpt-account-id')).toBe('secondary-space');
        expect(await call.json()).toMatchObject({ model, service_tier: speed, reasoning: { effort } });
      }
    }
  }
  await router.fetch(target, request('gpt-6.1-sol'));
  expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer primary-token');
  expect(calls.at(-1)!.headers.get('chatgpt-account-id')).toBe('primary-space');
});

test('missing login, wrong identity/workspace, unknown slug and foreign origin never fall back', async () => {
  const { home, options, write } = await fixture(); let calls = 0;
  const router = new AccountUpstream(options, async () => { calls++; return new Response('{}'); });
  await expect(router.fetch(target, request('secondary-unknown'))).rejects.toThrow('Unsupported secondary');
  await expect(router.fetch('https://example.com/responses', request('secondary-gpt-6-astra'))).rejects.toThrow('native Codex backend');
  for (const [email, account] of [['primary@example.com', 'secondary-space'], ['secondary@example.com', 'primary-space']]) {
    await write(Date.now() / 1000 + 3600, email, account);
    await expect(router.fetch(target, request('secondary-gpt-6-astra'))).rejects.toThrow('Primary account was not used');
  }
  await rm(home + '/auth.json');
  await expect(router.fetch(target, request('secondary-gpt-6-astra'))).rejects.toThrow('Primary account was not used');
  expect(calls).toBe(0);
});

test('fixed speeds follow the account through switches, overriding a stale client toggle', async () => {
  const { home, options } = await fixture(); options.fastest = true;
  const bodies: Array<{ model: string; service_tier: string }> = [];
  const router = { fetch: standardPrimaryFetch(new AccountUpstream(options, async (_, init) => {
    bodies.push(JSON.parse(String(init.body)) as { model: string; service_tier: string }); return new Response('{}');
  }).fetch) };
  for (const [model, stale, expected] of [
    ['secondary-gpt-6-astra', 'default', 'ultrafast'],
    ['gpt-6.1-sol', 'ultrafast', 'default'],
    ['secondary-gpt-6.1-sol', 'default', 'priority'],
    ['gpt-6-astra', 'priority', 'default'],
  ]) {
    await router.fetch(target, request(model!, stale)); expect(bodies.at(-1)!.service_tier).toBe(expected);
  }
  await Bun.write(home + '/models_cache.json', JSON.stringify({ models: [
    { slug: 'gpt-6-astra', visibility: 'list', service_tiers: [{ id: 'priority' }] },
  ] }));
  await router.fetch(target, request('secondary-gpt-6-astra', 'ultrafast'));
  expect(bodies.at(-1)!.service_tier).toBe('priority');
});

test('concurrent expired requests share native refresh and re-read the renewed identity', async () => {
  const { options, write } = await fixture(0); let refreshes = 0, calls = 0;
  options.refresh = async () => { refreshes++; await new Promise(resolve => setTimeout(resolve, 20)); await write(Date.now() / 1000 + 3600); };
  const router = new AccountUpstream(options, async () => { calls++; return new Response('{}'); });
  await Promise.all(Array.from({ length: 5 }, () => router.fetch(target, request('secondary-gpt-6-astra'))));
  expect(refreshes).toBe(1); expect(calls).toBe(5);
  await write(0); options.refresh = async () => { throw new Error('synthetic secret must not be surfaced'); };
  await expect(router.fetch(target, request('secondary-gpt-6-astra'))).rejects.toThrow('Secondary Codex login unavailable');
  expect(calls).toBe(5);
});

test('account catalog inherits secondary entitlements without modifying primary rows', () => {
  const native = { models: [{ slug: 'gpt-6-astra', display_name: 'Astra', visibility: 'list', service_tiers: ['priority'], priority: 1 }] };
  const secondary = { models: [{ ...native.models[0], service_tiers: ['priority', 'ultrafast'], supported_reasoning_levels: [{ effort: 'max' }, { effort: 'ultra' }] }] };
  const result = buildCatalog(native, { cache: secondary, prefix: 'secondary', label: 'Secondary' });
  expect(result.models[0]).toEqual(native.models[0]!);
  const work = result.models.find(row => row.slug === 'secondary-gpt-6-astra')!;
  expect(work.display_name).toBe('Astra (Secondary)');
  expect(work.service_tiers).toEqual(['priority', 'ultrafast']);
  expect(work.supported_reasoning_levels).toEqual([{ effort: 'max' }, { effort: 'ultra' }]);
});

test('HTTP and WebSocket routes require primary client auth and send Secondary turns with secondary auth', async () => {
  const { home, options } = await fixture();
  options.fastest = true;
  await Bun.write(home + '/client.json', JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'primary-token', account_id: 'primary-space' } }));
  await Bun.write(home + '/catalog.json', '{}');
  let calls = 0;
  const server = startRouter({ port: 0, authFile: home + '/client.json', catalog: home + '/catalog.json', secondaryAccount: options, primaryStandard: true,
    upstreamFetch: async (url, init) => {
      const req = new Request(url, init), body = await req.json() as { model: string; service_tier: string };
      const secondary = req.headers.get('chatgpt-account-id') === 'secondary-space';
      expect(body.model).toBe('gpt-6-astra'); expect(body.service_tier).toBe(secondary ? 'ultrafast' : 'default'); calls++;
      return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'response-fixture', output: [] } }) + '\n\n');
    },
  });
  try {
    const init = request('secondary-gpt-6-astra', 'ultrafast');
    const response = await fetch(server.url + 'v1/responses', init);
    expect(response.status).toBe(200); await response.text();
    const invalid = { ...init, headers: { authorization: 'Bearer stranger' } };
    expect((await fetch(server.url + 'v1/responses', invalid)).status).toBe(401);
    await new Promise<void>((resolve, reject) => {
      const Socket = WebSocket as unknown as { new(url: string, options: { headers?: HeadersInit }): WebSocket };
      const ws = new Socket(String(server.url).replace('http:', 'ws:') + 'v1/responses', { headers: init.headers });
      const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket timeout')); }, 5000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'response.create', response: JSON.parse(String(init.body)) as unknown }));
      ws.onmessage = event => { const value = JSON.parse(String(event.data)) as { type: string }; if (value.type === 'response.completed') { clearTimeout(timer); ws.close(); resolve(); } };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket failed')); };
    });
    const primary = await fetch(server.url + 'v1/responses', request('gpt-6-astra', 'ultrafast'));
    expect(primary.status).toBe(200); await primary.text();
    expect(calls).toBe(3);
  } finally { server.stop(true); }
});

test('discovers new account models and excludes unavailable or unselected aliases', async () => {
  const { home, options } = await fixture();
  const cache = { models: [
    { slug: 'gpt-future', display_name: 'Future', visibility: 'list', service_tiers: [] },
    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
    { slug: 'claude-unrelated', display_name: 'Unrelated', visibility: 'list' },
  ] };
  await Bun.write(home + '/models_cache.json', JSON.stringify(cache));
  let calls = 0;
  const router = new AccountUpstream(options, async (_, init) => {
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-future' }); calls++; return new Response('{}');
  });
  await router.fetch(target, request('secondary-gpt-future'));
  for (const model of ['secondary-gpt-hidden', 'secondary-gpt-unknown', 'secondary-claude-unrelated']) {
    await expect(router.fetch(target, request(model))).rejects.toThrow('Unsupported secondary');
  }
  options.models = ['gpt-6-astra'];
  await expect(router.fetch(target, request('secondary-gpt-future'))).rejects.toThrow('Unsupported secondary');
  expect(calls).toBe(1);
  const native = { models: [{ slug: 'gpt-main', visibility: 'list', priority: 1 }] };
  expect(buildCatalog(native, { cache, prefix: 'secondary', label: 'Custom' }).models.filter(row => String(row.slug).startsWith('secondary-')).map(row => row.slug)).toEqual(['secondary-gpt-future']);
  expect(() => buildCatalog(native, { cache, prefix: 'secondary', label: 'Custom', models: ['gpt-hidden'] })).toThrow('no selected available');
});

test('reserved model namespaces cannot hijack existing provider rows', async () => {
  const { options } = await fixture();
  for (const prefix of ['gpt', 'claude', 'grok', 'opus', 'Bad Prefix']) {
    expect(() => new AccountUpstream({ ...options, prefix }, async () => new Response('{}'))).toThrow('distinct lowercase namespace');
  }
});

test('primary-only standard policy leaves hosted tools, aliases, and foreign origins untouched', async () => {
  const calls: Request[] = [];
  const route = standardPrimaryFetch(async (url, init) => { calls.push(new Request(url, init)); return new Response('{}'); });
  await route(target, { ...request('gpt-future', 'priority'), headers: { 'content-length': '999' } });
  expect(await calls.at(-1)!.json()).toMatchObject({ service_tier: 'default' });
  expect(calls.at(-1)!.headers.get('content-length')).toBeNull();
  for (const [url, model] of [
    ['https://chatgpt.com/backend-api/codex/images/generations', 'gpt-image'],
    ['https://chatgpt.com/backend-api/codex/alpha/search', 'gpt-future'],
    ['https://example.com/backend-api/codex/responses', 'gpt-future'],
    [target, 'secondary-gpt-future'],
  ]) {
    await route(url!, request(model!, 'priority'));
    expect(await calls.at(-1)!.json()).toMatchObject({ service_tier: 'priority' });
  }
  const result = buildCatalog({ models: [{ slug: 'gpt-future', visibility: 'list', service_tiers: ['priority'], additional_speed_tiers: ['fast'] }] }, undefined, true);
  expect(result.models[0]).toMatchObject({ service_tiers: [], additional_speed_tiers: [], default_service_tier: 'default' });
});

test('native account request and cache command operate on an isolated profile without model generation', async () => {
  const { home, options } = await fixture();
  const binary = home + '/native-fixture';
  await Bun.write(binary, `#!${process.execPath}\n` + `
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
const lines=createInterface({input:process.stdin});
for await (const line of lines) {
 const message=JSON.parse(line);
 if(message.id===1) console.log(JSON.stringify({id:1,result:{}}));
 if(message.id===2) {
  if(message.method==='model/list') writeFileSync(process.env.CODEX_HOME+'/models_cache.json',JSON.stringify({models:[{slug:'gpt-fixture',visibility:'list'}]}));
  if(!['account/read','model/list'].includes(message.method)) process.exit(2);
  console.log(JSON.stringify({id:2,result:{synthetic:true}}));
 }
}
`);
  await chmod(binary, 0o700);
  options.binary = binary;
  expect(await nativeAccountRequest(options, 'account/read', { refreshToken: true })).toEqual({ synthetic: true });
  const child = Bun.spawn([process.execPath, 'scripts/account-cache.ts'], {
    env: { ...process.env, ACCOUNT_CODEX_HOME: home, ACCOUNT_CODEX_BINARY: binary, ACCOUNT_MODELS: 'gpt-fixture', ACCOUNT_MODEL_PREFIX: 'secondary' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(err).toBe(''); expect(status).toBe(0); expect(out).toContain('1 available models');
});
