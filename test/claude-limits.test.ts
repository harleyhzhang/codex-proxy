import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ClaudeUsageLimits, ClaudeUsageLimitError, claudeUsageSnapshot, claudeLimits } from '../src/backends/claude-limits';
import { startRouter } from '../src/router/server';
import { runClaude } from '../src/backends/claude';

const now = Date.now();
const reset = Math.floor(now / 1000) + 3600;
const rejected = (windows: any) => ({status:'rejected',overageStatus:'rejected',unifiedWindows:windows});
const exhausted = {utilization:1,resetsAt:reset};

test('shared session gate blocks both Claude models, expires exactly at reset and ignores disabled credits alone', () => {
  const limits = new ClaudeUsageLimits();
  limits.update(rejected({five_hour:exhausted}));
  for (const model of ['claude-opus-5-5','claude-fable-5-1']) {
    const error = limits.blocked(model, now);
    expect(error).toBeInstanceOf(ClaudeUsageLimitError);
    expect(error!.message).toContain('Claude session limit reached. Resets');
    expect(error!.message).toContain('Switch to GPT or wait until reset.');
    expect(limits.blocked(model,reset*1000)).toBeUndefined();
  }
  limits.update({...rejected({five_hour:{...exhausted,utilization:0.5}}),status:'allowed'});
  expect(limits.blocked('claude-opus-5-5',now)).toBeUndefined();
  limits.update({...rejected({five_hour:exhausted}),overageStatus:'allowed'});
  expect(limits.blocked('claude-opus-5-5',now)).toBeUndefined();
});

test('model-specific weekly limits do not block other families; multiple exhausted windows wait for the latest reset', () => {
  const limits = new ClaudeUsageLimits();
  const info = rejected({seven_day_fable:exhausted});
  const snapshot = claudeUsageSnapshot(info);
  expect(snapshot.model_windows?.seven_day_fable.used_percent).toBe(100);
  limits.restore(snapshot);
  expect(limits.blocked('claude-fable-5-1',now)!.message).toContain('Claude fable weekly limit reached.');
  expect(limits.blocked('claude-opus-5-5',now)).toBeUndefined();
  limits.update(rejected({five_hour:exhausted,seven_day:{...exhausted,resetsAt:reset+3600}}));
  expect(limits.blocked('claude-opus-5-5',now)!.resetsAt).toBe(reset+3600);
  limits.update(rejected({five_hour:{utilization:1}}));
  expect(limits.blocked('claude-opus-5-5',now)).toBeUndefined();
});

test('real worker recognizes CLI rate_limit before structured output and does not replay a limited continuation', async () => {
  const dir = await mkdtemp(tmpdir()+'/claude-limit-worker-');
  const binary = dir+'/mock-cli';
  const oldBinary = process.env.CLAUDE_BIN;
  claudeLimits.restore(claudeUsageSnapshot({}));
  // A real subprocess exercises stdout parsing and continuation fallback, without model usage.
  await Bun.write(binary,`#!/bin/sh\nprintf started >> '${dir}/starts'\nread initial\nprintf '%s\\n' '${JSON.stringify({type:'result',is_error:false,structured_output:{text:'',tool_calls:[{name:'step',arguments:'{}'}]}})}'\nread ignored\nprintf '%s\\n' '${JSON.stringify({type:'rate_limit_event',rate_limit_info:rejected({five_hour:exhausted})})}' '${JSON.stringify({type:'assistant',error:'rate_limit'})}'\n`);
  const { chmod } = await import('node:fs/promises');
  await chmod(binary,0o700);
  process.env.CLAUDE_BIN=binary;
  try {
    const tools=[{type:'function',name:'step',parameters:{type:'object',properties:{}}}];
    const first=await runClaude({model:'claude-opus-5-5',input:'Test',tools});
    await expect(runClaude({model:'claude-opus-5-5',input:[{type:'function_call_output',call_id:first.toolCalls[0]!.callId,output:'OK'}],tools})).rejects.toThrow(ClaudeUsageLimitError);
    expect(await Bun.file(dir+'/starts').text()).toBe('started');
  } finally {
    if(oldBinary===undefined)delete process.env.CLAUDE_BIN;else process.env.CLAUDE_BIN=oldBinary;
    claudeLimits.restore(claudeUsageSnapshot({}));
    await rm(dir,{recursive:true});
  }
});

test('installed transport shape returns useful HTTP and WebSocket errors from persisted quota with warmups unaffected', async () => {
  const dir=await mkdtemp(tmpdir()+'/claude-limit-server-');
  await Bun.write(dir+'/auth.json',JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'test-token',account_id:'test-account'}}));
  await Bun.write(dir+'/catalog.json','{}');
  await Bun.write(dir+'/summary.key',Buffer.alloc(32,7));
  await Bun.write(dir+'/claude-usage.json',JSON.stringify(claudeUsageSnapshot(rejected({five_hour:exhausted}))));
  const server=startRouter({port:0,authFile:dir+'/auth.json',catalog:dir+'/catalog.json',summaryKeyFile:dir+'/summary.key'});
  const headers={authorization:'Bearer test-token','chatgpt-account-id':'test-account','content-type':'application/json'};
  const body={model:'claude-opus-5-5',input:[]};
  try {
    for(const model of ['claude-opus-5-5','claude-fable-5-1']) {
      const response=await fetch(server.url+'v1/responses',{method:'POST',headers,body:JSON.stringify({...body,model})});
      expect(response.status).toBe(400);
      const error=(await response.json() as any).error;
      expect(error.code).toBe('claude_usage_limit_reached');
      expect(error.message).toContain('Claude session limit reached. Resets');
    }
    const warm=await fetch(server.url+'v1/responses',{method:'POST',headers,body:JSON.stringify({...body,generate:false})});
    expect(warm.status).toBe(200);
    const streamed=await fetch(server.url+'v1/responses',{method:'POST',headers,body:JSON.stringify({...body,stream:true})});
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toBe('text/event-stream');
    const failure=await streamed.text();expect(failure).toContain('response.failed');expect(failure).toContain('invalid_prompt');
    const Socket=WebSocket as unknown as {new(url:string,options:{headers:Record<string,string>}):WebSocket};
    const ws=new Socket(server.url.toString().replace('http:','ws:')+'v1/responses',{headers});
    try {
      const event=await new Promise<any>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('WebSocket quota check timed out')),3000);
        ws.onopen=()=>ws.send(JSON.stringify({type:'response.create',...body}));
        ws.onmessage=e=>{clearTimeout(timer);resolve(JSON.parse(String(e.data)));};
        ws.onerror=()=>{clearTimeout(timer);reject(new Error('WebSocket failed'));};
      });
      expect(event.type).toBe('response.failed');
      expect(event.response.error.code).toBe('invalid_prompt');
      expect(event.response.error.message).toContain('Switch to GPT');
    } finally {ws.close();}
  } finally {server.stop(true);claudeLimits.restore(claudeUsageSnapshot({}));await rm(dir,{recursive:true});}
});
