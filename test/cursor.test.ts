import { describe, expect, test } from 'bun:test';
import { connectFrames, cursorEnvironment, cursorSelection, interpretCursorEvents, parseCursorOutput, assertCursorIdentity, verifyCursorProfile, sanitizeCursorInput, coerceCustomArguments, CursorError } from '../src/backends/cursor';

test('Cursor unwraps object-wrapped custom tool arguments instead of refusing the turn',()=>{
 expect(coerceCustomArguments('raw')).toBe('raw');
 expect(coerceCustomArguments({code:'await tools.exec_command({cmd:"ls"})'})).toBe('await tools.exec_command({cmd:"ls"})');
 expect(coerceCustomArguments({input:'*** Begin Patch'})).toBe('*** Begin Patch');
 expect(coerceCustomArguments({whatever:'x'})).toBe('x');
 expect(coerceCustomArguments({a:'x',b:'y'})).toBeUndefined();
 expect(coerceCustomArguments({code:'text(1)',patch:'different input'})).toBeUndefined();
 expect(coerceCustomArguments({code:'text(1)',yield_time_ms:1000})).toBeUndefined();
 expect(coerceCustomArguments({code:'text(1)',call_id:'fixture',index:0})).toBe('text(1)');
 expect(coerceCustomArguments({cmd:1})).toBeUndefined();
 expect(coerceCustomArguments(undefined)).toBe('');
 const req={model:'kimi-k3',input:'t',tools:[{type:'custom',name:'exec'}]} as const;
 const out=parseCursorOutput(JSON.stringify({text:'',tool_calls:[{name:'exec',arguments:{code:'text(1)'}}]}),req as never);
 expect(out.toolCalls.map(c=>[c.name,c.arguments])).toEqual([['exec','text(1)']]);
});

test('Cursor unwraps Kimi native-markup custom calls that carry a call_id beside a singular argument key (October 13 refusal)',()=>{
 // Exact shape captured in mixed/cursor-integration/invalid-output on October 13: {call_id, argument}.
 expect(coerceCustomArguments({call_id:'call_6b3a',argument:'text(JSON.stringify(ALL_TOOLS.map(t=>t.name)));'})).toBe('text(JSON.stringify(ALL_TOOLS.map(t=>t.name)));');
 expect(coerceCustomArguments({id:'x',index:1,payload:'raw'})).toBe('raw');
 expect(coerceCustomArguments({cmd:'ls'})).toBe('ls');
 // Only pragma numbers and no code at all is still unrecoverable.
 expect(coerceCustomArguments({max_output_tokens:4000,yield_time_ms:25000})).toBeUndefined();
 const req={model:'kimi-k3',input:'t',tools:[{type:'custom',name:'exec'}]} as const;
 const markup='Checking ALL_TOOLS.<|open|>tools<|sep|><|open|>call tool="exec" index="1"<|sep|><|open|>argument key="call_id" type="string"<|sep|>call_6b3a<|close|>argument<|sep|><|open|>argument key="argument" type="string"<|sep|>text(ALL_TOOLS.length);<|close|>argument<|sep|><|close|>call<|sep|><|close|>tools<|sep|>';
 const out=parseCursorOutput(markup,req as never);
 expect(out.toolCalls.map(c=>[c.name,c.arguments])).toEqual([['exec','text(ALL_TOOLS.length);']]);
 const bad=JSON.stringify({text:'',tool_calls:[{name:'exec',arguments:{max_output_tokens:4000,yield_time_ms:25000}}]});
 expect(()=>parseCursorOutput(bad,req as never)).toThrow(/got max_output_tokens, yield_time_ms.*@exec: pragma/);
});

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
 expect((items[0]!.content as R[])[2]).toEqual({type:'input_text',text:'[attachment omitted: the Cursor bridge accepts text and inline images only]'});
 expect((items[2]!.output as R[])[1]).toEqual({type:'input_text',text:'done'});
 expect(JSON.stringify(result.input)).not.toContain('gAAAA');
 expect(history[1]!.encrypted_content).toBe('gAAAAopaque');
 expect(sanitizeCursorInput('just text')).toEqual({input:'just text',dropped:0,replaced:0});
});
import { ClaudeUsageLimitError } from '../src/backends/claude-limits';
import { BackendError, type SubscriptionBackend } from '../src/backends/contract';
import { withOpusQuotaFallback } from '../src/backends/quota-fallback';
import type { ResponsesRequest } from '../src/protocol/types';
import { responseObject } from '../src/protocol/output';
import { preparePrompt, requestTools, toolDescriptors } from '../src/protocol/prompt';
import type { JsonRecord } from '../src/json';
const request: ResponsesRequest = {model:'kimi-k3',input:'test',tools:[{type:'namespace',name:'functions',tools:[{type:'function',name:'read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}]},{type:'custom',name:'apply_patch'}]};
const output=(value:unknown)=>parseCursorOutput(JSON.stringify(value),request);
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
test('Cursor preserves namespaced function objects and exact custom raw input',()=>{
 const result=output({text:'',tool_calls:[{name:'functions.read',arguments:{path:'hello'}},{name:'apply_patch',arguments:'*** Begin Patch\n*** End Patch'}]});
 expect(result.toolCalls.map(c=>[c.name,c.arguments])).toEqual([['functions.read','{"path":"hello"}'],['apply_patch','*** Begin Patch\n*** End Patch']]);
});
for(const invalid of [
 {text:'',tool_calls:[{name:'shell',arguments:{}}]},
 {text:'',tool_calls:[{name:'functions.read',arguments:{path:1}}]},
 {text:'',tool_calls:[{name:'functions.read',arguments:{}}]},
 {text:'',tool_calls:[{name:'apply_patch',arguments:{patch:1,other:true}}]},
])test('Cursor refuses malformed or unavailable action '+JSON.stringify(invalid),()=>{expect(()=>output(invalid)).toThrow(CursorError)});
test('Cursor lenient parser tolerates fences, extra keys, extra args and OpenAI-style calls',()=>{
 const fenced='Here is my answer:\n```json\n{"text":"hi","tool_calls":[{"name":"functions.read","arguments":"{\\"path\\":\\"a\\"}"}]}\n```';
 expect(parseCursorOutput(fenced,request).toolCalls.map(c=>[c.name,c.arguments])).toEqual([['functions.read','{"path":"a"}']]);
 expect(output({text:'',tool_calls:[{name:'functions.read',arguments:{path:'a',extra:true}}]}).toolCalls[0]!.arguments).toBe('{"path":"a"}');
 expect(output({text:'',tool_calls:[],extra:true}).toolCalls).toEqual([]);
 expect(output({text:'',tool_calls:[{type:'function',function:{name:'functions.read',arguments:{path:'a'}}}]}).toolCalls[0]!.name).toBe('functions.read');
 expect(()=>parseCursorOutput('this is not the JSON object',request)).toThrow(/no Codex actions were executed/);
});
test('Cursor does not classify assistant quota text as a failure',()=>expect(output({text:'quota 429 expired',tool_calls:[]}).text).toBe('quota 429 expired'));
test('Cursor accepts a tool that an earlier tool_search loaded and replies with its namespace',()=>{
 const web={type:'namespace',name:'mcp__apps__search',tools:[{type:'function',name:'_web_run',parameters:{type:'object',properties:{q:{type:'string'}}}}]};
 const loaded:ResponsesRequest={...request,input:[{type:'tool_search_call',call_id:'c1',arguments:{query:'web'}},{type:'tool_search_output',call_id:'c1',tools:[web,request.tools![0]]}]};
 const text=JSON.stringify({text:'',tool_calls:[{name:'mcp__apps__search._web_run',arguments:{q:'boron'}}]});
 expect(()=>parseCursorOutput(text,request)).toThrow(/unknown tool/);
 const parsed=parseCursorOutput(text,loaded);
 expect(parsed.toolCalls.map(c=>[c.name,c.arguments])).toEqual([['mcp__apps__search._web_run','{"q":"boron"}']]);
 expect(responseObject(loaded,parsed).output).toContainEqual(expect.objectContaining({type:'function_call',namespace:'mcp__apps__search',name:'_web_run'}));
 expect(toolDescriptors(requestTools(loaded)).filter(t=>t.proxyName==='functions.read')).toHaveLength(1);
});
test('Cursor repairs Kimi miscounted closers at the end of a tool call',()=>{
 const body='{"text":"t","tool_calls":[{"name":"apply_patch","arguments":"x({a:\'{\'})"}';
 for(const tail of ['}]}','}}]}','}}]'])expect(parseCursorOutput(body+tail,request).toolCalls.map(c=>[c.name,c.arguments])).toEqual([['apply_patch',"x({a:'{'})"]]);
});
test('Cursor model parameters are family specific and unsupported effort is refused',()=>{
 expect(cursorSelection('kimi-k3','max').params).toEqual([{id:'reasoning',value:'max'}]);
 expect(cursorSelection('grok-4.7','xhigh',true).params).toContainEqual({id:'fast',value:'true'});
 expect(cursorSelection('grok-4.7','xhigh').params).toContainEqual({id:'reasoning_effort',value:'xhigh'});
 expect(()=>cursorSelection('gpt-5.6-sol','none')).toThrow();
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
test('an errored run is retryable only when Cursor gives no reason or a transient one',()=>{
 const errored=(run:JsonRecord):JsonRecord[]=>[{result:{status:'RUN_LIFECYCLE_STATUS_ERROR',runId:'r',result:{status:'RUN_LIFECYCLE_STATUS_ERROR',...run}}},{done:{runId:'r'}}];
 const caught=(run:JsonRecord)=>{try{interpretCursorEvents(errored(run),request,selection);}catch(error){return error as CursorError;}throw new Error('expected a refusal');};
 const opaque=caught({});
 expect(opaque.retryable).toBe(true); expect(opaque.message).toContain('run status ERROR with no reason from Cursor');
 expect(caught({error:'upstream provider rate limit exceeded'}).retryable).toBe(true);
 const policy=caught({error:'model refused the request policy'});
 expect(policy.retryable).toBe(false); expect(policy.message).toContain('run status ERROR: model refused the request policy');
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
test('Cursor uncancelled profile waiters re-prove identity on their own bridge after the lookup owner aborts',async()=>{
 const pins={expectedEmail:'cancel-profile@example.com',expectedUserId:'12',binaryHash:'cancel-profile-fixture'};
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
 const owner=verifyCursorProfile(pins,'cancel-profile-key',ownerRpc,controller.signal).catch((error:unknown)=>error);
 await started;
 const waiter=verifyCursorProfile(pins,'cancel-profile-key',ownRpc);
 controller.abort();
 expect(await owner).toBeInstanceOf(Error);
 expect(await waiter).toEqual({items:[]});
 expect(independent).toBe(2);
});
test('Cursor cancelling a profile waiter leaves the lookup owner and its cached proof alive',async()=>{
 const pins={expectedEmail:'waiter-profile@example.com',expectedUserId:'12',binaryHash:'waiter-profile-fixture'};
 let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve});
 let calls=0;
 const rpc=async(_service:string,method:string)=>{
  calls++; if(method==='Me')await gate;
  return Response.json(method==='Me'?{user:{userEmail:pins.expectedEmail,userId:pins.expectedUserId}}:{items:[]});
 };
 const owner=verifyCursorProfile(pins,'waiter-profile-key',rpc);
 const controller=new AbortController();
 let waiterCalls=0;
 const ownRpc=async()=>{waiterCalls++;return Response.json({})};
 const waiter=verifyCursorProfile(pins,'waiter-profile-key',ownRpc,controller.signal).catch((error:unknown)=>error);
 controller.abort(new Error('cancel waiter'));
 expect(await waiter).toEqual(new Error('cancel waiter'));
 release();
 expect(await owner).toEqual({items:[]});
 expect(await verifyCursorProfile(pins,'waiter-profile-key',ownRpc)).toEqual({items:[]});
 expect(calls).toBe(2);expect(waiterCalls).toBe(0);
});
for(const refusal of ['identity','authentication','quota']as const){
 test('Cursor shared profile '+refusal+' refusals are never retried by a waiter when the owner also cancels',async()=>{
  const pins={expectedEmail:'refusal-profile@example.com',expectedUserId:'12',binaryHash:'refusal-profile-'+refusal};
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
  const rpc=async()=>{
   await gate;
   if(refusal==='identity')return Response.json({user:{userEmail:'wrong@example.com',userId:'12'}});
   throw new CursorError('terminal '+refusal+' refusal');
  };
  const controller=new AbortController();
  const owner=verifyCursorProfile(pins,'refusal-profile-'+refusal,rpc,controller.signal).catch((error:unknown)=>error);
  let independent=0;
  const waiter=verifyCursorProfile(pins,'refusal-profile-'+refusal,async()=>{independent++;return Response.json({})}).catch((error:unknown)=>error);
  controller.abort();release();
  expect(await owner).toBeInstanceOf(Error);
  const error=await waiter;
  expect(error).toBeInstanceOf(CursorError);
  expect(String(error)).toContain(refusal==='identity'?'differs from the pinned identity':'terminal '+refusal+' refusal');
  expect(independent).toBe(0);
 });
}

test('Cursor bare prose (Grok narration) refuses on the first attempt with the exact wrap and is delivered as text-only on the retry',()=>{
 expect(()=>parseCursorOutput("I'll read those sections next.",request)).toThrow(/wrote the narration \"I'll read those sections next\.\" instead of acting/);
 expect(()=>parseCursorOutput("I'll read those sections next.",request)).toThrow(/must begin with the character \{/);
 try { parseCursorOutput("I'll read those sections next.",request); } catch (error) { expect((error as CursorError).retries).toBe(2); expect((error as CursorError).retryable).toBe(true); }
 const out=parseCursorOutput("  I'll read those sections next.\n",request,undefined,true);
 expect(out.text).toBe("I'll read those sections next.");
 expect(out.toolCalls).toEqual([]);
});
test('Cursor malformed JSON containing a brace is still refused as unparseable even on the retry',()=>{
 expect(()=>parseCursorOutput('{"text": "oops", tool_calls: [',request,undefined,true)).toThrow(/parseable JSON object/);
});
test('Cursor accepts plain text immediately only when the complete tool list is empty',()=>{
 const withoutTools={...request,tools:[]};
 expect(parseCursorOutput('  ordinary final answer\n',withoutTools).text).toBe('ordinary final answer');
 expect(parseCursorOutput('ordinary final answer',withoutTools).toolCalls).toEqual([]);
 expect(()=>parseCursorOutput('{"text": broken',withoutTools)).toThrow(/parseable JSON object/);
 expect(()=>parseCursorOutput('broken JSON }',withoutTools)).toThrow(/parseable JSON object/);
 expect(()=>parseCursorOutput('ordinary final answer',request)).toThrow(/wrote the narration/);
 const loaded={...withoutTools,input:[{type:'tool_search_output',tools:[{type:'function',name:'loaded',parameters:{type:'object'}}]}]};
 expect(()=>parseCursorOutput('ordinary final answer',loaded)).toThrow(/wrote the narration/);
});

test('Cursor accepts standard explicit namespaces and custom envelopes only for exact declared tools',()=>{
 const req:ResponsesRequest={model:'grok-4.7',input:'Inspect the synthetic fixture.',tools:[{type:'namespace',name:'functions',tools:[{type:'custom',name:'exec'},{type:'function',name:'lookup',parameters:{type:'object',properties:{key:{type:'string'}},required:['key'],additionalProperties:false}}]}]};
 const custom=parseCursorOutput(JSON.stringify({text:'',tool_calls:[{type:'custom_tool_call',namespace:'functions',name:'exec',input:'text("synthetic");'}]}),req);
 expect(custom.toolCalls.map(call=>[call.name,call.arguments])).toEqual([['functions.exec','text("synthetic");']]);
 const wrapped=parseCursorOutput(JSON.stringify({text:'',tool_calls:[{custom:{namespace:'functions',name:'exec',input:'text(1)'}}]}),req);
 expect(wrapped.toolCalls[0]?.name).toBe('functions.exec');expect(wrapped.toolCalls[0]?.arguments).toBe('text(1)');
 const standalone=parseCursorOutput(JSON.stringify({type:'custom_tool_call',namespace:'functions',name:'exec',input:'text(2)'}),req);
 expect(standalone.toolCalls.map(call=>[call.name,call.arguments])).toEqual([['functions.exec','text(2)']]);
 const fn=parseCursorOutput(JSON.stringify({text:'',tool_calls:[{namespace:'functions',name:'lookup',arguments:{key:'fixture'}}]}),req);
 expect(fn.toolCalls[0]?.name).toBe('functions.lookup');expect(JSON.parse(fn.toolCalls[0]!.arguments)).toEqual({key:'fixture'});
 expect(()=>parseCursorOutput(JSON.stringify({text:'',tool_calls:[{namespace:'other',name:'exec',input:'text(1)'}]}),req)).toThrow(/unknown tool/);
 expect(()=>parseCursorOutput(JSON.stringify({unexpected:'synthetic'}),req)).toThrow(/without text or tool_calls/);
 expect(()=>parseCursorOutput(JSON.stringify({name:'undeclared',arguments:{}}),req)).toThrow(/unknown tool/);
});

test('Cursor does not finish a clear short action request with only a future-action promise, even on its final attempt',()=>{
 const action={...request,input:'Please inspect the synthetic fixture and report the result.'};
 const narration="I'll inspect the synthetic fixture next.";
 for(const accept of[false,true]){
  expect(()=>parseCursorOutput(narration,action,undefined,accept)).toThrow(/narration/);
  expect(()=>parseCursorOutput(JSON.stringify({text:narration,tool_calls:[]}),action,undefined,accept)).toThrow(/future tool action/);
 }
 for(const verb of['call','invoke']){
  const req={...request,input:`${verb} the declared tool once with the synthetic payload.`};
  const promise=`I will ${verb} the declared tool now.`;
  expect(()=>parseCursorOutput(JSON.stringify({text:promise,tool_calls:[]}),req,undefined,true)).toThrow(/future tool action/);
  expect(parseCursorOutput(promise,{...request,input:'Return exactly this literal sentence: '+promise}).text).toBe(promise);
  expect(parseCursorOutput(JSON.stringify({text:promise,tool_calls:[]}),{...request,input:'Draft an email using this sentence: '+promise}).text).toBe(promise);
 }
});

test('Cursor preserves legitimate quoted wording, drafts, translations, plans and final prose without forcing tools',()=>{
 const prose="I'll inspect the synthetic fixture next.";
 for(const input of['Return exactly this sentence: '+prose,'Draft an email that says '+prose,'Translate this quoted sentence into English: '+prose,'Write a plan for checking the synthetic fixture.','Review this draft email wording.']){
  const req={...request,input};
  expect(parseCursorOutput(prose,req).text).toBe(prose);
  expect(parseCursorOutput(JSON.stringify({text:prose,tool_calls:[]}),req).toolCalls).toEqual([]);
 }
 expect(parseCursorOutput('The synthetic fixture has three fields.',{...request,input:'Inspect the synthetic fixture.'},undefined,true).text).toBe('The synthetic fixture has three fields.');
});

test('Cursor lifecycle cancellation is terminal and provider context overflow uses the native context code',()=>{
 for(const status of['CANCELLED','CANCELED']){
  try{interpretCursorEvents([{result:{status:'RUN_LIFECYCLE_STATUS_'+status,runId:'r',result:{status:'RUN_LIFECYCLE_STATUS_'+status}}},{done:{runId:'r'}}],request,selection);throw new Error('expected failure');}
  catch(error){expect(error).toBeInstanceOf(CursorError);expect((error as CursorError).retryable).toBe(false)}
 }
 try{interpretCursorEvents([{result:{status:'RUN_LIFECYCLE_STATUS_ERROR',runId:'r',result:{status:'RUN_LIFECYCLE_STATUS_ERROR',error:'prompt is too long for this model'}}},{done:{runId:'r'}}],request,selection);throw new Error('expected failure');}
 catch(error){expect((error as BackendError).code).toBe('context_length_exceeded');expect((error as BackendError).retryable).toBe(false)}
});

test('Cursor Connect internal failures retry safely while auth, bad arguments and quota remain terminal',async()=>{
 for(const [code,retryable]of[['internal',true],['unknown',true],['invalid_argument',false],['unauthenticated',false],['resource_exhausted',false]]as const){
  try{for await(const _ of connectFrames(stream([frame({error:{code}},2)]))){}throw new Error('expected failure');}
  catch(error){expect(error).toBeInstanceOf(CursorError);expect((error as CursorError).retryable).toBe(retryable)}
 }
});
