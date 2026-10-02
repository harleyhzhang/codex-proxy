// Shared contract every registered subscription backend must satisfy. Adding a backend to
// src/backends.ts enrolls it here automatically; nothing in this file names a model family.
import {test,expect,describe} from 'bun:test';
import { items, unwrap } from './support';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import { BACKENDS, backendFor, assertRoutable, publicModels } from '../src/backends/registry';
import { BackendError, adaptRequest, classifyCliFailure, retryOnce, RETRY_MARKER, type SubscriptionBackend } from '../src/backends/contract';
import { logSafe } from '../src/log';
import { SummaryCodec, portableSummary } from '../src/router/capsule';
import { HistoryCache } from '../src/router/history';
import { localResponse } from '../src/router/local';
import { startRouter } from '../src/router/server';

const GPT='gpt-6.1-sol';
const LOCAL=BACKENDS.flatMap(backend=>publicModels(backend).map(model=>({backend,model})));
const EVERY_MODEL=[GPT,...LOCAL.map(entry=>entry.model)];

// Shared failure policy every backend inherits through retryOnce, logSafe and classifyCliFailure.
describe('shared failure policy',()=>{
  test('a retryable refusal is retried exactly once and the second attempt is told why',async()=>{
    const notes:string[]=[];
    const result=await retryOnce('fixture',undefined,async note=>{notes.push(note);if(notes.length===1)throw new BackendError('bad arguments',{retryable:true});return 'ok';});
    expect(result).toBe('ok');expect(notes).toHaveLength(2);expect(notes[0]).toBe('');
    expect(notes[1]).toContain(RETRY_MARKER);expect(notes[1]).toContain('bad arguments');
    let calls=0;
    await expect(retryOnce('fixture',undefined,async()=>{calls++;throw new BackendError('still bad',{retryable:true});})).rejects.toThrow('still bad');
    expect(calls).toBe(2);
  });
  test('refusals, foreign errors and cancelled requests are never retried',async()=>{
    for(const failure of [new BackendError('refused'),new Error('crash')]){
      let calls=0;await expect(retryOnce('fixture',undefined,async()=>{calls++;throw failure;})).rejects.toBe(failure);expect(calls).toBe(1);
    }
    const controller=new AbortController();controller.abort();let calls=0;
    await expect(retryOnce('fixture',controller.signal,async()=>{calls++;throw new BackendError('x',{retryable:true});})).rejects.toThrow('x');
    expect(calls).toBe(1);
  });
  test('logs carry only scalars and word-like hints, never quoted text or nested content',()=>{
    const warn=console.warn,lines:string[]=[];console.warn=(line:string)=>{lines.push(line);};
    try{logSafe('fixture',{n:3,ok:true,none:null,hint:'Error: cannot open "SECRET_PATH" $(rm -rf) `x`',nested:{secret:'SECRET_NESTED'} as any,list:['SECRET_LIST'] as any});}
    finally{console.warn=warn;}
    const event=JSON.parse(lines[0]!);
    expect(event).toEqual({event:'fixture',n:3,ok:true,none:null,hint:'Error: cannot open  (rm -rf) x'});
    expect(lines[0]).not.toContain('SECRET');
  });
  test('exit classification: the account is never retried, transient failures are',()=>{
    expect(classifyCliFailure('HTTP 429 rate limit')).toEqual({category:'subscription usage limit reached',retryable:false});
    expect(classifyCliFailure('401 Unauthorized')).toEqual({category:'authentication failed',retryable:false});
    expect(classifyCliFailure('json schema validation failed')).toEqual({category:'structured output failed',retryable:true});
    expect(classifyCliFailure('connection reset by peer')).toEqual({category:'connection failed',retryable:true});
    expect(classifyCliFailure('upstream returned 503')).toEqual({category:'connection failed',retryable:true});
    expect(classifyCliFailure('segfault')).toEqual({category:'process failed',retryable:true});
    // A bare number inside an identifier must not read as an HTTP status.
    expect(classifyCliFailure('session a5003f')).toEqual({category:'process failed',retryable:true});
  });
});
const output={text:'',toolCalls:[],usage:{inputTokens:0,outputTokens:0,totalTokens:0}};

// Swap a backend's generation for a probe; always restored so tests cannot leak into each other.
async function withRun<T>(backend:SubscriptionBackend, run:SubscriptionBackend['run'], body:()=>Promise<T>):Promise<T> {
  const original=backend.run;backend.run=run;
  try{return await body();}finally{backend.run=original;}
}

async function server(upstream:(body:any)=>Response, withKey=false) {
  const dir=await mkdtemp(tmpdir()+'/backend-contract-');
  await Bun.write(dir+'/auth.json',JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture',account_id:'fixture'}}));
  await Bun.write(dir+'/catalog.json','{}');
  if(withKey)await Bun.write(dir+'/summary.key',Buffer.alloc(32,9));
  const calls:any[]=[];
  const instance=startRouter({port:0,authFile:dir+'/auth.json',catalog:dir+'/catalog.json',summaryKeyFile:withKey?dir+'/summary.key':undefined,
    upstreamFetch:(async(_url:string,init:any)=>{const body=JSON.parse(init.body);calls.push(body);return upstream(body);}) as unknown as typeof fetch});
  const post=(body:any)=>fetch(instance.url+'v1/responses',{method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify(body)});
  return {calls,post,close:async()=>{instance.stop(true);await rm(dir,{recursive:true});}};
}
const sse=(...events:any[])=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));

test('registry is unambiguous: every slug has exactly one owner and namespaces never overlap',()=>{
  expect(new Set(BACKENDS.map(b=>b.name)).size).toBe(BACKENDS.length);
  const owners=BACKENDS.flatMap(b=>Object.keys(b.models));
  expect(new Set(owners).size).toBe(owners.length);
  for(const a of BACKENDS)for(const b of BACKENDS)if(a!==b)expect(a.reservedPrefix.startsWith(b.reservedPrefix)).toBe(false);
  for(const backend of BACKENDS){
    expect(publicModels(backend).length).toBeGreaterThan(0);
    for(const slug of Object.keys(backend.models))expect(backendFor(slug)).toBe(backend);
  }
  expect(backendFor(GPT)).toBeUndefined();
});

describe.each(LOCAL.map(({backend,model})=>[model,backend] as const))('%s',(model,backend)=>{
  test('warmup answers locally without generation or usage',async()=>{
    let runs=0;
    const response=await withRun(backend,async()=>{runs++;return output;},()=>localResponse({model,input:[],generate:false}));
    expect(runs).toBe(0);expect(response.usage?.total_tokens).toBe(0);expect(response.output).toEqual([]);
  });
  test('request adapter keeps client tools and drops hosted tools, service tier and response ids',()=>{
    const adapted=adaptRequest({model,type:'response.create',previous_response_id:'r',service_tier:'priority',instructions:'KEEP',tools:[{type:'web_search'},{type:'function',name:'read'},{type:'namespace',name:'functions',tools:[]}]},backend);
    expect(adapted.model).toBe(backend.models[model]);expect((adapted.tools ?? []).map((t:any)=>t.type)).toEqual(['function','namespace']);
    expect(adapted.service_tier).toBeUndefined();expect(adapted.previous_response_id).toBeUndefined();expect(adapted.type).toBeUndefined();
    expect(adapted.instructions).toContain('KEEP');expect(adapted.instructions).toContain(`this ${backend.name} turn`);
  });
  test('unknown slug in its namespace is refused and never forwarded to GPT',async()=>{
    const unknown=backend.reservedPrefix+'does-not-exist';
    expect(()=>assertRoutable(unknown)).toThrow(BackendError);
    const app=await server(()=>{throw new Error('unexpected upstream');});
    try{const raw=await (await app.post({model:unknown,input:'hi',stream:true})).text();expect(raw).toContain('invalid_prompt');expect(app.calls).toHaveLength(0);}
    finally{await app.close();}
  });
  test('a backend refusal is terminal over HTTP and WebSocket with no fallback',async()=>{
    await withRun(backend,async()=>{throw new BackendError(`${backend.name} refused fixture`);},async()=>{
      const app=await server(()=>{throw new Error('unexpected upstream');});
      try{
        const streamed=await (await app.post({model,input:'hi',stream:true})).text();
        expect(streamed).toContain('response.failed');expect(streamed).toContain(`${backend.name} refused fixture`);
        const plain=await app.post({model,input:'hi'});expect(plain.status).toBe(400);
        expect(app.calls).toHaveLength(0);
      }finally{await app.close();}
    });
  });
  test('encrypted GPT helper task is restored before the backend sees it; refusal sends nothing',async()=>{
    const agent=(cipher:string)=>({model,input:[{type:'agent_message',author:'/root',recipient:'/root/helper',content:[{type:'encrypted_content',encrypted_content:cipher}]}]});
    for(const [cipher,reply,expected] of [['gAAAA-ok',{message:'TASK=READ_ONLY /fixture'},'TASK=READ_ONLY /fixture'],['gAAAA-refused',{message:"I cannot recover the task."},null]] as const){
      let seen:any;
      await withRun(backend,async request=>{seen=request;return output;},async()=>{
        const app=await server(()=>sse({type:'response.output_text.delta',delta:JSON.stringify(reply)},{type:'response.completed',response:{}}),true);
        try{
          const response=await app.post(agent(cipher));
          if(expected){expect(response.status).toBe(200);const text=JSON.stringify(seen.input);expect(text).toContain(expected);expect(text).not.toContain('gAAAA');}
          else{expect(response.status).toBe(400);expect(seen).toBeUndefined();}
          expect(app.calls.every(body=>body.tools?.length===0)).toBe(true);
        }finally{await app.close();}
      });
    }
  });
});

describe('every model pair, including GPT',()=>{
  const pairs=EVERY_MODEL.flatMap(from=>EVERY_MODEL.map(to=>[from,to] as const));
  test.each(pairs)('%s -> %s keeps tool call identity across a switch',(from,to)=>{
    const cache=new HistoryCache(),call={type:'custom_tool_call',namespace:'functions',name:'exec',call_id:'fixture-call',input:'return 42;'};
    cache.remember({model:from,input:[{role:'user',content:'KEEP_PATH=/fixture'}]},{id:'first',output:[call]});
    const continued=cache.expand({model:to,previous_response_id:'first',input:[{type:'custom_tool_call_output',call_id:'fixture-call',output:'42'}]});
    expect(items(continued)[1]!).toEqual(call);expect(items(continued)[2]!.call_id).toBe('fixture-call');expect(continued.previous_response_id).toBeUndefined();
  });
  test.each(pairs)('%s -> %s compaction restores exact requests and recent receipts even when the summary omits them',async(from,to)=>{
    const codec=new SummaryCodec(Buffer.alloc(32,8));
    const call={type:'custom_tool_call',name:'exec',namespace:'functions',call_id:'helper-call',input:'spawn helper'};
    const receipt={type:'custom_tool_call_output',call_id:'helper-call',output:'agent=/root/helper'};
    const history=[{role:'user',content:'FRONT=1; NEVER WRITE /locked'},{role:'user',content:'filler '.repeat(9000)},{role:'user',content:'MIDDLE=2'},call,receipt];
    const cache=new HistoryCache();
    cache.remember({model:from,input:history},{id:'compact',output:[{type:'compaction',encrypted_content:codec.seal(portableSummary(`lossy summary by ${from}`,history))}]});
    const restored=await unwrap(codec,cache.expand({model:to,previous_response_id:'compact',input:[{role:'user',content:'Continue'}]}));
    const text=JSON.stringify(restored.input);
    for(const exact of ['NEVER WRITE /locked','MIDDLE=2','agent=/root/helper',`lossy summary by ${from}`])expect(text).toContain(exact);
    expect(restored.input).toContainEqual(call);expect(items(restored).at(-1)?.content).toBe('Continue');
  });
});
