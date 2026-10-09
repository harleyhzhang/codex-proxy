import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAccount, configuredClaudeAccount, createClaudeAccountBackend } from '../src/backends/claude';
import { claudeUsageSnapshot } from '../src/backends/claude-limits';

async function fixtures() {
  const dir = await mkdtemp(join(tmpdir(), 'claude-accounts-'));
  const binary = join(dir, 'mock-cli');
  const primary = join(dir, 'personal'), secondary = join(dir, 'work');
  await mkdir(primary); await mkdir(secondary);
  await Bun.write(binary, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
const label = basename(process.env.CLAUDE_CONFIG_DIR);
if (process.argv.includes('status')) {
  console.log(JSON.stringify({loggedIn: true, email: label + '@example.com', orgId: label}));
  process.exit(0);
}
const model = process.argv[process.argv.indexOf('--model') + 1];
for await (const line of createInterface({input: process.stdin})) {
  const prompt = JSON.parse(line).message.content[0].text;
  const forbidden = ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_HOST_CREDS_FILE'].some(k => process.env[k]);
  if (forbidden) process.exit(99);
  console.log(JSON.stringify({type: 'rate_limit_event', rate_limit_info: {status:'allowed', unifiedWindows:{five_hour:{utilization:label==='work' ? 0.4 : 0.2}}}}));
  console.log(JSON.stringify({type:'result', is_error:false, structured_output:{text: label+'|'+model+'|'+process.pid, tool_calls: prompt.includes('PLAN_ONCE') && !prompt.includes('DONE_RECEIPT') ? [{name:'step',arguments:'{}'}] : []}}));
}
`);
  await chmod(binary, 0o700);
  return {dir, binary, primary, secondary, close: () => rm(dir, {recursive: true, force: true})};
}

test('separate Claude profiles run the same native model concurrently and only continue their own workers', async () => {
  const f = await fixtures();
  const personal = new ClaudeAccount({binary: f.binary, configDir: f.primary, expectedEmail:'personal@example.com'});
  const work = createClaudeAccountBackend({binary:f.binary, configDir:f.secondary, prefix:'team', label:'Team', expectedEmail:'work@example.com', expectedOrg:'work'});
  const tools = [{type:'function', name:'step', parameters:{type:'object'}}];
  const request = {model:'claude-opus-5-5', input:'PLAN_ONCE', tools};
  let personalEvents=0, workEvents=0;
  personal.onRateLimit(() => personalEvents++); work.account.onRateLimit(() => workEvents++);
  try {
    const [a,b] = await Promise.all([personal.run(request), work.backend.run(request)]);
    expect(a.text.split('|').slice(0,2)).toEqual(['personal','claude-opus-5-5']);
    expect(b.text.split('|').slice(0,2)).toEqual(['work','claude-opus-5-5']);
    expect(a.text.split('|')[2]).not.toBe(b.text.split('|')[2]);
    const receipt = (call: typeof a.toolCalls[number]) => ({model:request.model, tools, input:[
      {role:'user', content:'PLAN_ONCE'},
      {type:'function_call', name:call.name, call_id:call.callId, arguments:call.arguments},
      {type:'function_call_output', call_id:call.callId, output:'DONE_RECEIPT'},
    ]});
    const continued = await personal.run(receipt(a.toolCalls[0]!));
    expect(continued.text).toBe(a.text);
    const switched = await work.backend.run(receipt(a.toolCalls[0]!));
    expect(switched.text.split('|')[0]).toBe('work');
    expect(switched.text.split('|')[2]).not.toBe(a.text.split('|')[2]);
    expect(switched.text.split('|')[2]).not.toBe(b.text.split('|')[2]);
    const workContinued = await work.backend.run(receipt(b.toolCalls[0]!));
    expect(workContinued.text).toBe(b.text);
    expect(personalEvents).toBe(2); expect(workEvents).toBe(3);
    personal.limits.restore(claudeUsageSnapshot({status:'rejected',unifiedWindows:{five_hour:{utilization:1,resetsAt:Math.floor(Date.now()/1000)+1000}}}));
    await expect(personal.run({model:request.model,input:'hello'})).rejects.toThrow('limit reached');
    expect((await work.backend.run({model:request.model,input:'hello'})).text).toContain('work|');
  } finally { for (const account of [personal,work.account]) for (const worker of account.workers.values()) worker.close(); await f.close(); }
}, 10000);

test('identity and organization mismatches refuse before any generation; credentials are scrubbed', async () => {
  const f = await fixtures();
  const keys = ['ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_HOST_CREDS_FILE'];
  const previous = keys.map(k => process.env[k]);
  try {
    for (const key of keys) process.env[key]='fixture-secret';
    const right = new ClaudeAccount({binary:f.binary,configDir:f.secondary,expectedEmail:'work@example.com',expectedOrg:'work'});
    expect((await right.run({model:'claude-fable-5-1',input:'hello'})).text).toContain('work|claude-fable-5-1');
    for (const options of [{expectedEmail:'wrong@example.com'},{expectedOrg:'wrong'}]) {
      const wrong = new ClaudeAccount({binary:f.binary,configDir:f.secondary,...options});
      await expect(wrong.run({model:'claude-opus-5-5',input:'hello'})).rejects.toThrow('identity does not match');
      expect(wrong.workers.size).toBe(0);
    }
  } finally { keys.forEach((k,i) => {if(previous[i]===undefined) delete process.env[k]; else process.env[k]=previous[i];}); await f.close(); }
}, 10000);

test('second Claude account is opt-in with explicit labels, namespaces and native-model selection', async () => {
  const f = await fixtures();
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR=f.primary;
  try {
    expect(configuredClaudeAccount({})).toBeUndefined();
    const configured=configuredClaudeAccount({CLAUDE_ACCOUNT_CONFIG_DIR:f.secondary,CLAUDE_ACCOUNT_MODEL_PREFIX:'team',CLAUDE_ACCOUNT_LABEL:'Team',CLAUDE_ACCOUNT_MODELS:'claude-opus-5-5'})!;
    expect(configured.backend.models).toEqual({'team-claude-opus-5-5':'claude-opus-5-5'});
    expect(configured.backend.reservedPrefix).toBe('team-claude-');
    await symlink(f.primary, join(f.dir,'alias'));
    for(const configDir of [f.primary,join(f.dir,'alias')]) expect(() => createClaudeAccountBackend({configDir,prefix:'team',label:'Team'})).toThrow('must differ');
    expect(() => createClaudeAccountBackend({configDir:'relative',prefix:'team',label:'Team'})).toThrow('absolute');
    for(const prefix of ['gpt','grok','claude','gpt-team','bad/name']) expect(() => createClaudeAccountBackend({configDir:f.secondary,prefix,label:'Team'})).toThrow('namespace');
    expect(() => createClaudeAccountBackend({configDir:f.secondary,prefix:'team',label:'Team',models:['claude-unknown']})).toThrow('supported native');
  } finally { if(previous===undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR=previous; await f.close(); }
});

test('cancellation stops a pending identity check without launching inference', async () => {
  const f=await fixtures();
  await Bun.write(f.binary, `#!/usr/bin/env bun
if(process.argv.includes('status')) await Bun.sleep(30000);
else await Bun.write(${JSON.stringify(join(f.dir,'generated'))}, 'unexpected generation');
`);
  const account=new ClaudeAccount({binary:f.binary,configDir:f.secondary,expectedEmail:'work@example.com'});
  const controller=new AbortController();
  try {
    const start=Date.now();
    const pending=account.run({model:'claude-opus-5-5',input:'hello'},controller.signal);
    await Bun.sleep(40); controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow();
    expect(Date.now()-start).toBeLessThan(2000);
    expect(account.workers.size).toBe(0);
    expect(await Bun.file(join(f.dir,'generated')).exists()).toBe(false);
  }finally{await f.close();}
});

test('configured Claude rows coexist with a native Codex account using the same prefix over HTTP and WebSocket', async () => {
  const f = await fixtures();
  const script = join(f.dir,'integration.ts');
  const source=join(import.meta.dir,'../src');
  await Bun.write(script, `
import {startRouter} from ${JSON.stringify(join(source,'router/server.ts'))};
import {buildCatalog} from ${JSON.stringify(join(source,'catalog.ts'))};
const catalog=buildCatalog({models:[{slug:'gpt-fixture',visibility:'list'}]});
if(!catalog.models.some(r=>r.slug==='team-claude-opus-5-5' && r.display_name==='Opus 5.5 (Team)')) throw new Error('catalog missing second Claude');
await Bun.write(${JSON.stringify(join(f.dir,'auth.json'))},JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture',account_id:'fixture'}}));
await Bun.write(${JSON.stringify(join(f.dir,'catalog.json'))},JSON.stringify(catalog));
await Bun.write(${JSON.stringify(join(f.dir,'key'))},Buffer.alloc(32,1));
let upstreamCalls=0;
const server=startRouter({port:0,authFile:${JSON.stringify(join(f.dir,'auth.json'))},catalog:${JSON.stringify(join(f.dir,'catalog.json'))},summaryKeyFile:${JSON.stringify(join(f.dir,'key'))},secondaryAccount:{home:${JSON.stringify(join(f.dir,'no-native-account'))},prefix:'team',binary:'unused'},upstreamFetch:async()=>{upstreamCalls++;throw new Error('unexpected upstream');}});
const headers={authorization:'Bearer fixture','content-type':'application/json'};
try {
 const body={model:'team-claude-opus-5-5',input:'hello'};
 const response=await fetch(new URL('v1/responses',server.url),{method:'POST',headers,body:JSON.stringify(body)});
 const data=await response.json();
 if(response.status!==200 || !JSON.stringify(data).includes('work|claude-opus-5-5')) throw new Error('HTTP routing failed');
 const ws=new WebSocket(String(server.url).replace('http:','ws:')+'v1/responses',{headers});
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('WS timeout')),5000);
  ws.onopen=()=>ws.send(JSON.stringify({type:'response.create',...body}));
  ws.onmessage=e=>{const event=JSON.parse(String(e.data));if(event.type==='response.failed'){clearTimeout(timer);reject(new Error('WS refusal'));}if(event.type==='response.completed'){clearTimeout(timer);if(!JSON.stringify(event).includes('work|claude-opus-5-5'))reject(new Error('WS account mismatch'));else resolve();}};
 });ws.close();
 const unknown=await fetch(new URL('v1/responses',server.url),{method:'POST',headers,body:JSON.stringify({...body,model:'team-claude-unknown'})});
 if(unknown.status===200 || upstreamCalls)throw new Error('unknown Claude fell through to native account');
 const usage=await Bun.file(${JSON.stringify(join(f.dir,'claude-team-usage.json'))}).json();
 if(usage.five_hour.used_percent!==40)throw new Error('wrong persisted quota');
 console.log('ACCOUNT_ROUTING_OK');
}finally{server.stop(true);}
`);
  try {
    const child=Bun.spawn([process.execPath,script], {env:{...process.env,CLAUDE_ACCOUNT_CONFIG_DIR:f.secondary,CLAUDE_ACCOUNT_BIN:f.binary,CLAUDE_ACCOUNT_MODEL_PREFIX:'team',CLAUDE_ACCOUNT_LABEL:'Team',CLAUDE_ACCOUNT_EXPECTED_EMAIL:'work@example.com',CLAUDE_ACCOUNT_EXPECTED_ORG:'work'},stdout:'pipe',stderr:'pipe'});
    const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if (exit !== 0) throw new Error(`Integration fixture failed: ${err}`);
    expect(err).not.toContain('Error:'); expect(exit).toBe(0); expect(out).toContain('ACCOUNT_ROUTING_OK');
  } finally {await f.close();}
}, 10000);
