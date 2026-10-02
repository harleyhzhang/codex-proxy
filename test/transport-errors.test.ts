import { test, expect } from 'bun:test';
import { items } from './support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { transportError, ProxyTransportError } from '../src/transport';
import { sseEvents } from '../src/protocol/stream';
import { startRouter } from '../src/router/server';
import { responseObject, streamResponse } from '../src/protocol/output';

test('network and timeout failures are retryable; auth, quota and cancellation are not misclassified', () => {
  for(const code of ['ECONNRESET','ENOTFOUND','ENETUNREACH','EAI_AGAIN','EPIPE']) {
    expect(transportError(Object.assign(new Error('private diagnostic'),{code}))?.message).toContain('Network connection interrupted');
  }
  expect(transportError(new Error('fetch failed',{cause:Object.assign(new Error('private'),{code:'ECONNREFUSED'})}))).toBeInstanceOf(ProxyTransportError);
  expect(transportError(new DOMException('private','TimeoutError'))?.message).toContain('timed out');
  expect(transportError(new Error('Unable to connect to API'))).toBeInstanceOf(ProxyTransportError);
  for(const message of ['Claude session limit reached','authentication failed','invalid structured output','Claude request cancelled'])expect(transportError(new Error(message))).toBeUndefined();
  expect(transportError(new DOMException('cancelled','AbortError'))).toBeUndefined();
});

test('upstream EOF without a terminal event reports a dropped connection instead of hanging', async () => {
  const encoder=new TextEncoder();
  const response=new Response(encoder.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
  const events:any[]=[];
  await expect(sseEvents(response,e=>events.push(e))).rejects.toThrow(ProxyTransportError);
  expect(events[0].delta).toBe('partial');
  const completed=new Response('data: {"type":"response.completed","response":{}}');
  await sseEvents(completed,()=>{});
});

test('HTTP and WebSocket disconnect errors remain retryable and a later request completes with the original history', async () => {
  const dir=await mkdtemp(tmpdir()+'/proxy-transport-');
  await Bun.write(dir+'/auth.json',JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'test-token',account_id:'test-account'}}));
  await Bun.write(dir+'/catalog.json','{}');
  let broken=true;
  const upstreamFetch=(async (_url:any,options:any)=>{
    if(broken)throw Object.assign(new Error('private diagnostic must not leak'),{code:'ECONNRESET'});
    const body=JSON.parse(options.body);
    expect(items(body)[0]!.content).toBe('Keep original history');
    return streamResponse(responseObject(body,{text:'RECOVERED',toolCalls:[],usage:{inputTokens:2,outputTokens:1,totalTokens:3}}));
  }) as typeof fetch;
  const server=startRouter({port:0,authFile:dir+'/auth.json',catalog:dir+'/catalog.json',upstreamFetch});
  const headers={authorization:'Bearer test-token','chatgpt-account-id':'test-account','content-type':'application/json'};
  const body={model:'gpt-6.1-sol',input:[{role:'user',content:'Keep original history'}],stream:true};
  const Socket=WebSocket as unknown as {new(url:string,options:{headers:Record<string,string>}):WebSocket};
  let ws:WebSocket|undefined;
  try {
    const response=await fetch(server.url+'v1/responses',{method:'POST',headers,body:JSON.stringify(body)});
    expect(response.status).toBe(200);
    const text=await response.text();expect(text).toContain('server_error');expect(text).toContain('Network connection interrupted');expect(text).not.toContain('private diagnostic');expect(text).not.toContain('subscription');
    const plain=await fetch(server.url+'v1/responses',{method:'POST',headers,body:JSON.stringify({...body,stream:false})});expect(plain.status).toBe(503);
    ws=new Socket(server.url.toString().replace('http:','ws:')+'v1/responses',{headers});
    await new Promise<void>((resolve,reject)=>{ws!.onopen=()=>resolve();ws!.onerror=()=>reject(new Error('test socket failed'));});
    const request=()=>new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('test response timed out')),2000);
      ws!.onmessage=e=>{const event=JSON.parse(String(e.data));if(['response.failed','response.completed'].includes(event.type)){clearTimeout(timer);resolve(event);}};
      ws!.send(JSON.stringify({type:'response.create',...body}));
    });
    const failed=await request();expect(failed.type).toBe('response.failed');expect(failed.response.error.code).toBe('server_error');
    broken=false;
    const recovered=await request();expect(recovered.type).toBe('response.completed');expect(recovered.response.output[0].content[0].text).toBe('RECOVERED');
  } finally {ws?.close();server.stop(true);await rm(dir,{recursive:true});}
});
