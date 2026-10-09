// Optional Cursor transport through the vendor's pinned SDK bridge. The proxy has no runtime
// package dependency: it speaks sdk.v1 Connect JSON to a short-lived loopback child process.
// Every request starts with tools: [], no setting sources, no MCP and no subagents. Cursor never
// owns execution; validated tool requests return to Codex only after the complete run succeeds.
import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { positiveInt } from '../env';
import { isRecord, randomId, sha256, type JsonRecord } from '../json';
import { preparePrompt, requestToPrompt, toolDescriptors } from '../protocol/prompt';
import type { ProxyOutput, ResponsesRequest } from '../protocol/types';
import { BackendError, estimateVisibleTokens, retryOnce, type SubscriptionBackend } from './contract';

export const CURSOR_MODELS = {
  'kimi-k3': { name: 'Kimi K3', efforts: ['low', 'high', 'max'], parameter: 'reasoning', context: '' },
  'grok-4.7': { name: 'Grok 4.7', efforts: ['low', 'medium', 'high', 'xhigh'], parameter: 'reasoning_effort', context: '256k' },
  'claude-opus-5-5': { name: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], parameter: 'effort', context: '300k' },
} as const;
export type CursorModel = keyof typeof CURSOR_MODELS;
export type CursorOptions = {
  binary: string; binaryHash: string; authFile: string; cwd: string;
  expectedEmail: string; expectedUserId: string; prefix: string; label: string; fastest?: boolean;
};
export class CursorError extends BackendError {
  constructor(message: string, retryable = false) { super(message, { retryable }); this.name = 'CursorError'; }
}

const MAX_BYTES = 32 * 1024 * 1024;
const FINISHED = 'RUN_LIFECYCLE_STATUS_FINISHED';
const PRIVATE_ENV = /^(CURSOR_|AGENT_|OPENAI_|ANTHROPIC_|CLAUDE_CODE_|XAI_|GROK_|PROXY_|NODE_OPTIONS$|BUN_OPTIONS$)/;
export function cursorEnvironment(apiKey: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !PRIVATE_ENV.test(key)) env[key] = value;
  return { ...env, CURSOR_API_KEY: apiKey, CURSOR_SDK_CLIENT_LANGUAGE: 'typescript' };
}

export function cursorSelection(model: string, effort = 'high', fastest = false): JsonRecord {
  if (!Object.hasOwn(CURSOR_MODELS, model)) throw new CursorError('Unsupported Cursor model');
  const spec = CURSOR_MODELS[model as CursorModel];
  if (!(spec.efforts as readonly string[]).includes(effort)) throw new CursorError('Unsupported Cursor reasoning effort');
  return { id: model, params: [{ id: spec.parameter, value: effort }, ...(spec.context ? [{ id: 'context', value: spec.context }] : []), ...(model === 'kimi-k3' ? [] : [{ id: 'fast', value: fastest ? 'true' : 'false' }])] };
}

/** Validate common tool argument schemas, including nested objects, enums and union alternatives. */
function matchesSchema(value: unknown, schema: unknown, depth = 0): boolean {
  if (!isRecord(schema)) return true;
  if (depth > 64) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false;
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(s => matchesSchema(value, s, depth + 1))) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(s => matchesSchema(value, s, depth + 1)).length !== 1) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every(s => matchesSchema(value, s, depth + 1))) return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const hasType = (type: unknown) => type === 'null' ? value === null : type === 'object' ? isRecord(value) : type === 'array' ? Array.isArray(value) : type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (types.length && !types.some(hasType)) return false;
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) { if (!matchesSchema(item, properties[key], depth + 1)) return false; }
      else if (schema.additionalProperties === false || (isRecord(schema.additionalProperties) && !matchesSchema(item, schema.additionalProperties, depth + 1))) return false;
    }
  }
  if (Array.isArray(value) && schema.items && !value.every(item => matchesSchema(item, schema.items, depth + 1))) return false;
  return true;
}

export function parseCursorOutput(text: string, request: ResponsesRequest): ProxyOutput {
  const refuse = (): never => { throw new CursorError('Cursor returned invalid structured output or tool arguments; no Codex actions were executed', true); };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return refuse(); }
  if (!isRecord(value) || typeof value.text !== 'string' || !Array.isArray(value.tool_calls) || value.tool_calls.length > 64 || Object.keys(value).some(key => !['text', 'tool_calls'].includes(key))) return refuse();
  const allowed = new Map(toolDescriptors(request.tools ?? []).map(tool => [tool.proxyName, tool]));
  const toolCalls = value.tool_calls.map((call: unknown) => {
    if (!isRecord(call) || typeof call.name !== 'string' || Object.keys(call).some(key => !['name', 'arguments'].includes(key))) return refuse();
    const descriptor = allowed.get(call.name);
    if (!descriptor) return refuse();
    if (descriptor.type === 'custom') {
      if (typeof call.arguments !== 'string') return refuse();
      return { name: descriptor.proxyName, arguments: call.arguments, callId: randomId('call') };
    }
    let args: unknown = call.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return refuse(); } }
    if (!isRecord(args) || !matchesSchema(args, descriptor.contract)) return refuse();
    return { name: descriptor.proxyName, arguments: JSON.stringify(args), callId: randomId('call') };
  });
  const inputTokens = estimateVisibleTokens(requestToPrompt(request));
  const outputTokens = estimateVisibleTokens(text);
  return { text: value.text, toolCalls, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
}

function assertTextInput(value: unknown): void {
  if (Array.isArray(value)) value.forEach(assertTextInput);
  else if (isRecord(value)) {
    if (['input_image', 'image', 'input_audio', 'audio', 'input_file', 'file', 'compaction', 'compaction_summary', 'context_compaction', 'encrypted_content'].includes(String(value.type)) || value.file_id || value.encrypted_content) throw new CursorError('Cursor bridge requires restored text history; this attachment or encrypted history is unsupported');
    Object.values(value).forEach(assertTextInput);
  }
}

const OUTPUT_RULES = `You are inside the Codex external tool loop. Return ONLY one JSON object with exactly text (string) and tool_calls (array). Each call has exactly name and arguments. Use the exact Codex tool names below. Function arguments are JSON objects; custom tool arguments are raw strings. All actions are executed externally by Codex AFTER your reply: you have no native tools. Never claim an action succeeded until its tool result appears in history. Do not wrap JSON in Markdown or add text outside it.`;

export function readCursorKey(options: CursorOptions): string {
  const info = statSync(options.authFile);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new CursorError('Cursor SDK credential file must be owner-only');
  let value:unknown;
  try {value=JSON.parse(readFileSync(options.authFile,'utf8'));} catch {throw new CursorError('Cursor SDK credential file is unreadable or invalid');}
  if (!isRecord(value) || typeof value.apiKey !== 'string' || !value.apiKey || value.email !== options.expectedEmail || value.backendUrl !== 'https://api2.cursor.sh' || (typeof value.apiKeyExpiresAtMs === 'number' && value.apiKeyExpiresAtMs <= Date.now())) throw new CursorError('Cursor SDK login is missing, expired or belongs to another account');
  return value.apiKey;
}

/** Decode Connect server frames incrementally; partial frames and keepalives are valid. */
export async function* connectFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<JsonRecord> {
  let pending = new Uint8Array(0), total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new CursorError('Cursor output exceeded safety limit');
    const joined = new Uint8Array(pending.length + chunk.length); joined.set(pending); joined.set(chunk, pending.length); pending = joined;
    while (pending.length >= 5) {
      const flags = pending[0]!; const length = new DataView(pending.buffer, pending.byteOffset + 1, 4).getUint32(0);
      if (length > MAX_BYTES || (flags !== 0 && flags !== 2)) throw new CursorError('Cursor returned an invalid Connect frame');
      if (pending.length < 5 + length) break;
      let value: unknown;
      try { value = JSON.parse(new TextDecoder().decode(pending.subarray(5, 5 + length))); } catch { throw new CursorError('Cursor returned invalid stream JSON'); }
      pending = pending.slice(5 + length);
      if (!isRecord(value)) throw new CursorError('Cursor returned an invalid stream record');
      if (flags === 2) {
        if (value.error) throw new CursorError('Cursor stream failed; no automatic supplier fallback');
      } else yield value;
    }
  }
  if (pending.length) throw new CursorError('Cursor stream ended with a partial frame');
}

export function assertCursorIdentity(value: unknown, options: Pick<CursorOptions, 'expectedEmail' | 'expectedUserId'>): void {
  const user = isRecord(value) && isRecord(value.user) ? value.user : undefined;
  if (!user || user.userEmail !== options.expectedEmail || String(user.userId) !== options.expectedUserId) throw new CursorError('Cursor authenticated account differs from the pinned identity');
}

// Account/catalog lookups have a much lower rate limit than agent inference. Validate once per
// credential and pins, share concurrent lookups, and refresh after five minutes. A rotated key or
// changed identity pin never reuses another account's proof. Server access policy remains decisive.
type CursorRpc = (service:string, method:string, body:JsonRecord) => Promise<Response>;
const profileCache = new Map<string, { expires:number; value:Promise<JsonRecord> }>();
export async function verifyCursorProfile(options:Pick<CursorOptions,'expectedEmail'|'expectedUserId'|'binaryHash'>, key:string, rpc:CursorRpc):Promise<JsonRecord> {
  const cacheKey = sha256(Buffer.from(key))+'|'+options.expectedEmail+'|'+options.expectedUserId+'|'+options.binaryHash;
  const previous = profileCache.get(cacheKey);
  if (previous && previous.expires > Date.now()) return previous.value;
  const value = (async () => {
    assertCursorIdentity(await (await rpc('SdkCursorService','Me',{options:{apiKey:key}})).json(),options);
    const models:unknown = await (await rpc('SdkCursorService','ListModels',{options:{apiKey:key}})).json();
    if (!isRecord(models) || !Array.isArray(models.items)) throw new CursorError('Cursor returned an invalid model catalog');
    return models;
  })();
  const entry = {expires:Date.now()+300_000,value};
  if (profileCache.size >= 32) profileCache.delete(profileCache.keys().next().value!);
  profileCache.set(cacheKey,entry);
  try { return await value; } catch(error) { if(profileCache.get(cacheKey)===entry) profileCache.delete(cacheKey); throw error; }
}

export function interpretCursorEvents(events: JsonRecord[], request: ResponsesRequest, selection: JsonRecord): ProxyOutput {
  // Treat native tools/subagent/compaction as hard failures even with tools: [] configured.
  for (const event of events) {
    const sdk = isRecord(event.sdkMessage) ? event.sdkMessage : undefined;
    const step = isRecord(event.step) ? event.step : undefined;
    const containsNative = (v:unknown):boolean => Array.isArray(v) ? v.some(containsNative) : isRecord(v) ? v.type === 'tool_use' || Object.values(v).some(containsNative) : false;
    if (sdk && containsNative(sdk.message)) throw new CursorError('Cursor attempted a native tool; no Codex actions were returned');
    if ((sdk && /^(tool_call|task|compaction|summary)/.test(String(sdk.type))) || (step && /tool|shell|task|summary|compact/i.test(String(step.type)))) throw new CursorError('Cursor attempted native actions or compaction; no Codex actions were returned');
  }
  const terminal = events.filter(event => isRecord(event.result));
  const result = terminal.length === 1 && isRecord(terminal[0]?.result) ? terminal[0].result : undefined;
  const run = result && isRecord(result.result) ? result.result : undefined;
  const done = events.at(-1)?.done;
  if (!result || result.status !== FINISHED || !run || run.status !== FINISHED || !isRecord(done) || done.runId !== result.runId || typeof run.result !== 'string') throw new CursorError('Cursor did not finish successfully; no automatic supplier fallback');
  const sameModel = isRecord(run.model) && run.model.id === selection.id && Array.isArray(run.model.params) && Array.isArray(selection.params) && JSON.stringify([...run.model.params].sort((a,b) => String(isRecord(a) ? a.id : '').localeCompare(String(isRecord(b) ? b.id : '')))) === JSON.stringify([...selection.params].sort((a,b) => String(isRecord(a) ? a.id : '').localeCompare(String(isRecord(b) ? b.id : ''))));
  if (!sameModel) throw new CursorError('Cursor reported a different model or reasoning setting; request refused');
  const output = parseCursorOutput(run.result, request);
  if (isRecord(run.usage)) {
    const input = Number(run.usage.inputTokens ?? 0) + Number(run.usage.cacheReadTokens ?? 0) + Number(run.usage.cacheWriteTokens ?? 0), out = Number(run.usage.outputTokens ?? 0);
    if ([input,out].every(n => Number.isSafeInteger(n) && n >= 0)) output.usage = { inputTokens: input, outputTokens: out, totalTokens: input + out };
  }
  return output;
}

async function runCursorOnce(options: CursorOptions, request: ResponsesRequest, signal?: AbortSignal, retryNote = ''): Promise<ProxyOutput> {
  signal?.throwIfAborted(); assertTextInput(request.input);
  const selection = cursorSelection(request.model, request.reasoning?.effort, options.fastest);
  const prepared = preparePrompt(request);
  if (prepared.images.length) throw new CursorError('Cursor bridge supports text only');
  if (sha256(readFileSync(options.binary)) !== options.binaryHash) throw new CursorError('Cursor pinned bridge changed; backend paused');
  const key = readCursorKey(options);
  const dir = await mkdtemp(join(options.cwd, 'request-')); await chmod(dir, 0o700);
  const controller = new AbortController();
  let proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | undefined;
  let startup: ReturnType<typeof setTimeout> | undefined;
  let runId = '', agentId = '', url = '', token = '';
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (url && token && runId) {
      cancellation = fetch(`${url}/sdk.v1.SdkAgentService/CancelRun`, { method:'POST', signal:AbortSignal.timeout(2000), headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({agentId,runId}) }).then(() => {}, () => {}).finally(() => {proc?.kill();});
    } else proc?.kill();
  };
  const timeout = setTimeout(cancel, positiveInt('CURSOR_TIMEOUT_MS', 900_000));
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    proc = Bun.spawn([options.binary, '--host', '127.0.0.1', '--port', '0', '--workspace', dir, '--state-root', join(dir, 'store'), '--local-store', JSON.stringify({ type: 'jsonl', rootDir: join(dir, 'store') })], { cwd: dir, env: cursorEnvironment(key), stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    const child = proc;
    const ready = new Promise<JsonRecord>((resolve, reject) => {
      startup = setTimeout(() => { cancel(); reject(new CursorError('Cursor bridge startup timed out')); }, 30_000);
      void (async () => {
        let line = '', bytes = 0, found = false;
        try {
          for await (const chunk of child.stderr) {
            bytes += chunk.length;
            if (bytes > MAX_BYTES) { cancel(); throw new CursorError('Cursor diagnostics exceeded safety limit'); }
            line += new TextDecoder().decode(chunk);
            let boundary: number;
            while ((boundary = line.indexOf('\n')) >= 0) {
              const current = line.slice(0, boundary); line = line.slice(boundary + 1);
              if (!found && current.startsWith('cursor-sdk-bridge ready ')) {
                const value: unknown = JSON.parse(current.slice(24));
                if (!isRecord(value)) throw new CursorError('Cursor bridge handshake failed');
                found = true; clearTimeout(startup); resolve(value);
              }
            }
            if (line.length > 65536) throw new CursorError('Cursor diagnostic line exceeded safety limit');
          }
          if (!found) reject(new CursorError('Cursor bridge exited before ready'));
        } catch { cancel(); reject(new CursorError('Cursor bridge startup or diagnostics failed')); }
      })();
    });
    const info = await ready;
    if (info.schemaVersion !== 1 || info.host !== '127.0.0.1' || info.protocol !== 'connect' || info.transport !== 'tcp' || typeof info.port !== 'number' || typeof info.authTokenFile !== 'string' || typeof info.url !== 'string' || info.url !== `http://127.0.0.1:${info.port}`) throw new CursorError('Cursor returned an invalid local handshake');
    url = info.url; token = readFileSync(info.authTokenFile, 'utf8').trim();
    async function rpc(service: string, method: string, body: JsonRecord, stream = false, rpcSignal: AbortSignal = controller.signal): Promise<Response> {
      const json = Buffer.from(JSON.stringify(body));
      const header = Buffer.alloc(5); header.writeUInt32BE(json.length, 1);
      const response = await fetch(`${url}/sdk.v1.${service}/${method}`, { method: 'POST', signal: rpcSignal, headers: { authorization: `Bearer ${token}`, 'content-type': stream ? 'application/connect+json' : 'application/json', 'connect-protocol-version': '1' }, body: stream ? Buffer.concat([header, json]) : json });
      if (!response.ok) {
        const detail:unknown = await response.json().catch(() => undefined);
        const code = isRecord(detail) && typeof detail.code === 'string' ? detail.code.replace(/[^a-z_]/g,'').slice(0,64) : 'unknown';
        throw new CursorError(`Cursor SDK request refused (HTTP ${response.status}, ${code}); no automatic supplier fallback`);
      }
      return response;
    }
    const models = await verifyCursorProfile(options, key, rpc);
    const discovered = isRecord(models) && Array.isArray(models.items) ? models.items.find(item => isRecord(item) && item.id === request.model) : undefined;
    if (!isRecord(discovered) || !Array.isArray(discovered.parameters)) throw new CursorError('Requested model is unavailable on the pinned Cursor account');
    const definitions = discovered.parameters;
    const params = selection.params as Array<{ id: string; value: string }>;
    if (params.some(param => !definitions.some(def => isRecord(def) && def.id === param.id && Array.isArray(def.values) && def.values.some(v => isRecord(v) && v.value === param.value)))) throw new CursorError('Requested Cursor parameters are unavailable');
    const created: unknown = await (await rpc('SdkAgentService', 'CreateAgent', { options: { apiKey: key, model: selection, tools: { names: [] }, disallowedTools: ['task', 'mcp'], local: { cwd: [dir], settingSources: [] } } })).json();
    if (!isRecord(created) || typeof created.agentId !== 'string') throw new CursorError('Cursor agent creation failed');
    agentId = created.agentId;
    const response = await rpc('SdkAgentService', 'Send', { agentId, message: { text: `${OUTPUT_RULES}${retryNote}\n\n${prepared.prompt}\n\n${OUTPUT_RULES}` }, options: { enableSteps: true } }, true);
    if (!response.body) throw new CursorError('Cursor returned an empty stream');
    const events: JsonRecord[] = [];
    for await (const event of connectFrames(response.body)) {
      events.push(event);
      const sdk = isRecord(event.sdkMessage) && isRecord(event.sdkMessage.message) ? event.sdkMessage.message : undefined;
      if (sdk && typeof (sdk.runId ?? sdk.run_id) === 'string') runId = String(sdk.runId ?? sdk.run_id);
      if (isRecord(event.result) && typeof event.result.runId === 'string') runId = event.result.runId;
    }
    signal?.throwIfAborted(); controller.signal.throwIfAborted();
    return interpretCursorEvents(events, request, selection);
  } finally {
    clearTimeout(timeout); clearTimeout(startup); signal?.removeEventListener('abort', cancel);
    if (cancellation) await cancellation;
    if (proc && url && token && !controller.signal.aborted) {
      try { await fetch(`${url}/sdk.v1.SdkAgentService/CloseAgent`, { method: 'POST', signal: AbortSignal.timeout(2000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agentId }) }); } catch {}
    }
    // Killing this dedicated local bridge ends in-flight runs even if Send disconnected. No shared
    // bridge is reused, so cancellation can never stop another account/thread's run.
    proc?.kill(); if (proc) await proc.exited;
    await rm(dir, { recursive: true, force: true });
  }
}

export function createCursorBackend(options: CursorOptions): SubscriptionBackend {
  if (![options.binary, options.authFile, options.cwd].every(isAbsolute) || !/^[a-z][a-z0-9-]*$/.test(options.prefix) || ['gpt','grok','claude'].includes(options.prefix) || !options.expectedEmail || !options.expectedUserId || !/^[a-f0-9]{64}$/.test(options.binaryHash)) throw new Error('Cursor requires absolute paths, a pinned bridge, account identity and a model namespace');
  const exposed: CursorModel[] = ['kimi-k3', 'grok-4.7'];
  return {
    name: `Cursor (${options.label})`, reservedPrefix: `${options.prefix}-`,
    models: Object.fromEntries(exposed.map(model => [`${options.prefix}-${model}`, model])),
    catalog: exposed.map(model => ({ slug: `${options.prefix}-${model}`, displayName: `${CURSOR_MODELS[model].name} (${options.label})`, description: `Your subscription through Cursor; Codex executes tools.`, efforts: CURSOR_MODELS[model].efforts, defaultEffort: 'high', inputModalities: ['text'] })),
    run: (request, signal) => retryOnce('Cursor', signal, note => runCursorOnce(options, request, signal, note)),
  };
}
export function configuredCursorBackend(env: Readonly<Record<string, string | undefined>> = process.env): SubscriptionBackend | undefined {
  if (!env.CURSOR_BRIDGE_BIN) return undefined;
  return createCursorBackend({ binary: env.CURSOR_BRIDGE_BIN, binaryHash: env.CURSOR_BRIDGE_SHA256 ?? '', authFile: env.CURSOR_AUTH_FILE ?? '', cwd: env.CURSOR_CWD ?? '', expectedEmail: env.CURSOR_EXPECTED_EMAIL ?? '', expectedUserId: env.CURSOR_EXPECTED_USER_ID ?? '', prefix: env.CURSOR_MODEL_PREFIX || 'cursor', label: env.CURSOR_LABEL || 'Cursor', fastest: env.CURSOR_SPEED_POLICY === 'fastest' });
}
