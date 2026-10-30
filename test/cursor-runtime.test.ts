import { expect, test } from 'bun:test';
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createCursorBackend, type CursorBackend } from '../src/backends/cursor';
import { isRecord, sha256, type JsonRecord } from '../src/json';
import { responseObject } from '../src/protocol/output';
import type { ProxyOutput, ResponseInputItem, ResponsesRequest } from '../src/protocol/types';

type Fixture = { backend: CursorBackend; root: string; binary: string; auth: string; source: string; events(): Promise<JsonRecord[]> };
async function fixture(run: (fixture: Fixture) => Promise<void>, limit = 2): Promise<void> {
  const root = await mkdtemp(tmpdir() + '/cursor-runtime-');
  const binary = root + '/bridge', auth = root + '/auth.json';
  const source = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const root = ${JSON.stringify(root)};
const dir = process.argv[process.argv.indexOf('--workspace') + 1];
const event = (operation, fields = {}) => appendFileSync(root + '/events.jsonl', JSON.stringify({operation, pid: process.pid, ...fields}) + '\\n');
event('start');
const agents = new Map(); let next = 0;
const json = (value) => Response.json(value);
const frame = (value) => { const data = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(5); header.writeUInt32BE(data.length, 1); return Buffer.concat([header, data]); };
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
 const method = new URL(req.url).pathname.split('/').at(-1);
 if (method === 'Me') {
  if (process.env.CURSOR_API_KEY === 'blocked-profile') {
   if (!existsSync(root + '/profile-owner')) writeFileSync(root + '/profile-owner',String(process.pid));
   event('profile-start');
   if (readFileSync(root + '/profile-owner','utf8') === String(process.pid)) await new Promise(()=>{});
  }
  return json({user:{userEmail:process.env.CURSOR_API_KEY === 'wrong-owner' ? 'other@example.com' : 'test@example.com', userId:'fixture'}});
 }
 if (method === 'ListModels') return json({items:[{id:'kimi-k3',parameters:[{id:'reasoning',values:['low','high','max'].map(value=>({value}))}]}]});
 const bytes = Buffer.from(await req.arrayBuffer());
 const body = JSON.parse((method === 'Send' ? bytes.subarray(5) : bytes).toString());
 if (method === 'CreateAgent') { const agentId = process.pid + '-' + (++next); agents.set(agentId,{model:body.options.model,sends:0,marker:''}); event('create',{agentId,cwd:body.options.local.cwd[0]}); return json({agentId}); }
 const agent = agents.get(body.agentId);
 if (method === 'CancelRun') { event('cancel',{agentId:body.agentId,runId:body.runId}); return json({}); }
 if (method === 'CloseAgent') { event('close-start',{agentId:body.agentId}); if (agent?.slowClose) await Bun.sleep(350); if (agent?.failClose) return new Response('{}',{status:500}); agents.delete(body.agentId); event('close-end',{agentId:body.agentId}); return json({}); }
 if (method === 'Send') {
  if (!agent) return new Response('{}',{status:404});
  const text = body.message.text; agent.sends++; event('send',{agentId:body.agentId,text});
  const marker = text.match(/history-[A-Z]/)?.[0]; if (marker) agent.marker = marker;
  if (text.includes('SLOW_CLOSE')) agent.slowClose = true;
  if (text.includes('FAIL_CLOSE')) agent.failClose = true;
  const runId = 'run-' + body.agentId + '-' + agent.sends;
  if (text.includes('CANCEL_THIS')) return new Response(new ReadableStream({ start(c) {c.enqueue(frame({sdkMessage:{message:{runId}}}));} }),{headers:{'content-type':'application/connect+json'}});
  if (text.includes('SLOW_TURN')) await Bun.sleep(150);
  const output = text.includes('<tool_result') ? {text:(agent.sends > 1 ? 'continued:' : 'fresh:') + agent.marker, tool_calls:[]} : text.includes('first-tool') ? {text:'working',tool_calls:[{name:'echo',arguments:{value:'fixture'}}]} : {text:'ok',tool_calls:[]};
  const finished = 'RUN_LIFECYCLE_STATUS_FINISHED';
  return new Response(Buffer.concat([frame({result:{status:finished,runId,result:{status:finished,result:JSON.stringify(output),model:agent.model,usage:{inputTokens:10,outputTokens:2}}}}),frame({done:{runId}})]),{headers:{'content-type':'application/connect+json'}});
 }
 return new Response('{}',{status:404});
}});
await Bun.write(dir + '/token','fixture-token');
console.error('cursor-sdk-bridge ready ' + JSON.stringify({schemaVersion:1,host:'127.0.0.1',protocol:'connect',transport:'tcp',port:server.port,url:'http://127.0.0.1:' + server.port,authTokenFile:dir+'/token'}));
await new Promise(()=>{});
`;
  await writeFile(binary, source, { mode: 0o700 });
  await writeFile(auth, JSON.stringify({ apiKey: 'fixture-key', email: 'test@example.com', backendUrl: 'https://api2.cursor.sh' }), { mode: 0o600 });
  const saved = process.env.CURSOR_MAX_BRIDGES;
  process.env.CURSOR_MAX_BRIDGES = String(limit);
  const backend = createCursorBackend({ binary, binaryHash: sha256(source), authFile: auth, cwd: root, expectedEmail: 'test@example.com', expectedUserId: 'fixture', prefix: 'fixture', label: 'Fixture' });
  if (saved === undefined) delete process.env.CURSOR_MAX_BRIDGES; else process.env.CURSOR_MAX_BRIDGES = saved;
  const events = async () => (await readFile(root + '/events.jsonl', 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown).filter(isRecord);
  try { await run({ backend, root, binary, auth, source, events }); }
  finally { await backend.close(); await rm(root, { recursive: true, force: true }); }
}
const request = (text = 'first-tool history-A'): ResponsesRequest => ({ model: 'kimi-k3', input: [{ role: 'user', content: text }], instructions: 'Follow the user request.', tools: [{ type: 'function', name: 'echo', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }], reasoning: { effort: 'high' } });
function nextTurn(prior: ResponsesRequest, output: ProxyOutput): ResponsesRequest {
  if (!Array.isArray(prior.input)) throw new Error('expected input array');
  return { ...prior, input: [...prior.input, ...responseObject(prior, output).output as ResponseInputItem[], { type: 'function_call_output', call_id: output.toolCalls[0]?.callId, output: 'fixture-result' }] };
}
async function waitFor(events: Fixture['events'], operation: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try { if ((await events()).some(e => e.operation === operation)) return; } catch {}
    await Bun.sleep(5);
  }
  throw new Error('fixture event missing: ' + operation);
}

test('Cursor retains a verified agent only for its exact tool-history continuation and sends the delta', () => fixture(async f => {
  const first = request(), output = await f.backend.run(first);
  expect(output.toolCalls).toHaveLength(1);
  const next = nextTurn(first, output);
  const final = await f.backend.run(next);
  expect(final.text).toBe('continued:history-A');
  const events = await f.events();
  expect(events.filter(e => e.operation === 'start')).toHaveLength(1);
  expect(events.filter(e => e.operation === 'create')).toHaveLength(1);
  const sends = events.filter(e => e.operation === 'send');
  expect(sends[1]?.text).toContain('fixture-result');
  expect(sends[1]?.text).not.toContain('history-A');
  expect(sends[1]?.text).not.toContain('Follow the user request.');
}));

test('Cursor continuation tolerates Responses metadata reserialization without changing model-visible history', () => fixture(async f => {
  const first = request(), output = await f.backend.run(first);
  const next = nextTurn(first, output);
  if (!Array.isArray(next.input)) throw new Error('expected history');
  next.input = next.input.map(item => {
    const { id: _id, status: _status, ...rest } = item;
    return { ...rest, ...(Array.isArray(rest.content) ? { content: rest.content.map(part => ({ type: 'input_text', text: part.text })) } : {}) };
  });
  expect((await f.backend.run(next)).text).toBe('continued:history-A');
  expect((await f.events()).filter(e => e.operation === 'create')).toHaveLength(1);
}));

for (const change of ['history', 'instructions', 'effort', 'tools', 'call', 'missing-result'] as const) {
  test('Cursor replays a fresh agent when continuation changes ' + change, () => fixture(async f => {
    const first = request(), output = await f.backend.run(first);
    const next = nextTurn(first, output);
    if (!Array.isArray(next.input)) throw new Error('expected history');
    if (change === 'history') next.input[0] = { role: 'user', content: 'different branch history-B' };
    if (change === 'instructions') next.instructions = 'Changed instructions';
    if (change === 'effort') next.reasoning = { effort: 'max' };
    if (change === 'tools') next.tools = [{ type: 'function', name: 'echo', description: 'Changed contract', parameters: { type: 'object' } }];
    if (change === 'call') next.input[next.input.length - 2] = { ...next.input[next.input.length - 2], arguments: '{"value":"tampered"}' };
    if (change === 'missing-result') next.input.at(-1)!.call_id = 'foreign-call';
    expect((await f.backend.run(next)).text).toStartWith('fresh:');
    expect((await f.events()).filter(e => e.operation === 'create')).toHaveLength(2);
  }));
}

test('Cursor idle tool sessions yield their bridge immediately to unrelated work under the resident cap', () => fixture(async f => {
  const first = request(), output = await f.backend.run(first);
  expect(output.toolCalls).toHaveLength(1);
  expect((await f.backend.run(request('unrelated history-B'))).text).toBe('ok');
  await waitFor(f.events, 'close-end');
  expect((await f.backend.run(nextTurn(first, output))).text).toStartWith('fresh:');
  expect((await f.events()).filter(e => e.operation === 'start')).toHaveLength(1);
  const workspaces = (await f.events()).filter(e => e.operation === 'create').map(e => e.cwd);
  expect(new Set(workspaces).size).toBe(3);
}, 1));

test('Cursor releases validated output before slow CloseAgent but holds its exclusive cleanup lease', () => fixture(async f => {
  expect((await f.backend.run(request('SLOW_CLOSE'))).text).toBe('ok');
  expect((await f.events()).filter(e => e.operation === 'close-end')).toHaveLength(0);
  const second = f.backend.run(request('another turn'));
  await Bun.sleep(20);
  expect((await f.events()).filter(e => e.operation === 'create')).toHaveLength(1);
  expect((await second).text).toBe('ok');
  expect((await f.events()).filter(e => e.operation === 'start')).toHaveLength(1);
}, 1));

test('Cursor cancellation stops only its exclusive bridge; the other concurrent run completes', () => fixture(async f => {
  const controller = new AbortController();
  const cancelled = f.backend.run(request('CANCEL_THIS'), controller.signal).catch((error: unknown) => error);
  await waitFor(f.events, 'send');
  const other = f.backend.run(request('SLOW_TURN'));
  await Bun.sleep(20); controller.abort(new Error('cancel fixture'));
  expect(await cancelled).toBeInstanceOf(Error);
  expect((await other).text).toBe('ok');
  const events = await f.events();
  expect(events.filter(e => e.operation === 'start')).toHaveLength(2);
  expect(events.filter(e => e.operation === 'cancel')).toHaveLength(1);
}));

test('Cursor cold profile lookup cancellation cannot fail an uncancelled request sharing the same account', () => fixture(async f => {
  await writeFile(f.auth, JSON.stringify({ apiKey: 'blocked-profile', email: 'test@example.com', backendUrl: 'https://api2.cursor.sh' }));
  const controller = new AbortController();
  const owner = f.backend.run(request('cancel profile owner'), controller.signal).catch((error: unknown) => error);
  await waitFor(f.events, 'profile-start');
  const kept = f.backend.run(request('uncancelled profile waiter')).catch((error: unknown) => error);
  for (let i = 0; i < 200 && (await f.events()).filter(e => e.operation === 'start').length < 2; i++) await Bun.sleep(5);
  await Bun.sleep(50);
  controller.abort(new Error('cancel only profile owner'));
  expect(await owner).toBeInstanceOf(Error);
  const result = await kept;
  expect(result).not.toBeInstanceOf(Error);
  if (!isRecord(result)) throw new Error('expected uncancelled profile result');
  expect(result.text).toBe('ok');
  const events = await f.events();
  expect(events.filter(e => e.operation === 'profile-start')).toHaveLength(2);
  expect(events.filter(e => e.operation === 'send')).toHaveLength(1);
}));

test('Cursor failed asynchronous agent cleanup discards the bridge and frees queued capacity', () => fixture(async f => {
  expect((await f.backend.run(request('FAIL_CLOSE'))).text).toBe('ok');
  expect((await f.backend.run(request('after failed cleanup'))).text).toBe('ok');
  expect((await f.events()).filter(e => e.operation === 'start')).toHaveLength(2);
}, 1));

test('Cursor restarts a parked bridge that died without replaying its lost agent', () => fixture(async f => {
  const first = request(), output = await f.backend.run(first);
  const pid = (await f.events()).find(e => e.operation === 'start')?.pid;
  process.kill(Number(pid), 'SIGKILL');
  await Bun.sleep(10);
  expect((await f.backend.run(nextTurn(first, output))).text).toStartWith('fresh:');
  expect((await f.events()).filter(e => e.operation === 'start')).toHaveLength(2);
}));

test('Cursor revalidates executable pins after waiting behind another request', () => fixture(async f => {
  await f.backend.run(request('SLOW_CLOSE'));
  const queued = f.backend.run(request('queued')).catch((error: unknown) => error);
  await Bun.sleep(10);
  await appendFile(f.binary, '\n// changed while queued');
  expect(await queued).toBeInstanceOf(Error);
  expect(String(await queued)).toContain('pinned bridge changed');
  expect((await f.events()).filter(e => e.operation === 'send')).toHaveLength(1);
}, 1));

test('Cursor retries queued credential rotation using a fresh owner rather than the stale login', () => fixture(async f => {
  await f.backend.run(request('SLOW_CLOSE'));
  const queued = f.backend.run(request('queued'));
  await Bun.sleep(10);
  await writeFile(f.auth, JSON.stringify({ apiKey: 'rotated-in-queue', email: 'test@example.com', backendUrl: 'https://api2.cursor.sh' }));
  expect((await queued).text).toBe('ok');
  expect((await f.events()).filter(e => e.operation === 'send')).toHaveLength(2);
  expect((await f.events()).filter(e => e.operation === 'start')).toHaveLength(2);
}, 1));

test('Cursor rechecks binary bytes, credential ownership, and account identity before warm continuation', () => fixture(async f => {
  const first = request(), output = await f.backend.run(first);
  await appendFile(f.binary, '\n// changed');
  await expect(f.backend.run(nextTurn(first, output))).rejects.toThrow('pinned bridge changed');
  await writeFile(f.binary, f.source);
  await chmod(f.auth, 0o644);
  await expect(f.backend.run(nextTurn(first, output))).rejects.toThrow('owner-only');
  await chmod(f.auth, 0o600);
  await writeFile(f.auth, JSON.stringify({ apiKey: 'wrong-owner', email: 'test@example.com', backendUrl: 'https://api2.cursor.sh' }));
  await expect(f.backend.run(nextTurn(first, output))).rejects.toThrow('differs from the pinned identity');
  expect((await f.events()).filter(e => e.operation === 'send')).toHaveLength(1);
}));

test('Cursor credential rotation never inherits another key\'s retained agent', () => fixture(async f => {
  const first = request(), output = await f.backend.run(first);
  await writeFile(f.auth, JSON.stringify({ apiKey: 'rotated-key', email: 'test@example.com', backendUrl: 'https://api2.cursor.sh' }));
  expect((await f.backend.run(nextTurn(first, output))).text).toStartWith('fresh:');
  expect((await f.events()).filter(e => e.operation === 'start')).toHaveLength(2);
}));

test('Cursor kills retained SDK bridge children when their owning parent exits normally', () => fixture(async f => {
  const script = `
    import {createCursorBackend} from ${JSON.stringify(import.meta.dir + '/../src/backends/cursor.ts')};
    const backend = createCursorBackend(${JSON.stringify({ binary: f.binary, binaryHash: sha256(f.source), authFile: f.auth, cwd: f.root, expectedEmail: 'test@example.com', expectedUserId: 'fixture', prefix: 'exitfixture', label: 'Fixture' })});
    await backend.run(${JSON.stringify(request())});
    process.exit(0);
  `;
  const parent = Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'pipe' });
  const stderr = new Response(parent.stderr).text();
  expect(await parent.exited).toBe(0);
  await stderr;
  const bridgePid = (await f.events()).find(e => e.operation === 'start')?.pid;
  expect(typeof bridgePid).toBe('number');
  const alive = () => { try { process.kill(Number(bridgePid), 0); return true; } catch { return false; } };
  for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(5);
  expect(alive()).toBe(false);
}));

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
  test('router ' + signal + ' shutdown kills owned parked bridges and preserves the signal exit code', () => fixture(async f => {
    const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unused') });
    const port = portProbe.port; portProbe.stop(true);
    await Bun.write(f.root + '/catalog.json', '{"models":[]}');
    const ready = f.root + '/owner-ready';
    const script = `
      import {createCursorBackend} from ${JSON.stringify(import.meta.dir + '/../src/backends/cursor.ts')};
      await import(${JSON.stringify(import.meta.dir + '/../src/main.ts')});
      const backend = createCursorBackend(${JSON.stringify({ binary: f.binary, binaryHash: sha256(f.source), authFile: f.auth, cwd: f.root, expectedEmail: 'test@example.com', expectedUserId: 'fixture', prefix: 'exitfixture', label: 'Fixture' })});
      await backend.run(${JSON.stringify(request())});
      await Bun.write(${JSON.stringify(ready)}, 'ready');
      await new Promise(() => {});
    `;
    const parent = Bun.spawn([process.execPath, '-e', script], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.root, CODEX_HOME: f.root,
        PORT: String(port), CATALOG_FILE: f.root + '/catalog.json', PROXY_STATE_DIR: f.root + '/state' },
      stdout: 'ignore', stderr: 'pipe',
    });
    const stderr = new Response(parent.stderr).text();
    let bridgePid: number | undefined;
    const alive = () => { if (!bridgePid) return false; try { process.kill(bridgePid, 0); return true; } catch { return false; } };
    try {
      for (let i = 0; i < 500 && !(await Bun.file(ready).exists()) && parent.exitCode === null; i++) await Bun.sleep(5);
      expect(await Bun.file(ready).exists()).toBe(true);
      bridgePid = Number((await f.events()).find(e => e.operation === 'start')?.pid);
      expect(alive()).toBe(true);
      parent.kill(signal);
      expect(await parent.exited).toBe(code);
      await stderr;
      for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(5);
      expect(alive()).toBe(false);
    } finally {
      if (parent.exitCode === null) parent.kill('SIGKILL');
      if (alive()) process.kill(bridgePid!, 'SIGKILL');
      await parent.exited; await stderr;
    }
  }));
}
