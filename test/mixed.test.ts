import {test,expect} from 'bun:test';
import { items, firstText, unwrap } from './support';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import { NativeAuth } from '../src/router/auth';
import { adaptRequest } from '../src/backends/contract';
import { upstreamHeaders } from '../src/router/upstream';
import { normalizeAgentPayloads, CompactionBridge } from '../src/router/bridge';
import { HistoryCache, HistoryMiss } from '../src/router/history';
import { sseEvents, decodeBody } from '../src/protocol/stream';
import { startRouter } from '../src/router/server';
import { localResponse } from '../src/router/local';
import { SummaryCodec, compactRequest } from '../src/router/capsule';
import { claudeUsageSnapshot } from '../src/backends/claude-limits';
import { claudeBackend } from '../src/backends/claude';
test('Claude task payload reaches GPT as text while native ciphertext and other items stay intact',()=>{
 const plaintext={type:'encrypted_content',encrypted_content:'Reply exactly CEDAR.'};
 const encrypted={type:'encrypted_content',encrypted_content:'gAAAA-native-ciphertext'};
 const other={type:'compaction',encrypted_content:'opaque'};
 const agent={type:'agent_message',author:'/root',recipient:'/root/probe',content:[{type:'input_text',text:'Payload:'},plaintext,encrypted]};
 const body={input:[agent,other]};
 const normalized=normalizeAgentPayloads(body);
 expect(items(normalized)[0]!.content).toEqual([{type:'input_text',text:'Payload:'},{type:'input_text',text:'Reply exactly CEDAR.'},encrypted]);
 expect(items(normalized)[0]!.author).toBe('/root');expect(items(normalized)[1]!).toBe(other);
 expect(agent.content[1]).toBe(plaintext);
 expect(normalizeAgentPayloads(normalized)).toBe(normalized);
});
test('native auth rejects strangers, wrong accounts and browser origins; follows refresh',async()=>{
 const dir=await mkdtemp(tmpdir()+'/mixed-auth-'); const file=dir+'/auth.json';
 const write=async(token:string)=>Bun.write(file,JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:token,account_id:'own-account'}}));
 await write('first-token');const auth=new NativeAuth(file);
 const headers=(token:string)=>new Headers({authorization:`Bearer ${token}`,'chatgpt-account-id':'own-account'});
 expect(await auth.accepts(headers('first-token'))).toBe(true);
 expect(await auth.accepts(headers('stranger'))).toBe(false);
 const wrong=headers('first-token');wrong.set('chatgpt-account-id','different');expect(await auth.accepts(wrong)).toBe(false);
 const browser=headers('first-token');browser.set('origin','https://example.org');expect(await auth.accepts(browser)).toBe(false);
 await write('refreshed-token');expect(await auth.accepts(headers('refreshed-token'))).toBe(true);expect(await auth.accepts(headers('first-token'))).toBe(true);
 await rm(dir,{recursive:true});
});
test('Claude pins aliases, preserves client tools, excludes hosted tools and service tier',()=>{
 const request=adaptRequest({model:'opus',tools:[{type:'web_search'},{type:'namespace',name:'functions',tools:[]}],service_tier:'priority',instructions:'Keep me'},claudeBackend);
 expect(request.model).toBe('claude-opus-5-5');expect(request.tools).toHaveLength(1);expect(request.service_tier).toBeUndefined();expect(request.instructions).toContain('Keep me');expect(request.instructions).toContain('unavailable');
 expect(()=>adaptRequest({model:'claude-unknown'},claudeBackend)).toThrow();
});
test('headers preserve native OpenAI auth while removing websocket transport metadata',()=>{
 const headers=upstreamHeaders(new Headers({authorization:'Bearer test-only','chatgpt-account-id':'test-only',host:'localhost',connection:'upgrade',upgrade:'websocket','sec-websocket-key':'test-only'}));
 expect(headers.get('authorization')).toBe('Bearer test-only');expect(headers.get('chatgpt-account-id')).toBe('test-only');expect(headers.get('host')).toBeNull();expect(headers.get('sec-websocket-key')).toBeNull();
});
test('history replays across models, never forwards previous_response_id and fails closed on a miss',()=>{
 const cache=new HistoryCache();cache.remember({model:'claude-opus-5-5',input:[{role:'user',content:'first'}]},{id:'resp_test',output:[{type:'message',role:'assistant',content:'second'}]});
 const body=cache.expand({model:'gpt-test',previous_response_id:'resp_test',input:[{role:'user',content:'third'}]});expect(body.input).toHaveLength(3);expect(body.previous_response_id).toBeUndefined();
 cache.remember({model:'gpt-test',input:[{role:'user',content:'a'}]},{id:'resp_gpt',output:[{type:'function_call',call_id:'c1',name:'exec_command',arguments:'{}'}]});
 const gpt=cache.expand({model:'gpt-test',previous_response_id:'resp_gpt',input:[{type:'function_call_output',call_id:'c1',output:'ok'}]});expect(gpt.input).toHaveLength(3);expect(gpt.previous_response_id).toBeUndefined();
 expect(()=>cache.expand({model:'claude-opus-5-5',previous_response_id:'missing',input:[]})).toThrow('expired');
 expect(()=>cache.expand({model:'gpt-test',previous_response_id:'missing',input:[]})).toThrow(HistoryMiss);
});
test('SSE handles split frames, multiline data, CRLF and final frame',async()=>{
 const encoder=new TextEncoder();const values=['data: {"type":','"one"}\r\n\r\ndata: {"type":"two"}\n\n','data: [DONE]\n\n'];
 const response=new Response(new ReadableStream({start(c){for(const v of values)c.enqueue(encoder.encode(v));c.close();}}));const events:any[]=[];
 await sseEvents(response,event=>events.push(event));expect(events.map(e=>e.type)).toEqual(['one','two']);
});
test('native zstd body decompresses without forwarding compression headers to JSON',async()=>{
 const body=await decodeBody(new Request('http://127.0.0.1/v1/responses',{method:'POST',headers:{'content-encoding':'zstd'},body:new Uint8Array(Bun.zstdCompressSync(JSON.stringify({model:'test'})))}));expect(body.model).toBe('test');
});
test('installed router denies unauthenticated routes and exposes no credentials in health',async()=>{
 const dir=await mkdtemp(tmpdir()+'/mixed-server-');await Bun.write(dir+'/auth.json','{}');await Bun.write(dir+'/catalog.json','{}');
 const server=startRouter({port:0,authFile:dir+'/auth.json',catalog:dir+'/catalog.json'});
 try {expect((await fetch(server.url+'v1/responses',{method:'POST',body:'{}'})).status).toBe(401);expect(await (await fetch(server.url+'health')).json()).toEqual({status:'ok',mode:'mixed',version:1});}
 finally{server.stop(true);await rm(dir,{recursive:true});}
});

test('Claude WebSocket warmup produces no generation or usage',async()=>{
 const response=await localResponse({model:'claude-opus-5-5',input:[],generate:false});expect(response.output).toEqual([]);expect(response.usage?.total_tokens).toBe(0);
});

test('portable compaction summary is authenticated and readable by either model',async()=>{
 const codec=new SummaryCodec(Buffer.alloc(32,7));const capsule=codec.seal('Remember CEDAR');
 expect(capsule).not.toContain('CEDAR');expect(codec.open(capsule)).toBe('Remember CEDAR');
 expect(()=>new SummaryCodec(Buffer.alloc(32,9)).open(capsule)).toThrow();
 for(const model of ['gpt-test','claude-opus-5-5']){
  const request=await unwrap(codec,{model,previous_response_id:'old',input:[{type:'compaction',encrypted_content:capsule}]});
  expect(request.previous_response_id).toBeUndefined();expect(firstText(items(request)[0])).toContain('Remember CEDAR');
 }
 await expect(unwrap(codec,{model:'claude-opus-5-5',input:[{type:'compaction',encrypted_content:'foreign-openai-opaque'}]})).rejects.toThrow('OpenAI-encrypted');
 const gpt=await unwrap(codec,{model:'gpt-test',input:[{type:'compaction',encrypted_content:'foreign-openai-opaque'}]});expect(items(gpt)[0]!.encrypted_content).toBe('foreign-openai-opaque');
});
test('OpenAI compaction is bridged once by GPT into a cached sealed summary for Claude',async()=>{
 const dir=await mkdtemp(tmpdir()+'/mixed-bridge-');const codec=new SummaryCodec(Buffer.alloc(32,7));let calls=0;
 const frame=(event:any)=>'data: '+JSON.stringify(event)+String.fromCharCode(10,10);
 const bridge=new CompactionBridge(codec,dir,async body=>{calls++;expect(items(body)[0]!.encrypted_content).toBe('gAAAA-test');expect(body.store).toBe(false);expect(body.tools).toEqual([]);
  return new Response(frame({type:'response.output_text.delta',delta:'Remember '})+frame({type:'response.output_text.delta',delta:'CEDAR'})+frame({type:'response.completed',response:{}}));});
 const request=await unwrap(codec,{model:'claude-opus-5-5',previous_response_id:'old',input:[{type:'compaction',encrypted_content:'gAAAA-test'}]},encrypted=>bridge.summary(encrypted));
 expect(firstText(items(request)[0])).toContain('Remember CEDAR');expect(request.previous_response_id).toBeUndefined();
 const files=[...new Bun.Glob('*.cap').scanSync(dir)];expect(files).toHaveLength(1);expect(await Bun.file(dir+'/'+files[0]).text()).not.toContain('CEDAR');
 const cached=new CompactionBridge(codec,dir,async()=>{throw new Error('should read cache');});expect(await cached.summary('gAAAA-test')).toBe('Remember CEDAR');expect(calls).toBe(1);
 const failing=new CompactionBridge(codec,dir,async()=>new Response('{}',{status:400}));await expect(failing.summary('gAAAA-other')).rejects.toThrow('could not be bridged');
 await rm(dir,{recursive:true});
});
test('compaction request retains history but removes the trigger and tools',()=>{
 const compact=compactRequest({model:'claude-opus-5-5',previous_response_id:'old',input:[{role:'user',content:'Remember CEDAR'},{type:'compaction_trigger'}],tools:[{type:'function',name:'exec_command'}]});
 expect(compact.tools).toEqual([]);expect(compact.input).toHaveLength(2);expect(firstText(items(compact)[1])).toContain('continuation summary');expect(compact.previous_response_id).toBeUndefined();
});
test('Claude plan usage snapshot keeps percent used and reset times for both windows',()=>{
 const snap=claudeUsageSnapshot({status:'allowed',overageStatus:'rejected',unifiedWindows:{five_hour:{utilization:0.58,resetsAt:1790833800},seven_day:{utilization:0.1,resetsAt:1790960400}}},1790830000000);
 expect(snap).toEqual({updated_at:1790830000,status:'allowed',five_hour:{used_percent:58,window_minutes:300,resets_at:1790833800},seven_day:{used_percent:10,window_minutes:10080,resets_at:1790960400},overage_status:'rejected'});
 expect(claudeUsageSnapshot({}).five_hour).toBeNull();
});


test('native tools preserve authenticated raw requests and upstream responses',async()=>{
 const dir=await mkdtemp(tmpdir()+'/mixed-tools-');
 await Bun.write(dir+'/auth.json',JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture',account_id:'fixture-account'}}));
 await Bun.write(dir+'/catalog.json','{}');const calls:any[]=[];
 const server=startRouter({port:0,authFile:dir+'/auth.json',catalog:dir+'/catalog.json',upstreamFetch:(async(url:any,init:any)=>{
  const request=new Request(url,init);calls.push({url:String(url),body:await request.text(),headers:request.headers});
  return new Response('fixture-result',{status:201,headers:{'content-type':'application/json','x-fixture':'preserved'}});
 }) as typeof fetch});
 try {
  for(const path of ['alpha/search','images/generations','images/edits']){
   const body=path==='images/edits'?'--boundary\r\noriginal-image-bytes\r\n--boundary--':'{"model":"gpt-image-2","prompt":"fixture"}';
   const headers={authorization:'Bearer fixture','chatgpt-account-id':'fixture-account','content-type':path==='images/edits'?'multipart/form-data; boundary=boundary':'application/json'};
   const response=await fetch(server.url+'v1/'+path,{method:'POST',headers,body});
   expect(response.status).toBe(201);expect(await response.text()).toBe('fixture-result');expect(response.headers.get('x-fixture')).toBe('preserved');
   expect(calls.at(-1).url).toBe('https://chatgpt.com/backend-api/codex/'+path);expect(calls.at(-1).body).toBe(body);
   expect(calls.at(-1).headers.get('authorization')).toBe('Bearer fixture');expect(calls.at(-1).headers.get('content-type')).toBe(headers['content-type']);
  }
  expect((await fetch(server.url+'v1/images/edits',{method:'POST',body:'unauthorized'})).status).toBe(401);
  expect((await fetch(server.url+'v1/unrelated',{method:'POST',headers:{authorization:'Bearer fixture'},body:'{}'})).status).toBe(404);
  expect(calls).toHaveLength(3);
 } finally {server.stop(true);await rm(dir,{recursive:true});}
});
