import {test,expect} from 'bun:test';
import { items, firstText, unwrap } from './support';
import { grokEnvironment, parseGrokOutput, runGrok } from '../src/backends/grok';
import { SummaryCodec, compactRequest } from '../src/router/capsule';
import { HistoryCache } from '../src/router/history';
import { localResponse } from '../src/router/local';
import { normalizeAgentPayloads } from '../src/router/bridge';
const tools:any[]=[{type:'namespace',name:'functions',tools:[{type:'custom',name:'exec'}]},{type:'function',name:'read'}];
test('Grok enforces tool allowlist, raw custom input, object function args and unique IDs',()=>{
 const request={model:'grok-4.7',input:'test',tools};
 const parsed=parseGrokOutput(JSON.stringify({text:'',tool_calls:[{name:'functions.exec',arguments:'await tools.read();'},{name:'read',arguments:'{"path":"fixture"}'}]}),request);
 expect(parsed.toolCalls[0].arguments).toBe('await tools.read();');expect(parsed.toolCalls[0].callId).not.toBe(parsed.toolCalls[1].callId);
 for(const tool_calls of [[{name:'native_shell',arguments:'{}'}],[{name:'read',arguments:'not json'}],[{name:'read',arguments:'[]'}],[{name:'read',arguments:5}]])expect(()=>parseGrokOutput(JSON.stringify({text:'',tool_calls}),request)).toThrow();
 expect(()=>parseGrokOutput('broken',request)).toThrow();
});
test('Grok warmup never starts CLI, images and foreign subagent ciphertext fail closed',async()=>{
 expect((await localResponse({model:'grok-4.7',input:[],generate:false})).usage?.total_tokens).toBe(0);
 await expect(runGrok({model:'grok-4.7',input:[{type:'agent_message',content:[{type:'encrypted_content',encrypted_content:'gAAAA-opaque'}]}]})).rejects.toThrow('encrypted GPT');
 await expect(runGrok({model:'grok-4.7',input:[{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,YQ=='}]}]})).rejects.toThrow('no image');
 await expect(runGrok({model:'grok-4.6',input:'hi'})).rejects.toThrow('Unsupported');
});
test('Grok does not inherit paid API keys or scanner integrations',()=>{
 const before=process.env.XAI_API_KEY;process.env.XAI_API_KEY='fixture-paid-key';try{const env=grokEnvironment();expect(env.XAI_API_KEY).toBeUndefined();expect(env.GROK_MEMORY).toBe('0');expect(env.GROK_SUBAGENTS).toBe('0');expect(env.GROK_CLAUDE_HOOKS_ENABLED).toBe('0');}finally{if(before===undefined)delete process.env.XAI_API_KEY;else process.env.XAI_API_KEY=before;}
});
test('Grok bridges GPT compaction before consumption, refuses missing bridge or tampered summary',async()=>{
 const codec=new SummaryCodec(Buffer.alloc(32,3));let calls=0;const body={model:'grok-4.7',input:[{type:'compaction',encrypted_content:'gAAAA-opaque'}]};
 await expect(unwrap(codec,body)).rejects.toThrow('OpenAI-encrypted');
 const readable=await unwrap(codec,body,async encrypted=>{calls++;expect(encrypted).toBe('gAAAA-opaque');return 'CONSTRAINT=NO_WRITE';});expect(calls).toBe(1);expect(firstText(items(readable)[0])).toContain('CONSTRAINT=NO_WRITE');
 const capsule=codec.seal('test');await expect(unwrap(codec,{model:'grok-4.7',input:[{type:'compaction',encrypted_content:capsule.slice(0,-4)+'aaaa'}]})).rejects.toThrow();
 const compact=compactRequest({...body,tools,context_management:{},input:[{role:'user',content:'constraint'},{type:'compaction_trigger'}]});expect(compact.tools).toEqual([]);expect(compact.context_management).toBeUndefined();
});
test('Grok plaintext subagent task reaches every recipient with metadata preserved',()=>{
 const body={input:[{type:'agent_message',author:'/root',recipient:'/root/child',content:[{type:'encrypted_content',encrypted_content:'TASK=READ_ONLY; PATH=/fixture'}]}]};const normalized=normalizeAgentPayloads(body);expect(items(normalized)[0]!.author).toBe('/root');expect(items(normalized)[0]!.recipient).toBe('/root/child');expect(items(normalized)[0]!.content?.[0]).toEqual({type:'input_text',text:'TASK=READ_ONLY; PATH=/fixture'});
});
test('Grok refuses unresolved compaction and unsupported files before any model generation',async()=>{
 await expect(runGrok({model:'grok-4.7',input:[{type:'compaction',content:'opaque'}]})).rejects.toThrow('unrestored compaction');
 await expect(runGrok({model:'grok-4.7',input:[{role:'user',content:[{type:'input_file',file_id:'fixture-file'}]}]})).rejects.toThrow('attachment');
});
test('Grok unsafe inputs produce terminal HTTP and WebSocket failures without upstream fallback',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {startRouter}=await import('../src/router/server');
 const dir=await mkdtemp(tmpdir()+'/grok-terminal-');await Bun.write(dir+'/auth.json',JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture',account_id:'fixture'}}));await Bun.write(dir+'/catalog.json','{}');let upstream=0;
 const server=startRouter({port:0,authFile:dir+'/auth.json',catalog:dir+'/catalog.json',upstreamFetch:(async()=>{upstream++;throw new Error('unexpected fallback');}) as unknown as typeof fetch});
 const headers={authorization:'Bearer fixture'};
 try {
  const response=await fetch(server.url+'v1/responses',{method:'POST',headers,body:JSON.stringify({model:'grok-4.6',input:'test',generate:false,stream:true})});const raw=await response.text();expect(raw).toContain('response.failed');expect(raw).toContain('invalid_prompt');
  const result=await new Promise<any>((resolve,reject)=>{const Socket=WebSocket as unknown as {new(url:string,options:{headers:Record<string,string>}):WebSocket};const ws=new Socket(String(server.url).replace('http','ws')+'v1/responses',{headers});const timer=setTimeout(()=>{ws.close();reject(new Error('timeout'));},2000);ws.onopen=()=>ws.send(JSON.stringify({type:'response.create',model:'grok-4.7',input:[{type:'compaction',encrypted_content:'unrestored'}]}));ws.onmessage=e=>{clearTimeout(timer);ws.close();resolve(JSON.parse(String(e.data)));};ws.onerror=reject;});
  expect(result.type).toBe('response.failed');expect(result.response.error.code).toBe('invalid_prompt');expect(upstream).toBe(0);
 }finally{server.stop(true);await rm(dir,{recursive:true});}
});
test('encrypted helper handoff decoder preserves metadata, caches authenticated text and fails closed on invalid extraction',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {CompactionBridge}=await import('../src/router/bridge');
 const dir=await mkdtemp(tmpdir()+'/grok-handoff-');const codec=new SummaryCodec(Buffer.alloc(32,4));let calls=0;const item={type:'agent_message',author:'/root',recipient:'/root/child',content:[]};
 const frame=(e:any)=>'data: '+JSON.stringify(e)+'\n\n';
 const bridge=new CompactionBridge(codec,dir,async body=>{calls++;expect(body.tools).toEqual([]);expect(items(body)[0]!.author).toBe('/root');expect(items(body)[0]!.recipient).toBe('/root/child');expect((items(body)[0]!.content?.[0] as { encrypted_content?: string }).encrypted_content).toBe('gAAAA-fixture');return new Response(frame({type:'response.output_text.delta',delta:JSON.stringify({message:'TASK=ONLY_READ /fixture; NEVER_WRITE'})})+frame({type:'response.completed',response:{}}));});
 try{
  expect(await bridge.agentText(item,'gAAAA-fixture')).toBe('TASK=ONLY_READ /fixture; NEVER_WRITE');expect(await bridge.agentText(item,'gAAAA-fixture')).toBe('TASK=ONLY_READ /fixture; NEVER_WRITE');expect(calls).toBe(1);
  for(const file of new Bun.Glob('*.cap').scanSync(dir))expect(await Bun.file(dir+'/'+file).text()).not.toContain('NEVER_WRITE');
  const invalid=new CompactionBridge(codec,dir,async()=>new Response(frame({type:'response.output_text.delta',delta:'invented response without structured message'})+frame({type:'response.completed',response:{}})));await expect(invalid.agentText(item,'gAAAA-other')).rejects.toThrow('no task was sent');
  const refused=new CompactionBridge(codec,dir,async()=>new Response(frame({type:'response.output_text.delta',delta:JSON.stringify({message:"I cannot recover the task."})})+frame({type:'response.completed',response:{}})));await expect(refused.agentText(item,'gAAAA-refusal')).rejects.toThrow('no task was sent');
 }finally{await rm(dir,{recursive:true});}
});
test('Grok isolation fingerprint changes for a modified native deny hook',async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {grokProfileHash}=await import('../src/backends/grok');
 const dir=await mkdtemp(tmpdir()+'/grok-profile-');await mkdir(dir+'/home');await mkdir(dir+'/home/hooks');await writeFile(dir+'/home/hooks/deny.json','deny');await writeFile(dir+'/deny-native.py','deny');const old=process.env.GROK_HOME;
 try{process.env.GROK_HOME=dir+'/home';const before=grokProfileHash();await writeFile(dir+'/deny-native.py','changed');expect(grokProfileHash()).not.toBe(before);}finally{if(old===undefined)delete process.env.GROK_HOME;else process.env.GROK_HOME=old;await rm(dir,{recursive:true});}
});
test('portable compaction retains short user requests even if the model omits middle constraints',async()=>{
 const {portableSummary}=await import('../src/router/capsule');const codec=new SummaryCodec(Buffer.alloc(32,8));
 const source=[{role:'user',content:'FRONT=123; NEVER WRITE /locked'},{role:'user',content:'irrelevant '.repeat(9000)},{role:'user',content:[{type:'input_text',text:'MIDDLE=456; pending read-only /next'}]},{role:'user',content:'TAIL=789'}];
 const first=codec.seal(portableSummary('Lossy summary contains only TAIL=789',source));
 const restored=await unwrap(codec,{model:'grok-4.7',input:[{type:'compaction',encrypted_content:first}]});
 expect(JSON.stringify(restored)).toContain('MIDDLE=456');expect(JSON.stringify(restored)).toContain('NEVER WRITE /locked');expect(restored.input).toHaveLength(4);
 const second=codec.seal(portableSummary('Another lossy summary',items(restored)));
 for(const model of ['gpt-6.1-sol','claude-opus-5-5','grok-4.7']){const again=await unwrap(codec,{model,input:[{type:'compaction',encrypted_content:second}]});expect(JSON.stringify(again)).toContain('MIDDLE=456');expect(again.input).toHaveLength(4);}
 // An oversized chat still compacts: first and newest requests stay exact, the trimmed middle is counted.
 const big=JSON.parse(portableSummary('summary',Array.from({length:100},(_,i)=>({role:'user',content:`REQ${i} `+'x'.repeat(2000)}))));
 expect(big.anchors[0].startsWith('REQ0 ')).toBe(true);expect(big.anchors.at(-1).startsWith('REQ99 ')).toBe(true);
 expect(big.summary).toMatch(/\d+ older verbatim user requests exceeded capsule capacity/);
 expect(Buffer.byteLength(JSON.stringify({anchors:big.anchors,tool_history:big.tool_history}))).toBeLessThanOrEqual(96000);
 expect(JSON.parse(portableSummary('s',[{role:'user',content:'same'},{role:'user',content:'same'}])).anchors).toEqual(['same']);
});
test('Grok function arguments: raw control characters are repaired losslessly, garbage still fails closed',async()=>{
 const {functionArguments,GrokError}=await import('../src/backends/grok');
 const raw='{"cmd":"git -C /repo log\n--stat\tx"}';
 const fixed=functionArguments(raw);expect(JSON.parse(fixed)).toEqual({cmd:'git -C /repo log\n--stat\tx'});
 expect(functionArguments('{"cmd":"ls"}')).toBe('{"cmd":"ls"}');
 expect(JSON.parse(functionArguments(JSON.stringify(JSON.stringify({cmd:'ls'}))))).toEqual({cmd:'ls'});
 expect(JSON.parse(functionArguments('{"cmd":"echo \\"a\nb\\""}')).cmd).toBe('echo "a\nb"');
 for(const bad of ['{"cmd":"ls"','not json','[1]','5']){let error:any;try{functionArguments(bad);}catch(e){error=e;}expect(error).toBeInstanceOf(GrokError);expect(error.retryable).toBe(true);}
});
test('Grok function arguments: regex and shell backslashes survive as literal backslashes; valid escapes keep their meaning',async()=>{
 const {functionArguments,GrokError}=await import('../src/backends/grok');
 // The shape that failed live: a secrets grep whose regex escapes were never doubled.
 const command=String.raw`git -C /repo grep -nE 'api[_-]?key\s*=|\.env$|token\|secret' -- . | grep -v \$HOME | grep -E '\bpassword\b'`;
 const raw='{"cmd":"'+command+'","workdir":"/repo"}';
 expect(()=>JSON.parse(raw)).toThrow();
 expect(JSON.parse(functionArguments(raw))).toEqual({cmd:command,workdir:'/repo'});
 // \b and \f stay literal: in a command they are regex word boundaries, never backspace or form feed.
 expect(JSON.parse(functionArguments(String.raw`{"cmd":"rg '\bfoo\b' \f"}`)).cmd).toBe(String.raw`rg '\bfoo\b' \f`);
 // Already-valid escapes are untouched byte for byte.
 const valid=String.raw`{"cmd":"a\nb \"q\" A \\ \/ \t"}`;
 expect(functionArguments(valid)).toBe(valid);expect(JSON.parse(functionArguments(valid)).cmd).toBe('a\nb "q" A \\ / \t');
 // A double-encoded object whose inner JSON carries the same invalid escapes.
 expect(JSON.parse(functionArguments(JSON.stringify(String.raw`{"cmd":"grep a\.b"}`)))).toEqual({cmd:String.raw`grep a\.b`});
 // Repair never touches structure: anything broken outside string literals still fails closed and retryable.
 for(const bad of [String.raw`{"cmd":"a\.b"`,String.raw`{"cmd":"a\.b",}`,String.raw`{cmd:"a\.b"}`,String.raw`{"cmd":"a\"}`,String.raw`["a\.b"]`]){let error:any;try{functionArguments(bad);}catch(e){error=e;}expect(error).toBeInstanceOf(GrokError);expect(error.retryable).toBe(true);}
});
test('Grok repeat guard refuses a third identical call with an identical result; recap puts the latest result last',async()=>{
 const {assertNotLooping,latestStepRecap,GrokError}=await import('../src/backends/grok');
 const args='{"cmd":"rg -n sleep README.md"}';
 const step=(id:string,output:string)=>[{type:'function_call',name:'exec_command',call_id:id,arguments:args},{type:'function_call_output',call_id:id,output}];
 const same=(id:string,wall:string)=>step(id,`Chunk ID: ${id}\nWall time: ${wall}\nOutput:\n50: sleep notes`);
 const looping={model:'grok-4.7',input:[{role:'user',content:'go'},...same('a','0.1'),...same('b','0.0')]} as any;
 let error:any;try{assertNotLooping(looping,[{name:'exec_command',arguments:args}]);}catch(e){error=e;}
 expect(error).toBeInstanceOf(GrokError);expect(error.retryable).toBe(true);expect(error.message).toContain('call_id b');
 // A different next step, a changed result, a single prior run, or a polling tool all pass.
 assertNotLooping(looping,[{name:'exec_command',arguments:'{"cmd":"cat sleep.md"}'}]);
 assertNotLooping({...looping,input:[...same('a','0.1'),...step('b','Output:\n51: changed')]},[{name:'exec_command',arguments:args}]);
 assertNotLooping({...looping,input:same('a','0.1')},[{name:'exec_command',arguments:args}]);
 const poll='{"session_id":1,"chars":""}';
 assertNotLooping({model:'grok-4.7',input:[{type:'function_call',name:'write_stdin',call_id:'p',arguments:poll},{type:'function_call_output',call_id:'p',output:'x'},{type:'function_call',name:'write_stdin',call_id:'q',arguments:poll},{type:'function_call_output',call_id:'q',output:'x'}]} as any,[{name:'write_stdin',arguments:poll}]);
 // The recap appears only when the conversation ends on a tool result, and it carries that result.
 const recap=latestStepRecap(looping);expect(recap).toContain('<latest_step>');expect(recap).toContain('call_id b');expect(recap).toContain('50: sleep notes');
 expect(latestStepRecap({...looping,input:[...looping.input,{role:'user',content:'new question'}]})).toBe('');
 expect(latestStepRecap({model:'grok-4.7',input:'hi'} as any)).toBe('');
});
test('Grok function arguments may be a real object; custom tools still need a raw string; schema allows both',async()=>{
 const {parseGrokOutput,grokOutputSchema,GrokError}=await import('../src/backends/grok');
 const tools=[{type:'function',name:'exec_command',parameters:{type:'object'}},{type:'custom',name:'apply_patch'}] as any;
 const req={model:'grok-4.7',input:'go',tools} as any;
 const cmd=String.raw`rg -n "a\.b" --glob '!x'`;
 const out=parseGrokOutput(JSON.stringify({text:'',tool_calls:[{name:'exec_command',arguments:{cmd}}]}),req);
 expect(JSON.parse(out.toolCalls[0]!.arguments)).toEqual({cmd});
 for(const bad of [{name:'apply_patch',arguments:{patch:'x'}},{name:'exec_command',arguments:['x']}]){let error:any;try{parseGrokOutput(JSON.stringify({text:'',tool_calls:[bad]}),req);}catch(e){error=e;}expect(error).toBeInstanceOf(GrokError);expect(error.retryable).toBe(true);}
 const schema:any=grokOutputSchema(tools);
 expect(schema.properties.tool_calls.items.properties.arguments).toEqual({anyOf:[{type:'object'},{type:'string'}]});
});
test('Grok calls missing a required field are refused; harmless extra fields are dropped',async()=>{
 const {parseGrokOutput,GrokError}=await import('../src/backends/grok');
 const parameters={type:'object',properties:{cmd:{type:'string'},workdir:{type:'string'}},required:['cmd'],additionalProperties:false};
 const req={model:'grok-4.7',input:'go',tools:[{type:'function',name:'exec_command',parameters},{type:'function',name:'open',parameters:{type:'object',properties:{path:{type:'string'}}}}]} as any;
 const call=(name:string,args:any)=>parseGrokOutput(JSON.stringify({text:'',tool_calls:[{name,arguments:args}]}),req);
 expect(JSON.parse(call('exec_command',{cmd:'ls',workdir:'/tmp'}).toolCalls[0]!.arguments)).toEqual({cmd:'ls',workdir:'/tmp'});
 expect(call('open',{path:'a',extra:1}).toolCalls).toHaveLength(1);
 expect(JSON.parse(call('exec_command',{cmd:'ls',description:'list'}).toolCalls[0]!.arguments)).toEqual({cmd:'ls'});
 expect(JSON.parse(call('exec_command',{cmd:'ls',command:'ls'}).toolCalls[0]!.arguments)).toEqual({cmd:'ls'});
 for(const args of [{command:'ls'},'{"command":"ls"}']){
  let error:any;try{call('exec_command',args);}catch(e){error=e;}
  expect(error).toBeInstanceOf(GrokError);expect(error.retryable).toBe(true);expect(error.message).toContain('exec_command');expect(error.message).toContain('cmd');
 }
});
test('helper message extraction accepts reports and fenced JSON, rejects real refusals only',async()=>{
 const {extractAgentMessage}=await import('../src/router/bridge');
 const report='FINAL_ANSWER: done. There was no task left for the cleanup branch; missing instructions in README were fixed. '+'detail '.repeat(80);
 expect(extractAgentMessage(JSON.stringify({message:report}))).toBe(report);
 expect(extractAgentMessage('```json\n'+JSON.stringify({message:'Review PR #835'})+'\n```')).toBe('Review PR #835');
 expect(extractAgentMessage(JSON.stringify({message:"I can't recover the encrypted message."}))).toEqual({reason:'refusal'});
 expect(extractAgentMessage('{"unavailable":true}')).toEqual({reason:'unavailable'});
 expect(extractAgentMessage('plain prose')).toEqual({reason:'not-json'});
 expect(extractAgentMessage(JSON.stringify({message:'x',extra:1}))).toEqual({reason:'wrong-shape'});
});
