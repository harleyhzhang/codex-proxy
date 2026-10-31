import { describe, expect, test } from 'bun:test';
import { cursorFailure, cursorSelection, finishedRun, assertCursorIdentity, verifyCursorProfile, sanitizeCursorInput, CursorError } from '../src/backends/cursor';
import { ProxyTransportError } from '../src/transport';

test('Cursor sanitizer drops encrypted reasoning and compaction items, keeps inline images and replaces other media instead of refusing the turn',()=>{
 type R=Record<string,unknown>;
 const history=[
  {type:'message',role:'user',content:[{type:'input_text',text:'look at this'},{type:'input_image',image_url:'data:image/png;base64,AAAA'},{type:'input_image',image_url:'https://example.com/remote.png'}]},
  {type:'reasoning',id:'rs_1',encrypted_content:'gAAAAopaque',summary:[]},
  {type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]},
  {type:'compaction',encrypted_content:'gAAAAsummary'},
  {type:'function_call_output',call_id:'c1',output:[{type:'input_file',file_id:'f_1'},{type:'input_text',text:'done'}]},
  {type:'message',role:'user',content:'plain string survives'},
 ];
 const result=sanitizeCursorInput(history);
 expect(result.dropped).toBe(2);
 expect(result.replaced).toBe(2);
 const items=result.input as R[];
 expect(items.map(i=>i.type)).toEqual(['message','message','function_call_output','message']);
 expect((items[0]!.content as R[])[1]).toEqual({type:'input_image',image_url:'data:image/png;base64,AAAA'});
 expect((items[0]!.content as R[])[2]).toEqual({type:'input_text',text:'[attachment omitted: Cursor accepts text and inline images only]'});
 expect((items[2]!.output as R[])[1]).toEqual({type:'input_text',text:'done'});
 expect(JSON.stringify(result.input)).not.toContain('gAAAA');
 expect(history[1]!.encrypted_content).toBe('gAAAAopaque');
 expect(sanitizeCursorInput('just text')).toEqual({input:'just text',dropped:0,replaced:0});
});
import { ClaudeUsageLimitError } from '../src/backends/claude-limits';
import { BackendError, type SubscriptionBackend } from '../src/backends/contract';
import { withOpusQuotaFallback } from '../src/backends/quota-fallback';
import type { ResponsesRequest } from '../src/protocol/types';
import { preparePrompt } from '../src/protocol/prompt';
import type { JsonRecord } from '../src/json';
const request: ResponsesRequest = {model:'kimi-k3',input:'test',tools:[{type:'namespace',name:'functions',tools:[{type:'function',name:'read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}]},{type:'custom',name:'apply_patch'}]};
test('Cursor preserves MCP/typed/legacy computer images for actual attachment and keeps ordinary tool metadata as text',()=>{
 const inline='data:image/png;base64,AAAA';
 const history=[
  {type:'function_call_output',call_id:'metadata',output:{image_url:'https://example.invalid/metadata.png',file_id:'database-row',audio_url:'metadata',file_data:'metadata',value:7}},
  {type:'message',role:'user',content:[{type:'image',mimeType:'image/png',data:'AAAA'}]},
  {type:'computer_call_output',call_id:'typed',output:{type:'computer_screenshot',image_url:inline}},
  {type:'computer_call_output',call_id:'legacy',output:{image_url:inline}},
  {type:'function_call_output',call_id:'unsupported',output:[{type:'input_file',file_id:'attachment'},{type:'input_audio',audio_url:'data:audio/wav;base64,AAAA'},{type:'input_image',image_url:'https://example.invalid/attachment.png'}]},
 ];
 const result=sanitizeCursorInput(history);
 expect(result.dropped).toBe(0);expect(result.replaced).toBe(3);
 const items=result.input as typeof history;
 expect(items.slice(0,4)).toEqual(history.slice(0,4));
 const prepared=preparePrompt({model:'grok-4.7',input:items,tools:[]});
 expect(prepared.images).toHaveLength(3);
 expect(prepared.images.map(image=>image.source)).toEqual(Array.from({length:3},()=>({type:'base64',media_type:'image/png',data:'AAAA'})));
 expect(prepared.prompt).toContain('https://example.invalid/metadata.png');expect(prepared.prompt).toContain('database-row');expect(prepared.prompt).toContain('"file_data":"metadata"');
 expect(prepared.prompt).not.toContain('data:image/png;base64,AAAA');
 expect(history[0]?.output).toEqual({image_url:'https://example.invalid/metadata.png',file_id:'database-row',audio_url:'metadata',file_data:'metadata',value:7});
});
test('Cursor applies the legacy image exception only to computer outputs, including remote/file-backed placeholders',()=>{
 const metadata={image_url:'data:image/png;base64,AAAA',file_id:'ordinary-record'};
 const input=[{type:'function_call_output',call_id:'normal',output:metadata},{type:'computer_call_output',call_id:'remote',output:{image_url:'https://example.invalid/remote.png'}},{type:'computer_call_output',call_id:'file',output:{type:'computer_screenshot',file_id:'unsupported-file'}}];
 const sanitized=sanitizeCursorInput(input);
 expect(sanitized.replaced).toBe(2);expect((sanitized.input as typeof input)[0]?.output).toEqual(metadata);
 const prepared=preparePrompt({model:'grok-4.7',input:sanitized.input as never,tools:[]});
 expect(prepared.images).toHaveLength(0);expect(prepared.prompt).toContain('ordinary-record');
});
test('Cursor model parameters are family specific and unsupported effort is refused',()=>{
 expect(cursorSelection('muse-wonder-1.0','max',true)).toEqual({id:'muse-wonder-1.0',params:[{id:'reasoning_effort',value:'max'},{id:'context',value:'300k'}]});
 expect(cursorSelection('kimi-k3','max').params).toEqual([{id:'reasoning',value:'max'}]);
 expect(cursorSelection('grok-4.7','xhigh',true).params).toContainEqual({id:'fast',value:'true'});
 expect(cursorSelection('grok-4.7','xhigh').params).toContainEqual({id:'reasoning_effort',value:'xhigh'});
 expect(()=>cursorSelection('gpt-5.6-sol','none')).toThrow();
 expect(()=>cursorSelection('kimi-k3','medium')).toThrow();expect(()=>cursorSelection('auto','high')).toThrow();
});
test('Cursor verifies both email and stable user id before inference',()=>{
 const pins={expectedEmail:'work@example.com',expectedUserId:'1'};
 expect(()=>assertCursorIdentity({userEmail:'work@example.com',userId:'1'},pins)).not.toThrow();
 expect(()=>assertCursorIdentity({userEmail:'work@example.com',userId:'2'},pins)).toThrow();
 expect(()=>assertCursorIdentity({userEmail:'personal@example.com',userId:'1'},pins)).toThrow();
});
const selection=cursorSelection('kimi-k3','low');
test('Cursor requires a finished run with the exact model and parameters',()=>{
 const finished={status:'finished',result:'ok',model:selection};
 expect(finishedRun(finished,selection).result).toBe('ok');
 expect(()=>finishedRun({...finished,model:cursorSelection('kimi-k3','high')},selection)).toThrow('different model');
 expect(()=>finishedRun({...finished,model:undefined},selection)).toThrow('different model');
 expect(()=>finishedRun(undefined,selection)).toThrow('did not finish');
});
test('an errored run is retryable only when Cursor gives no reason or a transient one',()=>{
 const caught=(error?:JsonRecord)=>{try{finishedRun({status:'error',...(error?{error}:{})},selection);}catch(failure){return failure as CursorError;}throw new Error('expected a refusal');};
 const opaque=caught();
 expect(opaque.retryable).toBe(true); expect(opaque.message).toContain('run status error with no reason from Cursor');
 expect(caught({message:'upstream provider rate limit exceeded'}).retryable).toBe(true);
 const policy=caught({message:'model refused the request policy'});
 expect(policy.retryable).toBe(false); expect(policy.message).toContain('run status error: model refused the request policy');
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

/** The bridge-era RPC fixtures as SDK lookups: `Me` answers identity, `ListModels` the catalog. */
const lookupsFrom=(rpc:(service:string,method:string)=>Promise<Response>)=>({
 me:async()=>{const value=await (await rpc('', 'Me')).json() as JsonRecord;return value.user??value;},
 models:async()=>{const value=await (await rpc('', 'ListModels')).json() as JsonRecord;return Array.isArray(value.items)?value.items:value;},
});
test('Cursor shares concurrent account discovery and invalidates it for changed credentials or pins',async()=>{
 const pins={expectedEmail:'cache-work@example.com',expectedUserId:'11'};let lookups=0;
 const rpc=async(_service:string,method:string)=>{lookups++;await new Promise(r=>setTimeout(r,10));return Response.json(method==='Me'?{user:{userEmail:pins.expectedEmail,userId:'11'}}:{items:[]})};
 await Promise.all(Array.from({length:8},()=>verifyCursorProfile(pins,'cache-key-one',lookupsFrom(rpc))));expect(lookups).toBe(2);
 await verifyCursorProfile(pins,'cache-key-one',lookupsFrom(rpc));expect(lookups).toBe(2);
 await verifyCursorProfile(pins,'cache-key-two',lookupsFrom(rpc));expect(lookups).toBe(4);
 await expect(verifyCursorProfile({...pins,expectedEmail:'different@example.com'},'cache-key-one',lookupsFrom(rpc))).rejects.toThrow();expect(lookups).toBe(5);
});
test('Cursor never caches failed identity checks',async()=>{
 const pins={expectedEmail:'fail-cache@example.com',expectedUserId:'12'};let count=0;
 const rpc=async()=>{count++;return Response.json({user:{userEmail:'other@example.com',userId:'12'}})};
 for(let i=0;i<2;i++)await expect(verifyCursorProfile(pins,'bad-key',lookupsFrom(rpc))).rejects.toThrow();expect(count).toBe(2);
});
test('Cursor uncancelled profile waiters re-prove identity on their own bridge after the lookup owner aborts',async()=>{
 const pins={expectedEmail:'cancel-profile@example.com',expectedUserId:'12'};
 const controller=new AbortController();
 let began!:()=>void; const started=new Promise<void>(resolve=>{began=resolve});
 const ownerRpc=async()=>{
  began();
  await new Promise<void>((_resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(new DOMException('owner aborted','AbortError')),{once:true}));
  return Response.json({});
 };
 let independent=0;
 const ownRpc=async(_service:string,method:string)=>{
  independent++;
  return Response.json(method==='Me'?{user:{userEmail:pins.expectedEmail,userId:pins.expectedUserId}}:{items:[]});
 };
 const owner=verifyCursorProfile(pins,'cancel-profile-key',lookupsFrom(ownerRpc),controller.signal).catch((error:unknown)=>error);
 await started;
 const waiter=verifyCursorProfile(pins,'cancel-profile-key',lookupsFrom(ownRpc));
 controller.abort();
 expect(await owner).toBeInstanceOf(Error);
 expect(await waiter).toEqual([]);
 expect(independent).toBe(2);
});
test('Cursor cancelling a profile waiter leaves the lookup owner and its cached proof alive',async()=>{
 const pins={expectedEmail:'waiter-profile@example.com',expectedUserId:'12'};
 let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve});
 let calls=0;
 const rpc=async(_service:string,method:string)=>{
  calls++; if(method==='Me')await gate;
  return Response.json(method==='Me'?{user:{userEmail:pins.expectedEmail,userId:pins.expectedUserId}}:{items:[]});
 };
 const owner=verifyCursorProfile(pins,'waiter-profile-key',lookupsFrom(rpc));
 const controller=new AbortController();
 let waiterCalls=0;
 const ownRpc=async()=>{waiterCalls++;return Response.json({})};
 const waiter=verifyCursorProfile(pins,'waiter-profile-key',lookupsFrom(ownRpc),controller.signal).catch((error:unknown)=>error);
 controller.abort(new Error('cancel waiter'));
 expect(await waiter).toEqual(new Error('cancel waiter'));
 release();
 expect(await owner).toEqual([]);
 expect(await verifyCursorProfile(pins,'waiter-profile-key',lookupsFrom(ownRpc))).toEqual([]);
 expect(calls).toBe(2);expect(waiterCalls).toBe(0);
});
for(const refusal of ['identity','authentication','quota']as const){
 test('Cursor shared profile '+refusal+' refusals are never retried by a waiter when the owner also cancels',async()=>{
  const pins={expectedEmail:'refusal-profile@example.com',expectedUserId:'12'};
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
  const rpc=async()=>{
   await gate;
   if(refusal==='identity')return Response.json({user:{userEmail:'wrong@example.com',userId:'12'}});
   throw new CursorError('terminal '+refusal+' refusal');
  };
  const controller=new AbortController();
  const owner=verifyCursorProfile(pins,'refusal-profile-'+refusal,lookupsFrom(rpc),controller.signal).catch((error:unknown)=>error);
  let independent=0;
  const waiter=verifyCursorProfile(pins,'refusal-profile-'+refusal,lookupsFrom(async()=>{independent++;return Response.json({})})).catch((error:unknown)=>error);
  controller.abort();release();
  expect(await owner).toBeInstanceOf(Error);
  const error=await waiter;
  expect(error).toBeInstanceOf(CursorError);
  expect(String(error)).toContain(refusal==='identity'?'differs from the pinned identity':'terminal '+refusal+' refusal');
  expect(independent).toBe(0);
 });
}

test('Cursor cancellation is terminal and provider context overflow uses the native context code',()=>{
 try{finishedRun({status:'cancelled'},selection);throw new Error('expected failure');}
 catch(error){expect(error).toBeInstanceOf(CursorError);expect((error as CursorError).retryable).toBe(false)}
 try{finishedRun({status:'error',error:{message:'prompt is too long for this model'}},selection);throw new Error('expected failure');}
 catch(error){expect((error as BackendError).code).toBe('context_length_exceeded');expect((error as BackendError).retryable).toBe(false)}
});

test('SDK failures: network is an outage, retryable and server errors get one attempt, auth, quota and refusals are terminal',()=>{
 const named=(name:string,fields:JsonRecord={})=>Object.assign(new Error(name+' message'),{name,...fields});
 expect(cursorFailure(named('NetworkError'))).toBeInstanceOf(ProxyTransportError);
 expect(cursorFailure(new Error('fetch failed'))).toBeInstanceOf(ProxyTransportError);
 for(const [error,retryable] of [[named('CursorAgentError',{status:500}),true],[named('CursorAgentError',{isRetryable:true}),true],[named('ConfigurationError'),false],[named('AuthenticationError',{status:401}),false],[named('RateLimitError',{status:429}),false]] as const){
  const mapped=cursorFailure(error);expect(mapped).toBeInstanceOf(CursorError);expect((mapped as CursorError).retryable).toBe(retryable);
 }
 expect((cursorFailure(new Error('prompt is too long for this model')) as BackendError).code).toBe('context_length_exceeded');
});
