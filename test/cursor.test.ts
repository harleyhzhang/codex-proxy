import { describe, expect, test } from 'bun:test';
import { connectFrames, cursorEnvironment, cursorSelection, interpretCursorEvents, parseCursorOutput, assertCursorIdentity, verifyCursorProfile, CursorError } from '../src/backends/cursor';
import { ClaudeUsageLimitError } from '../src/backends/claude-limits';
import { BackendError, type SubscriptionBackend } from '../src/backends/contract';
import { withOpusQuotaFallback } from '../src/backends/quota-fallback';
import type { ResponsesRequest } from '../src/protocol/types';
import type { JsonRecord } from '../src/json';
const request: ResponsesRequest = {model:'kimi-k3',input:'test',tools:[{type:'namespace',name:'functions',tools:[{type:'function',name:'read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}]},{type:'custom',name:'apply_patch'}]};
const output=(value:unknown)=>parseCursorOutput(JSON.stringify(value),request);
test('Cursor preserves namespaced function objects and exact custom raw input',()=>{
 const result=output({text:'',tool_calls:[{name:'functions.read',arguments:{path:'hello'}},{name:'apply_patch',arguments:'*** Begin Patch\n*** End Patch'}]});
 expect(result.toolCalls.map(c=>[c.name,c.arguments])).toEqual([['functions.read','{"path":"hello"}'],['apply_patch','*** Begin Patch\n*** End Patch']]);
});
for(const invalid of [
 {text:'',tool_calls:[{name:'shell',arguments:{}}]},
 {text:'',tool_calls:[{name:'functions.read',arguments:{path:1}}]},
 {text:'',tool_calls:[{name:'functions.read',arguments:{}}]},
 {text:'',tool_calls:[{name:'functions.read',arguments:{path:'a',extra:true}}]},
 {text:'',tool_calls:[{name:'apply_patch',arguments:{patch:'x'}}]},
 {text:'',tool_calls:[],extra:true},
])test('Cursor refuses malformed or unavailable action '+JSON.stringify(invalid),()=>{expect(()=>output(invalid)).toThrow(CursorError)});
test('Cursor does not classify assistant quota text as a failure',()=>expect(output({text:'quota 429 expired',tool_calls:[]}).text).toBe('quota 429 expired'));
test('Cursor model parameters are family specific and unsupported effort is refused',()=>{
 expect(cursorSelection('kimi-k3','max').params).toEqual([{id:'reasoning',value:'max'}]);
 expect(cursorSelection('grok-4.7','xhigh',true).params).toContainEqual({id:'fast',value:'true'});
 expect(cursorSelection('grok-4.7','xhigh').params).toContainEqual({id:'reasoning_effort',value:'xhigh'});
 expect(cursorSelection('gpt-5.6-sol','none').params).toContainEqual({id:'reasoning',value:'none'});
 expect(()=>cursorSelection('kimi-k3','medium')).toThrow();expect(()=>cursorSelection('auto','high')).toThrow();
});
test('Cursor scrubs host credential and endpoint overrides',()=>{
 const prior=process.env.CURSOR_API_ENDPOINT;process.env.CURSOR_API_ENDPOINT='https://invalid';
 try{const env=cursorEnvironment('fixture-key');expect(env.CURSOR_API_ENDPOINT).toBeUndefined();expect(env.CURSOR_API_KEY).toBe('fixture-key');expect(env.OPENAI_API_KEY).toBeUndefined();}finally{if(prior===undefined)delete process.env.CURSOR_API_ENDPOINT;else process.env.CURSOR_API_ENDPOINT=prior}
});
test('Cursor verifies both email and stable user id before inference',()=>{
 const pins={expectedEmail:'work@example.com',expectedUserId:'1'};
 expect(()=>assertCursorIdentity({user:{userEmail:'work@example.com',userId:'1'}},pins)).not.toThrow();
 expect(()=>assertCursorIdentity({user:{userEmail:'work@example.com',userId:'2'}},pins)).toThrow();
 expect(()=>assertCursorIdentity({user:{userEmail:'personal@example.com',userId:'1'}},pins)).toThrow();
});
const selection=cursorSelection('kimi-k3','low');
const events:JsonRecord[]=[{result:{status:'RUN_LIFECYCLE_STATUS_FINISHED',runId:'r',result:{status:'RUN_LIFECYCLE_STATUS_FINISHED',result:'{"text":"ok","tool_calls":[]}',model:selection}}},{done:{runId:'r'}}];
test('Cursor requires matching terminal success, done and exact model',()=>{
 expect(interpretCursorEvents(events,request,selection).text).toBe('ok');
 expect(()=>interpretCursorEvents(events.slice(0,1),request,selection)).toThrow();
 expect(()=>interpretCursorEvents(events,request,cursorSelection('kimi-k3','high'))).toThrow();
 expect(()=>interpretCursorEvents([...events,events[0]!],request,selection)).toThrow();
});
for(const event of [{sdkMessage:{type:'tool_call',message:{}}},{sdkMessage:{type:'task',message:{}}},{step:{type:'summaryMessage',step:{}}}])test('Cursor rejects native execution and native compaction',()=>expect(()=>interpretCursorEvents([event,...events],request,selection)).toThrow());
function frame(value:unknown,flag=0){const data=Buffer.from(JSON.stringify(value));const h=Buffer.alloc(5);h[0]=flag;h.writeUInt32BE(data.length,1);return Buffer.concat([h,data]);}
const stream=(chunks:Uint8Array[])=>new ReadableStream<Uint8Array>({start(c){chunks.forEach(x=>c.enqueue(x));c.close()}});
test('Connect decoder handles split headers, multiple records and end frames',async()=>{
 const data=Buffer.concat([frame({}),frame({done:{runId:'r'}}),frame({},2)]);const chunks=[data.subarray(0,2),data.subarray(2,7),data.subarray(7)];const values=[];for await(const v of connectFrames(stream(chunks)))values.push(v);expect(values).toEqual([{}, {done:{runId:'r'}}]);
});
test('Connect refuses truncation and terminal transport errors',async()=>{
 const collect=async(bytes:Uint8Array)=>{for await(const _ of connectFrames(stream([bytes]))){} };
 await expect(collect(frame({done:{}}).subarray(0,6))).rejects.toThrow();await expect(collect(frame({error:{code:'unavailable'}},2))).rejects.toThrow();
});
const result={text:'ok',toolCalls:[],usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
function backend(run:SubscriptionBackend['run'],gate?:()=>void):SubscriptionBackend {return {name:'Claude (Work)',models:{'work-claude-opus-5-5':'claude-opus-5-5','work-claude-fable-5-1':'claude-fable-5-1'},reservedPrefix:'work-claude-',catalog:[],run,assertAvailable:gate};}
describe('secondary Opus quota-only fallback',()=>{
 test('quota gate permits fallback and preserves full request/history/effort',async()=>{
  let seen:ResponsesRequest|undefined;
  const primary=backend(async()=>{throw new ClaudeUsageLimitError()},()=>{throw new ClaudeUsageLimitError()});
  const wrapped=withOpusQuotaFallback(primary,backend(async(req)=>{seen=req;return result}));
  const req:ResponsesRequest={...request,model:'claude-opus-5-5',reasoning:{effort:'high'},input:[{role:'user',content:'history'},{type:'function_call_output',call_id:'x',output:'old result'}]};
  expect(()=>wrapped.assertAvailable?.(req.model)).not.toThrow();expect((await wrapped.run(req)).text).toContain('using Cursor Opus 5.5');expect(seen).toBe(req);
 });
 test('allowed direct Opus never invokes Cursor',async()=>{let count=0;const wrapped=withOpusQuotaFallback(backend(async()=>result),backend(async()=>{count++;return result}));expect(await wrapped.run({...request,model:'claude-opus-5-5'})).toBe(result);expect(count).toBe(0)});
 for(const error of [new BackendError('quota 429'),new BackendError('auth failed'),new Error('network'),new BackendError('invalid output',{retryable:true}),new DOMException('cancelled','AbortError')])test('never falls back for '+error.message,async()=>{let count=0;const wrapped=withOpusQuotaFallback(backend(async()=>{throw error}),backend(async()=>{count++;return result}));await expect(wrapped.run({...request,model:'claude-opus-5-5'})).rejects.toThrow();expect(count).toBe(0)});
 test('Fable quota does not use Cursor Opus',async()=>{let count=0;const wrapped=withOpusQuotaFallback(backend(async()=>{throw new ClaudeUsageLimitError()}),backend(async()=>{count++;return result}));await expect(wrapped.run({...request,model:'claude-fable-5-1'})).rejects.toThrow();expect(count).toBe(0);expect(()=>wrapped.assertAvailable?.('claude-fable-5-1')).not.toThrow()});
 test('abort prevents all generation',async()=>{let count=0;const wrapped=withOpusQuotaFallback(backend(async()=>{count++;return result}),backend(async()=>result));await expect(wrapped.run({...request,model:'claude-opus-5-5'},AbortSignal.abort())).rejects.toThrow();expect(count).toBe(0)});
 test('fallback refusal surfaces without another supplier',async()=>{const refusal=new BackendError('Cursor exhausted');const wrapped=withOpusQuotaFallback(backend(async()=>{throw new ClaudeUsageLimitError()}),backend(async()=>{throw refusal}));await expect(wrapped.run({...request,model:'claude-opus-5-5'})).rejects.toBe(refusal)});
});

test('Cursor shares concurrent account discovery and invalidates it for changed credentials or pins',async()=>{
 const pins={expectedEmail:'cache-work@example.com',expectedUserId:'11',binaryHash:'cache-fixture'};let lookups=0;
 const rpc=async(_service:string,method:string)=>{lookups++;await new Promise(r=>setTimeout(r,10));return Response.json(method==='Me'?{user:{userEmail:pins.expectedEmail,userId:'11'}}:{items:[]})};
 await Promise.all(Array.from({length:8},()=>verifyCursorProfile(pins,'cache-key-one',rpc)));expect(lookups).toBe(2);
 await verifyCursorProfile(pins,'cache-key-one',rpc);expect(lookups).toBe(2);
 await verifyCursorProfile(pins,'cache-key-two',rpc);expect(lookups).toBe(4);
 await expect(verifyCursorProfile({...pins,expectedEmail:'different@example.com'},'cache-key-one',rpc)).rejects.toThrow();expect(lookups).toBe(5);
});
test('Cursor never caches failed identity checks',async()=>{
 const pins={expectedEmail:'fail-cache@example.com',expectedUserId:'12',binaryHash:'failure-fixture'};let count=0;
 const rpc=async()=>{count++;return Response.json({user:{userEmail:'other@example.com',userId:'12'}})};
 for(let i=0;i<2;i++)await expect(verifyCursorProfile(pins,'bad-key',rpc)).rejects.toThrow();expect(count).toBe(2);
});
