// Optional Cursor transport through the vendor's pinned SDK bridge. The proxy has no runtime
// package dependency: it speaks sdk.v1 Connect JSON to an exclusively leased loopback process.
// Every request starts with tools: [], no setting sources, no MCP and no subagents. Cursor never
// owns execution; validated tool requests return to Codex only after the complete run succeeds.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { childEnvironment, positiveInt } from '../env';
import { isRecord, randomId, sha256, type JsonRecord } from '../json';
import { imageUrl, isImagePart, preparePrompt, requestToPrompt, requestTools, toolDescriptors } from '../protocol/prompt';
import type { ProxyOutput, ResponsesRequest } from '../protocol/types';
import { BackendError, CONTEXT_OVERFLOW_TEXT, contextOverflowError, estimateVisibleTokens, retryOnce, type SubscriptionBackend } from './contract';
import { repairJsonStrings } from './grok';
import { logSafe } from '../log';
import { ProxyTransportError, transportError } from '../transport';
import { CursorBridgePool, type CursorLease } from './cursor-pool';
import { responseObject } from '../protocol/output';

export const CURSOR_MODELS = {
  // `context` is the Cursor model parameter requested (the largest each model offers); `window` is what
  // the catalog advertises to Codex so compaction happens at the real limit, not an artificial 200K.
  // Kimi exposes no context parameter and its limit is unverified, so it keeps the 200K default.
  // Kimi K3 is not a vision model on Cursor: a probed image arrives as an on-disk asset path only (2026-10-13).
  'kimi-k3': { name: 'Kimi K3', efforts: ['low', 'high', 'max'], parameter: 'reasoning', context: '', window: 200_000, vision: false, fast: false },
  // Grok 4.7: Cursor discovery lists a 500k context, but a run requested at 500k never reaches
  // RUN_LIFECYCLE_STATUS_FINISHED (probed 2026-10-13, text-only prompt); 256k is the largest that works.
  'grok-4.7': { name: 'Grok 4.7', efforts: ['low', 'medium', 'high', 'xhigh'], parameter: 'reasoning_effort', context: '256k', window: 256_000 , vision: true, fast: true },
  'claude-opus-5-5': { name: 'Opus 5.5 via Cursor', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], parameter: 'effort', context: '1m', window: 1_000_000 , vision: true, fast: true },
  // Cursor advertises 1m, but currently rejects that selection as invalid parameters; 300k is verified.
  'muse-wonder-1.0': { name: 'Muse Wonder', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], parameter: 'reasoning_effort', context: '300k', window: 300_000, vision: true, fast: false },
} as const;
export type CursorModel = keyof typeof CURSOR_MODELS;
export type CursorOptions = {
  binary: string; binaryHash: string; authFile: string; cwd: string;
  expectedEmail: string; expectedUserId: string; prefix: string; label: string; fastest?: boolean;
};
export class CursorError extends BackendError {
  constructor(message: string, retryable = false, modelOutput = false, retries = 1) { super(message, { retryable, modelOutput, retries }); this.name = 'CursorError'; }
}

/** Bare narration with no JSON object. The agent that wrote it can be asked to wrap it in place. */
export class CursorProseError extends CursorError {
  constructor(message: string) { super(message, true, true, 2); this.name = 'CursorProseError'; }
}

const MAX_BYTES = 32 * 1024 * 1024;
const FINISHED = 'RUN_LIFECYCLE_STATUS_FINISHED';
// Provider-side failures that native Codex would retry with backoff (429/5xx/overload). Matched
// against the short reason Cursor attaches to an errored run, never against model output.
const TRANSIENT_RUN_ERROR = /rate.?limit|too many requests|\b429\b|\b50[234]\b|overload|capacity|temporar|unavailable|internal error|try again|timed? ?out|upstream|gateway/i;

/** Cursor's own reason for an unfinished run: a short provider string, or undefined when absent. */
function cursorRunReason(result: JsonRecord | undefined, run: JsonRecord | undefined, done: unknown): string | undefined {
  const candidates: unknown[] = [run?.error, run?.errorMessage, run?.message, result?.error, result?.errorMessage, isRecord(done) ? done.error : undefined];
  if (run && run.status !== FINISHED && typeof run.result === 'string') candidates.push(run.result);
  for (const value of candidates) {
    const text = typeof value === 'string' ? value : isRecord(value) && typeof value.message === 'string' ? value.message : undefined;
    if (text && text.trim()) return text.replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  return undefined;
}
const PRIVATE_ENV = /^(CURSOR_|AGENT_|OPENAI_|ANTHROPIC_|CLAUDE_CODE_|XAI_|GROK_|PROXY_|NODE_OPTIONS$|BUN_OPTIONS$)/;
export function cursorEnvironment(apiKey: string): Record<string, string> {
  return { ...childEnvironment((key) => PRIVATE_ENV.test(key)), CURSOR_API_KEY: apiKey, CURSOR_SDK_CLIENT_LANGUAGE: 'typescript' };
}

export function cursorSelection(model: string, effort = 'high', fastest = false): JsonRecord {
  if (!Object.hasOwn(CURSOR_MODELS, model)) throw new CursorError('Unsupported Cursor model');
  const spec = CURSOR_MODELS[model as CursorModel];
  if (!(spec.efforts as readonly string[]).includes(effort)) throw new CursorError('Unsupported Cursor reasoning effort');
  return { id: model, params: [{ id: spec.parameter, value: effort }, ...(spec.context ? [{ id: 'context', value: spec.context }] : []), ...(spec.fast ? [{ id: 'fast', value: fastest ? 'true' : 'false' }] : [])] };
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

// Models wrap the JSON object in a Markdown fence or add prose around it; pull out the outermost
// object before parsing. Text inside the object is untouched, so a broken structure still fails.
function extractJsonObject(text: string): string {
  let s = text.trim();
  const fence = s.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1]!.trim();
  if (s.startsWith('{') && s.endsWith('}')) return s;
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}
// Code inside a JSON string (shell commands, JavaScript for cua_repl) often arrives with its inner
// double quotes unescaped. No local rule can tell `"a" }` inside code from a real string end, so this
// backtracks: each unescaped quote is tried as the terminator, nearest first, and the first choice
// under which the whole document parses wins. Valid JSON therefore parses exactly as JSON.parse would.
// Only used after strict and control-character repair fail; a work budget bounds pathological input.
export function parseJsonLenient(raw: string): unknown {
  let budget = 50_000;
  const spend = () => { if (--budget < 0) throw new Error('lenient JSON parse budget exhausted'); };
  const ws = (i: number) => { while (i < raw.length && /\s/.test(raw[i]!)) i++; return i; };
  function* str(i: number): Generator<[string, number]> {
    let j = i + 1, body = '';
    while (j < raw.length) {
      const c = raw[j]!;
      if (c === '\\') { body += c + (raw[j + 1] ?? ''); j += 2; continue; }
      if (c === '"') {
        spend();
        let parsed: string | undefined;
        try { parsed = JSON.parse(repairJsonStrings('"' + body + '"')); } catch { /* not a usable terminator */ }
        if (typeof parsed === 'string') yield [parsed, j + 1];
        body += '\\"'; j++; continue;
      }
      body += c; j++;
    }
  }
  function* members(i: number, acc: JsonRecord): Generator<[JsonRecord, number]> {
    i = ws(i); if (raw[i] !== '"') return;
    for (const [key, afterKey] of str(i)) {
      const colon = ws(afterKey); if (raw[colon] !== ':') continue;
      for (const [val, afterVal] of value(colon + 1)) {
        const next = { ...acc, [key]: val }, p = ws(afterVal);
        if (raw[p] === '}') yield [next, p + 1];
        else if (raw[p] === ',') yield* members(p + 1, next);
      }
    }
  }
  function* items(i: number, acc: unknown[]): Generator<[unknown[], number]> {
    for (const [val, afterVal] of value(i)) {
      const next = [...acc, val], p = ws(afterVal);
      if (raw[p] === ']') yield [next, p + 1];
      else if (raw[p] === ',') yield* items(p + 1, next);
    }
  }
  function* value(i: number): Generator<[unknown, number]> {
    spend();
    i = ws(i); const ch = raw[i];
    if (ch === '"') yield* str(i);
    else if (ch === '{') { const j = ws(i + 1); if (raw[j] === '}') yield [{}, j + 1]; else yield* members(j, {}); }
    else if (ch === '[') { const j = ws(i + 1); if (raw[j] === ']') yield [[], j + 1]; else yield* items(j, []); }
    else { const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(raw.slice(i, i + 64)); if (m) yield [JSON.parse(m[0]), i + m[0].length]; }
  }
  for (const [parsed, end] of value(0)) if (ws(end) === raw.length) return parsed;
  throw new Error('no lenient JSON parse');
}
function parseJsonLoosely(raw: string): unknown {
  return parseJsonLooselyImpl(raw);
}

/**
 * Custom tools take one raw string. Models (Kimi especially) often wrap it as {"code": "..."},
 * {"input": "..."} or {"patch": "..."}; Kimi's native call markup also emits {"call_id": "...",
 * "argument": "..."} (singular key plus an id). Unwrap a single-string-field object rather than
 * refusing the turn, ignoring id/index metadata keys. Returns undefined when no single string can
 * be recovered (for example only pragma numbers like yield_time_ms and no code at all).
 */
const CUSTOM_METADATA_KEYS = new Set(['call_id', 'callId', 'id', 'index', 'name', 'tool', 'type']);
export function coerceCustomArguments(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).filter(key => !CUSTOM_METADATA_KEYS.has(key));
  // Two payloads (or options beside source) cannot be collapsed without dropping model intent.
  // The same-agent repair can put exec options in their required first-line pragma instead.
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;
  if (typeof value[key] === 'string') return value[key] as string;
  return undefined;
}

function parseJsonLooselyImpl(raw: string): unknown {
  try { return JSON.parse(raw); } catch { /* fall through */ }
  try { return JSON.parse(repairJsonStrings(raw)); } catch { /* fall through */ }
  try {
    const value = parseJsonLenient(raw);
    logSafe('cursor-output-repaired', { category: 'lenient', bytes: raw.length });
    return value;
  } catch (error) {
    const balanced = balanceJsonBrackets(raw);
    if (balanced === raw) throw error;
    let value: unknown;
    try { value = JSON.parse(balanced); } catch {
      try { value = JSON.parse(repairJsonStrings(balanced)); } catch { value = parseJsonLenient(balanced); }
    }
    logSafe('cursor-output-repaired', { category: 'brackets', bytes: raw.length });
    return value;
  }
}

// Kimi K3 miscounts closers at the end of a tool call: `..."}}]}` (one extra brace before the
// array closes) or `..."}}]` (that extra brace plus a missing final one). Outside strings, drop any
// closer that does not match the innermost open bracket and append whatever is still open.
export function balanceJsonBrackets(raw: string): string {
  const stack: string[] = [];
  let out = '', inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (inString) {
      out += c;
      if (c === '\\') { out += raw[i + 1] ?? ''; i++; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') { if (stack[stack.length - 1] !== c) continue; stack.pop(); }
    out += c;
  }
  if (inString) return raw;
  return out + stack.reverse().join('');
}
const fieldName = (key: unknown) => typeof key === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(key) ? key : '(invalid name)';
// A promised external action is progress, not a final answer. Keep ordinary final prose and
// quoted examples available; only explicit first-person action narration triggers correction.
const ACTION_NARRATION = /^(?:(?:I(?:['’]ll| will|(?:['’]m| am) (?:going|about) to))\s+|Let me\s+)(?:read|check|inspect|look|search|run|execute|open|write|edit|update|save|create|delete|remove|install|fetch|test|verify|find|benchmark|load|browse|query|use|collect|gather|scan|pull|review|confirm|send|apply|call|invoke)\b/i;
const TEXT_ONLY_INTENT = /\b(?:draft|translate|translation|rephrase|rewrite|proofread|quote|verbatim|plan|outline|explain|example|sample|wording|poem|story)\b|\b(?:return|say|respond|reply)(?: with)? exactly\b|\b(?:write|compose) (?:an? |the )?(?:email|message|letter|sentence|speech)\b/i;
const ACTION_REQUEST = /^(?:(?:please|can (?:you|u)|could you|would you|help me|i (?:want|need) you to)\s+)*(?:(?:actually|quickly|extensively|carefully)\s+)?(?:read|check|inspect|look|search|run|execute|open|write|edit|update|save|create|delete|remove|install|fetch|test|verify|find|benchmark|load|browse|query|use|collect|gather|scan|pull|review|confirm|send|apply|call|invoke|continue|do it)\b(?=\s+\S)/i;
function latestUserText(request: ResponsesRequest): string {
  if (typeof request.input === 'string') return request.input.slice(-8192);
  for (let index = request.input.length - 1; index >= 0; index--) {
    const item = request.input[index];
    if (item?.role !== 'user') continue;
    return (typeof item.content === 'string' ? item.content : (item.content ?? []).map(part => typeof part?.text === 'string' ? part.text : '').join('\n')).slice(-8192);
  }
  return '';
}
function isUnfinishedNarration(text: string, latest: string): boolean {
  // Heuristics only raise a bounded repair on clear short action promises in an action request.
  // A requested quote, translation, draft or plan is useful text even when it says "I'll ...".
  return text.length <= 400 && !TEXT_ONLY_INTENT.test(latest) && ACTION_REQUEST.test(latest.trim()) && ACTION_NARRATION.test(text.trim().replace(/^[*#>\s]+/, ''));
}

// Kimi K3 under long tool-heavy contexts abandons the JSON contract and emits its native tool-call
// markup instead: <|open|>call tool="name" index="1"<|sep|><|open|>argument key="k" type="string"<|sep|>v
// <|close|>argument<|sep|>...<|close|>call<|sep|>. It has also imitated a Claude transcript tag it saw in
// replayed history: <assistant_tool_call name="x" call_id="...">{json}</assistant_tool_call>. Both are
// unambiguous, so they are converted to the {text, tool_calls} shape; the normal validation still runs.
// Leaked reasoning before <|close|>think<|sep|> is dropped. Returns undefined when neither form is present.
export function parseNativeToolMarkup(text: string): JsonRecord | undefined {
  let s = text;
  const thinkEnd = '<|close|>think<|sep|>', think = s.lastIndexOf(thinkEnd);
  if (think >= 0) s = s.slice(think + thinkEnd.length);
  const calls: JsonRecord[] = [];
  const coerce = (type: string | undefined, raw: string): unknown => {
    if (type === 'number') { const n = Number(raw.trim()); return Number.isFinite(n) ? n : raw; }
    if (type === 'boolean') return raw.trim() === 'true';
    if (type === 'object' || type === 'array') { try { return parseJsonLoosely(raw); } catch { return raw; } }
    return raw;
  };
  for (const call of s.matchAll(/<\|open\|>call tool="([^"]+)"[^<]*<\|sep\|>([\s\S]*?)<\|close\|>call<\|sep\|>/g)) {
    const args: JsonRecord = {};
    for (const arg of call[2]!.matchAll(/<\|open\|>argument key="([^"]+)"(?: type="([^"]*)")?<\|sep\|>([\s\S]*?)<\|close\|>argument<\|sep\|>/g)) args[arg[1]!] = coerce(arg[2], arg[3]!);
    calls.push({ name: call[1], arguments: args });
  }
  for (const call of s.matchAll(/<assistant_tool_call name="([^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/assistant_tool_call>/g)) {
    let args: unknown = call[2]; try { args = parseJsonLoosely(call[2]!); } catch { /* keep raw */ }
    calls.push({ name: call[1], arguments: args });
  }
  if (!calls.length) return undefined;
  const cut = ['<|open|>tools<|sep|>', '<|open|>call ', '<assistant_tool_call', '</assistant>'].map(m => s.indexOf(m)).filter(i => i >= 0);
  const textPart = (cut.length ? s.slice(0, Math.min(...cut)) : s).trim();
  return { text: textPart, tool_calls: calls };
}

// Refused raw output is kept privately (owner-only file in the runtime state) so the exact mistake can
// be read afterwards instead of guessed from a category. The log never carries the body itself.
function captureInvalidOutput(dir: string | undefined, category: string, text: string): string | undefined {
  if (!dir) return undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${category}.txt`);
    writeFileSync(file, text, { mode: 0o600 });
    return file;
  } catch { return undefined; }
}

// Every refusal names the exact mistake so the one retry can fix it, and logs a category so the
// failure is diagnosable afterwards. Nothing has executed when this throws, so retrying is safe.
export function parseCursorOutput(text: string, request: ResponsesRequest, captureDir?: string, acceptProse = false): ProxyOutput {
  const refuse = (reason: string, category: string, fields: Record<string, unknown> = {}, retries = 1): never => {
    const captured = captureInvalidOutput(captureDir, category, text);
    logSafe('cursor-invalid-output', { category, bytes: text.length, captured: !!captured, ...fields });
    const message = `Cursor ${reason}; no Codex actions were executed`;
    throw category === 'prose' ? new CursorProseError(message) : new CursorError(message, true, true, retries);
  };
  const descriptors = toolDescriptors(requestTools(request));
  const latest = latestUserText(request);
  const allowed = new Map(descriptors.map(tool => [tool.proxyName, tool]));
  let candidate = text.trim();
  let value: unknown = parseNativeToolMarkup(text);
  if (value) logSafe('cursor-output-native-markup', { bytes: text.length, calls: (value as JsonRecord).tool_calls instanceof Array ? ((value as JsonRecord).tool_calls as unknown[]).length : 0 });
  else if (!/[{}]/.test(text)) {
    // Grok 4.7 narrates mid-task ("I'll read those sections next.") and forgets the envelope entirely.
    // The first time, refuse with the exact wrap so the retry can continue the work; if the retry is
    // still bare prose, deliver it as a text-only message rather than a failed turn. No tool runs.
    // With no available actions, wrapping prose cannot recover missing work; another generation
    // only adds latency. Terminal success/model/native-action validation still runs before this.
    if (descriptors.length > 0 && ((!acceptProse && !TEXT_ONLY_INTENT.test(latest)) || isUnfinishedNarration(text, latest))) {
      const quoted = JSON.stringify(text.trim().slice(0, 200));
      return refuse(`wrote the narration ${quoted} instead of acting. Narration is not an action. Your reply must begin with the character { and end with }: put that sentence in "text" and the tool call it describes in "tool_calls", exactly like {"text":${quoted},"tool_calls":[{"name":"<exact tool name>","arguments":{...}}]}`, 'prose', {}, 2);
    }
    logSafe('cursor-output-prose-accepted', { bytes: text.length });
    value = { text: text.trim(), tool_calls: [] };
  } else {
    candidate = extractJsonObject(text);
    try { value = parseJsonLoosely(candidate); } catch {
      return refuse('did not return a parseable JSON object (expected exactly {"text": string, "tool_calls": array} with no Markdown fences or surrounding prose)', 'unparseable', { starts_object: candidate.startsWith('{'), ends_object: candidate.endsWith('}') });
    }
  }
  if (!isRecord(value)) return refuse('returned JSON that is not an object; the reply must be one object with text and tool_calls', 'not-object');
  if (!Object.hasOwn(value, 'text') && !Object.hasOwn(value, 'tool_calls')) {
    // A model may copy a single Responses/OpenAI call from history instead of the envelope.
    // It still passes the same exact-name, custom-input, and schema validation below.
    const call = value;
    if ((typeof call.name === 'string' && ['arguments', 'input', 'parameters'].some(key => Object.hasOwn(call, key))) || isRecord(call.function) || isRecord(call.custom)) value = { text: '', tool_calls: [call] };
    else return refuse('returned a JSON object without text or tool_calls; use the required reply envelope instead of silently ending the turn', 'missing-envelope');
  }
  if (!isRecord(value)) return refuse('returned an invalid reply envelope', 'missing-envelope');
  if (candidate !== text.trim()) logSafe('cursor-output-unwrapped', { bytes: text.length });
  const extraTop = Object.keys(value).filter(key => !['text', 'tool_calls'].includes(key));
  if (extraTop.length) logSafe('cursor-output-extra-keys', { count: extraTop.length });
  let responseText = value.text;
  if (responseText === undefined || responseText === null) responseText = '';
  if (typeof responseText !== 'string') return refuse('returned a non-string text field; text must be a string (use "" when there is nothing to say)', 'text-type');
  let rawCalls = value.tool_calls;
  if (rawCalls === undefined || rawCalls === null) rawCalls = [];
  if (!Array.isArray(rawCalls)) return refuse('returned tool_calls that is not an array; use [] when no tool is needed', 'tool-calls-type');
  if (rawCalls.length > 64) return refuse('returned more than 64 tool calls in one reply', 'too-many-calls', { count: rawCalls.length });
  if (descriptors.length && !rawCalls.length && isUnfinishedNarration(responseText, latest)) return refuse('narrated a future tool action but returned no tool calls. If the original request needs that action, return its actual Codex call in tool_calls. A requested quote, plan, genuine final answer or concrete blocker may finish without tools', 'prose');
  const toolCalls = rawCalls.map((call: unknown, index: number) => {
    if (!isRecord(call)) return refuse(`tool_calls[${index}] is not an object; each call is {"name": string, "arguments": ...}`, 'call-not-object');
    // OpenAI-style {type:'function', function:{name, arguments}} is a common slip; unwrap it.
    const inner = isRecord(call.function) ? call.function : isRecord(call.custom) ? call.custom : call;
    let name = typeof inner.name === 'string' ? inner.name : undefined;
    if (!name) return refuse(`tool_calls[${index}] has no string name; use an exact tool name from the list`, 'call-no-name');
    const namespace = typeof inner.namespace === 'string' ? inner.namespace : typeof call.namespace === 'string' ? call.namespace : undefined;
    if (namespace) name = name.startsWith(namespace + '.') ? name : `${namespace}.${name}`;
    if (!allowed.has(name) && name.startsWith('functions.') && allowed.has(name.slice(10))) name = name.slice(10);
    const descriptor = allowed.get(name);
    if (!descriptor) {
      const sample = descriptors.slice(0, 6).map(tool => tool.proxyName).join(', ');
      return refuse(`called unknown tool ${fieldName(name)}; use an exact tool name from the list (for example ${sample})`, 'unknown-tool');
    }
    const rawArgs = inner.arguments ?? inner.input ?? inner.parameters;
    if (descriptor.type === 'custom') {
      const raw = coerceCustomArguments(rawArgs);
      if (raw === undefined) {
        const seen = isRecord(rawArgs) ? Object.keys(rawArgs).map(fieldName).join(', ') : typeof rawArgs;
        return refuse(`passed non-string arguments to custom tool ${descriptor.proxyName} (got ${seen}) with no string payload; its arguments must be one raw string holding the whole input (for exec, the JavaScript source itself; options go in a first-line // @exec: pragma), not a JSON object`, 'custom-args-type', { tool: descriptor.proxyName });
      }
      if (raw !== rawArgs) logSafe('cursor-custom-args-unwrapped', { tool: descriptor.proxyName });
      return { name: descriptor.proxyName, arguments: raw, callId: randomId('call') };
    }
    let args: unknown = rawArgs;
    if (args === undefined || args === null || args === '') args = {};
    if (typeof args === 'string') { try { args = parseJsonLoosely(args); } catch { return refuse(`passed arguments to ${descriptor.proxyName} that are not valid JSON; function arguments must be a JSON object`, 'args-unparseable', { tool: descriptor.proxyName }); } }
    if (!isRecord(args)) return refuse(`passed non-object arguments to ${descriptor.proxyName}; function arguments must be a JSON object`, 'args-not-object', { tool: descriptor.proxyName });
    const contract = isRecord(descriptor.contract) ? descriptor.contract : undefined;
    const properties = contract && isRecord(contract.properties) ? contract.properties : undefined;
    if (contract && properties) {
      const declared = Object.keys(properties);
      const missing = (Array.isArray(contract.required) ? contract.required : []).filter((key: unknown) => typeof key === 'string' && !Object.hasOwn(args as JsonRecord, key));
      if (missing.length) return refuse(`called ${descriptor.proxyName} without its required ${missing.map(fieldName).join(', ')}; its parameters are ${declared.join(', ')}`, 'args-missing-required', { tool: descriptor.proxyName, missing: missing.length });
      // Extra fields carry no meaning for the tool (models like adding description or timeout); drop
      // them instead of failing the turn, matching the Grok backend.
      if (contract.additionalProperties === false) {
        const unexpected = Object.keys(args).filter(key => !declared.includes(key));
        if (unexpected.length) { logSafe('cursor-argument-shape', { tool: descriptor.proxyName, dropped: unexpected.length }); for (const key of unexpected) delete (args as JsonRecord)[key]; }
      }
    }
    if (!matchesSchema(args, descriptor.contract)) {
      const declared = properties ? Object.keys(properties).join(', ') : 'as documented';
      return refuse(`called ${descriptor.proxyName} with arguments that do not match its schema (wrong value type or enum); its parameters are ${declared}`, 'args-schema', { tool: descriptor.proxyName });
    }
    return { name: descriptor.proxyName, arguments: JSON.stringify(args), callId: randomId('call') };
  });
  const inputTokens = estimateVisibleTokens(requestToPrompt(request));
  const outputTokens = estimateVisibleTokens(text);
  return { text: responseText, toolCalls, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
}

const OPAQUE_ITEM_TYPES = new Set(['compaction', 'compaction_summary', 'context_compaction', 'encrypted_content', 'reasoning']);
const MEDIA_PART_TYPES = new Set(['input_audio', 'audio', 'input_file', 'file']);
const isOpaque = (value: JsonRecord): boolean => OPAQUE_ITEM_TYPES.has(String(value.type)) || typeof value.encrypted_content === 'string';
// Inline PNG/JPEG/GIF/WebP data URLs are forwarded to the bridge as SelectedImages (the same path the
// Cursor app uses for pasted screenshots). Share the prompt's typed/MCP/legacy-computer recognition;
// ordinary tool metadata containing image_url or file_id is text, not an attachment.
const isInlineImage = (value: JsonRecord, legacyComputerOutput: boolean): boolean => !value.file_id && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(imageUrl(value, legacyComputerOutput) ?? '');

/**
 * Cursor cannot replay OpenAI-encrypted reasoning, compaction summaries or non-image attachments. Rather
 * than refusing the whole turn (which breaks mid-thread model switches from a GPT backend), drop the opaque
 * history items and replace unsupported media parts with a short text placeholder so the model knows
 * something was omitted. Inline images survive untouched. Returns the sanitized input plus a count of what
 * changed for logging.
 */
export function sanitizeCursorInput(input: unknown): { input: unknown; dropped: number; replaced: number } {
  const stats = { dropped: 0, replaced: 0 };
  const walk = (value: unknown, legacyComputerOutput = false): unknown => {
    if (Array.isArray(value)) return value.map(item => walk(item, legacyComputerOutput));
    if (!isRecord(value)) return value;
    if (isImagePart(value, legacyComputerOutput)) {
      if (isInlineImage(value, legacyComputerOutput)) return value;
      stats.replaced++; return { type: 'input_text', text: '[attachment omitted: the Cursor bridge accepts text and inline images only]' };
    }
    if (MEDIA_PART_TYPES.has(String(value.type))) { stats.replaced++; return { type: 'input_text', text: '[attachment omitted: the Cursor bridge accepts text and inline images only]' }; }
    if (isOpaque(value)) { stats.replaced++; return { type: 'input_text', text: '[encrypted or compacted content from a previous model; unreadable here]' }; }
    const out: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) out[key] = walk(child, value.type === 'computer_call_output' && key === 'output');
    return out;
  };
  if (!Array.isArray(input)) return { input: walk(input), ...stats };
  const items: unknown[] = [];
  for (const item of input) {
    if (isRecord(item) && isOpaque(item)) { stats.dropped++; continue; }
    items.push(walk(item));
  }
  return { input: items, ...stats };
}

const OUTPUT_RULES = `You are inside the Codex external tool loop. Return ONLY one JSON object with exactly text (string) and tool_calls (array). Each call has exactly name and arguments. Use the exact Codex tool names below. Function arguments are JSON objects; custom tool arguments are raw strings. All actions are executed externally by Codex AFTER your reply: you have no native tools. Never claim an action succeeded until its tool result appears in history. Do not wrap JSON in Markdown or add text outside it. To narrate progress and keep working, put the sentence in text and the next call in tool_calls of the same object; a reply whose tool_calls is empty ends the turn.`;

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
        if (value.error) {
          if (CONTEXT_OVERFLOW_TEXT.test(JSON.stringify(value.error))) throw contextOverflowError('Cursor');
          // Connect `unavailable` (or a network message) means the bridge could not reach Cursor's
          // servers: the router's shared offline policy keeps the request pending and retries it.
          if (connectUnavailable(value.error)) throw new ProxyTransportError();
          const code = isRecord(value.error) && typeof value.error.code === 'string' ? value.error.code : 'unknown';
          const transient = ['internal', 'unknown', 'aborted', 'deadline_exceeded'].includes(code);
          logSafe('cursor-stream-refused', { code, transient });
          throw new CursorError('Cursor stream failed; no automatic supplier fallback', transient);
        }
      } else yield value;
    }
  }
  if (pending.length) throw new CursorError('Cursor stream ended with a partial frame');
}

/** A Connect error whose code or message says the upstream service could not be reached. */
function connectUnavailable(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  const message = isRecord(error) && typeof error.message === 'string' ? error.message : '';
  return code === 'unavailable' || transportError(new Error(message))?.reconnectable === true;
}

/**
 * Whether Cursor's API answers at all from this machine. The bridge reports its own failure to reach
 * Cursor as a bare 500 `internal` (2026-10-19: `Me` 500 while every OpenAI request was also failing
 * with status 0), so a persistent 5xx alone cannot tell an outage from a Cursor-side fault. Any HTTP
 * answer means the network is up; only a transport failure counts as unreachable.
 */
async function cursorUnreachable(): Promise<boolean> {
  try { await fetch(process.env.CURSOR_REACHABILITY_URL || 'https://api2.cursor.sh', { method: 'HEAD', signal: AbortSignal.timeout(5000) }); return false; }
  catch (error) { return !!transportError(error); }
}

export function assertCursorIdentity(value: unknown, options: Pick<CursorOptions, 'expectedEmail' | 'expectedUserId'>): void {
  const user = isRecord(value) && isRecord(value.user) ? value.user : undefined;
  if (!user || user.userEmail !== options.expectedEmail || String(user.userId) !== options.expectedUserId) throw new CursorError('Cursor authenticated account differs from the pinned identity');
}

// Account/catalog lookups have a much lower rate limit than agent inference. Validate once per
// credential and pins, share concurrent lookups, and refresh after five minutes. A rotated key or
// changed identity pin never reuses another account's proof. Server access policy remains decisive.
type CursorRpc = (service:string, method:string, body:JsonRecord) => Promise<Response>;
type CursorProfileProof = { expires:number; value:Promise<JsonRecord>; cancelled:boolean };
const profileCache = new Map<string, CursorProfileProof>();
/** Each caller can leave a shared lookup without cancelling a different bridge's owner. */
function awaitCursorProfile(value: Promise<JsonRecord>, signal?: AbortSignal): Promise<JsonRecord> {
  signal?.throwIfAborted();
  if (!signal) return value;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', abort);
    value.then(result => { cleanup(); resolve(result); }, error => { cleanup(); reject(error); });
  });
}
export async function verifyCursorProfile(options:Pick<CursorOptions,'expectedEmail'|'expectedUserId'|'binaryHash'>, key:string, rpc:CursorRpc, signal?:AbortSignal):Promise<JsonRecord> {
  signal?.throwIfAborted();
  const cacheKey = sha256(Buffer.from(key))+'|'+options.expectedEmail+'|'+options.expectedUserId+'|'+options.binaryHash;
  const previous = profileCache.get(cacheKey);
  let entry: CursorProfileProof;
  if (previous && previous.expires > Date.now()) entry = previous;
  else {
    const value = (async () => {
      assertCursorIdentity(await (await rpc('SdkCursorService','Me',{options:{apiKey:key}})).json(),options);
      const models:unknown = await (await rpc('SdkCursorService','ListModels',{options:{apiKey:key}})).json();
      if (!isRecord(models) || !Array.isArray(models.items)) throw new CursorError('Cursor returned an invalid model catalog');
      return models;
    })().catch((error: unknown) => {
      // A cancelled lookup owner's fetch must not poison uncancelled waiters. Only an actual abort
      // qualifies: identity/auth/quota/backend refusals retain their original terminal behaviour,
      // even if the owner also happened to cancel before the rejection was observed.
      entry.cancelled = !!signal?.aborted && !(error instanceof BackendError)
        && (error === signal.reason || (error instanceof Error && error.name === 'AbortError'));
      if (profileCache.get(cacheKey) === entry) profileCache.delete(cacheKey);
      throw error;
    });
    entry = {expires:Date.now()+300_000,value,cancelled:false};
    if (profileCache.size >= 32) profileCache.delete(profileCache.keys().next().value!);
    profileCache.set(cacheKey,entry);
  }
  try {
    const result = await awaitCursorProfile(entry.value, signal);
    signal?.throwIfAborted();
    return result;
  } catch(error) {
    signal?.throwIfAborted();
    if (entry.cancelled) return verifyCursorProfile(options,key,rpc,signal);
    throw error;
  }
}

export function interpretCursorEvents(events: JsonRecord[], request: ResponsesRequest, selection: JsonRecord, captureDir?: string, acceptProse = false): ProxyOutput {
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
  if (!result || result.status !== FINISHED || !run || run.status !== FINISHED || !isRecord(done) || done.runId !== result.runId || typeof run.result !== 'string') {
    // Name the lifecycle state so a failed run is diagnosable from the router log, and retry once
    // when Cursor itself reports a transient provider error, which is what native Codex does for
    // 429/5xx. The reason is Cursor's provider string, not model output, so it is safe to surface.
    const status = String(result?.status ?? 'missing').replace(/^RUN_LIFECYCLE_STATUS_/, '');
    const runStatus = String(run?.status ?? 'missing').replace(/^RUN_LIFECYCLE_STATUS_/, '');
    const reason = cursorRunReason(result, run, done);
    // An errored run that carries no reason at all (2026-10-15: status ERROR, every reason field
    // empty) is indistinguishable from a provider hiccup, and nothing has executed, so it gets the
    // same single fresh attempt. A run that names a non-transient reason is not retried. The raw
    // terminal frames are kept owner-only so the next opaque failure can be read, not guessed.
    const errored = runStatus !== 'FINISHED' || status !== 'FINISHED';
    const opaque = errored && !reason;
    const cancelled = /CANCELLED|CANCELED/.test(`${status} ${runStatus}`);
    const transient = !cancelled && (opaque || (!!reason && TRANSIENT_RUN_ERROR.test(reason)));
    const captured = captureInvalidOutput(captureDir, 'unfinished', JSON.stringify({ result, done, events }, null, 1).slice(0, 262_144));
    const keysOf = (value: unknown) => isRecord(value) ? Object.keys(value).sort().slice(0, 32) : [];
    logSafe('cursor-unfinished', { events: events.length, terminal: terminal.length, status, runStatus, hasDone: isRecord(done), doneMatches: isRecord(done) && !!result && done.runId === result.runId, resultType: typeof run?.result, reasonBytes: reason?.length ?? 0, opaque, transient, resultKeys: keysOf(result), runKeys: keysOf(run), doneKeys: keysOf(done), captured: !!captured });
    if (reason && CONTEXT_OVERFLOW_TEXT.test(reason)) throw contextOverflowError('Cursor');
    const detail = status === 'FINISHED' && runStatus === 'FINISHED' ? 'the run finished without a result' : `run status ${runStatus}${reason ? `: ${reason}` : opaque ? ' with no reason from Cursor' : ''}`;
    throw new CursorError(`Cursor did not finish successfully (${detail}); no automatic supplier fallback`, transient);
  }
  const sameModel = isRecord(run.model) && run.model.id === selection.id && Array.isArray(run.model.params) && Array.isArray(selection.params) && JSON.stringify([...run.model.params].sort((a,b) => String(isRecord(a) ? a.id : '').localeCompare(String(isRecord(b) ? b.id : '')))) === JSON.stringify([...selection.params].sort((a,b) => String(isRecord(a) ? a.id : '').localeCompare(String(isRecord(b) ? b.id : ''))));
  if (!sameModel) throw new CursorError('Cursor reported a different model or reasoning setting; request refused');
  const output = parseCursorOutput(run.result, request, captureDir, acceptProse);
  if (isRecord(run.usage)) {
    const input = Number(run.usage.inputTokens ?? 0) + Number(run.usage.cacheReadTokens ?? 0) + Number(run.usage.cacheWriteTokens ?? 0), out = Number(run.usage.outputTokens ?? 0);
    if ([input,out].every(n => Number.isSafeInteger(n) && n >= 0)) output.usage = { inputTokens: input, outputTokens: out, totalTokens: input + out };
  }
  return output;
}

const PROSE_CORRECTION = 'Your last reply needs a valid tool envelope. No Codex action ran. Reply with ONLY one JSON object beginning with { . Recheck the original user request: if an external action is still needed, put progress in "text" and its next actual Codex call in "tool_calls", rather than promising it with an empty array. If the user requested a quote, draft, translation or plan, or your answer is genuinely complete, confirm that final answer unchanged in "text" with "tool_calls": []. A concrete blocker or user-requested pause may also finish without tools. Never claim an action ran without its tool result.';
const OUTPUT_CORRECTION = 'Your last tool envelope was rejected before any Codex action ran. Continue this same task by correcting that output, using ONLY one JSON object with text and tool_calls. Use exact declared tool names and namespaces, function arguments matching their schema, and raw strings for custom tools. Do not repeat the rejected output or replace a needed action with narration. Refusal detail: ';

type CursorSession = {
  agentId: string; signature: string; historyHash: string; historyLength: number;
  inputLength: number; callIds: Set<string>; expires: number;
};
type CursorBridge = {
  process: Bun.Subprocess<'ignore', 'ignore', 'pipe'>; dir: string; url: string; token: string;
  id: string; startupMs: number; dead: boolean; agentDirs: Map<string, string>; session?: CursorSession; dispose(): Promise<void>;
};
export type CursorBackend = SubscriptionBackend & { close(): Promise<void> };
// A normal process.exit must not orphan parked bridges. Track immediately after spawn, including
// children still waiting for their handshake; asynchronous directory cleanup is handled in dispose.
const residentBridges = new Set<CursorBridge['process']>();
process.once('exit', () => {
  for (const child of residentBridges) { try { child.kill(); } catch {} }
});

/** Bind a continuation to the exact text and images the bridge can read. Responses metadata
 * (IDs, status, annotations, input_text vs output_text) can be reserialized by Codex. */
function historyHash(items: unknown[]): string {
  const prepared = preparePrompt({ model: '', input: items as ResponsesRequest['input'] });
  return sha256(JSON.stringify(prepared));
}
function sessionSignature(request: ResponsesRequest, selection: JsonRecord): string {
  return JSON.stringify({ selection, instructions: request.instructions, tools: requestTools(request), toolChoice: request.tool_choice, outputLimit: request.max_output_tokens });
}
const TOOL_RESULTS = new Set(['function_call_output', 'custom_tool_call_output', 'computer_call_output', 'tool_search_output']);

class CursorRuntime {
  private readonly pool: CursorBridgePool<CursorBridge>;
  private readonly sessions = new Map<string, CursorBridge>();
  readonly options: Readonly<CursorOptions>;
  constructor(options: CursorOptions) {
    this.options = Object.freeze({ ...options });
    this.pool = new CursorBridgePool(
      Math.min(32, positiveInt('CURSOR_MAX_BRIDGES', 8)), positiveInt('CURSOR_BRIDGE_IDLE_MS', 120_000),
      (key, signal) => this.startBridge(key, signal), bridge => bridge.dispose(),
      bridge => !bridge.dead && bridge.process.exitCode === null,
    );
  }
  close(): Promise<void> { return this.pool.close(); }
  private forget(bridge: CursorBridge): void {
    for (const id of bridge.session?.callIds ?? []) if (this.sessions.get(id) === bridge) this.sessions.delete(id);
    bridge.session = undefined;
  }
  private async startBridge(key: string, signal?: AbortSignal): Promise<CursorBridge> {
    const options = this.options;
    const started = performance.now();
    if (sha256(await readFile(options.binary)) !== options.binaryHash) throw new CursorError('Cursor pinned bridge changed; backend paused');
    const dir = await mkdtemp(join(options.cwd, 'request-')); await chmod(dir, 0o700);
    let process: CursorBridge['process'];
    try {
      signal?.throwIfAborted();
      process = Bun.spawn([options.binary, '--host', '127.0.0.1', '--port', '0', '--workspace', dir, '--state-root', join(dir, 'store'), '--local-store', JSON.stringify({ type: 'jsonl', rootDir: join(dir, 'store') })], { cwd: dir, env: cursorEnvironment(key), stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
      residentBridges.add(process);
      const remove = () => { residentBridges.delete(process); };
      void process.exited.then(remove, remove);
    } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
    const bridge: CursorBridge = {
      process, dir, url: '', token: '', id: randomId('bridge'), startupMs: 0, dead: false, agentDirs: new Map(),
      dispose: () => {
        if (disposal) return disposal;
        bridge.dead = true; this.forget(bridge);
        disposal = (async () => {
          try { process.kill(); } catch { logSafe('cursor-cleanup-failed', { bridge_id: bridge.id, stage: 'kill' }); }
          try { await process.exited; } catch { logSafe('cursor-cleanup-failed', { bridge_id: bridge.id, stage: 'exit' }); }
          try { await rm(dir, { recursive: true, force: true }); } catch { logSafe('cursor-cleanup-failed', { bridge_id: bridge.id, stage: 'directory' }); }
        })();
        return disposal;
      },
    };
    let disposal: Promise<void> | undefined;
    const abort = () => { void bridge.dispose(); };
    signal?.addEventListener('abort', abort, { once: true });
    let startup: ReturnType<typeof setTimeout> | undefined;
    try {
      const info = await new Promise<JsonRecord>((resolve, reject) => {
        const startupMs = positiveInt('CURSOR_STARTUP_TIMEOUT_MS', 60_000);
        startup = setTimeout(() => { logSafe('cursor-startup-timeout', { startupMs }); void bridge.dispose(); reject(new CursorError('Cursor bridge startup timed out', true)); }, startupMs);
        void (async () => {
          let line = '', bytes = 0, found = false;
          try {
            for await (const chunk of process.stderr) {
              bytes += chunk.length;
              if (bytes > MAX_BYTES) throw new CursorError('Cursor diagnostics exceeded safety limit');
              line += new TextDecoder().decode(chunk);
              let boundary: number;
              while ((boundary = line.indexOf('\n')) >= 0) {
                const current = line.slice(0, boundary); line = line.slice(boundary + 1);
                if (!found && current.startsWith('cursor-sdk-bridge ready ')) {
                  const value: unknown = JSON.parse(current.slice(24));
                  if (!isRecord(value)) throw new Error('invalid handshake');
                  found = true; clearTimeout(startup); resolve(value);
                }
              }
              if (line.length > 65536) throw new Error('diagnostic line exceeded limit');
            }
            if (!found) reject(new CursorError('Cursor bridge exited before ready'));
          } catch { void bridge.dispose(); reject(new CursorError('Cursor bridge startup or diagnostics failed')); }
        })();
      });
      signal?.throwIfAborted();
      if (info.schemaVersion !== 1 || info.host !== '127.0.0.1' || info.protocol !== 'connect' || info.transport !== 'tcp' || typeof info.port !== 'number' || typeof info.authTokenFile !== 'string' || typeof info.url !== 'string' || info.url !== `http://127.0.0.1:${info.port}`) throw new CursorError('Cursor returned an invalid local handshake');
      bridge.url = info.url; bridge.token = (await readFile(info.authTokenFile, 'utf8')).trim();
      const exited = () => { bridge.dead = true; this.forget(bridge); };
      void process.exited.then(exited, exited);
      bridge.startupMs = performance.now() - started;
      logSafe('cursor-bridge-started', { bridge_id: bridge.id, startup_ms: Math.round(bridge.startupMs) });
      return bridge;
    } catch (error) { await bridge.dispose(); signal?.throwIfAborted(); throw error; }
    finally { clearTimeout(startup); signal?.removeEventListener('abort', abort); }
  }
  private async rpc(bridge: CursorBridge, service: string, method: string, body: JsonRecord, signal: AbortSignal, stream = false): Promise<Response> {
    const json = Buffer.from(JSON.stringify(body));
    const header = Buffer.alloc(5); header.writeUInt32BE(json.length, 1);
    const backoff = positiveInt('CURSOR_RPC_RETRY_MS', 1000);
    for (let tries = 1; ; tries++) {
      let response: Response;
      try {
        response = await fetch(`${bridge.url}/sdk.v1.${service}/${method}`, { method: 'POST', signal, headers: { authorization: `Bearer ${bridge.token}`, 'content-type': stream ? 'application/connect+json' : 'application/json', 'connect-protocol-version': '1' }, body: stream ? Buffer.concat([header, json]) : json });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new CursorError('Cursor bridge connection failed; no automatic supplier fallback', true);
      }
      if (response.ok) return response;
      const detail: unknown = await response.json().catch(() => undefined);
      const code = isRecord(detail) && typeof detail.code === 'string' ? detail.code.replace(/[^a-z_]/g, '').slice(0, 64) : 'unknown';
      if (isRecord(detail) && typeof detail.message === 'string' && CONTEXT_OVERFLOW_TEXT.test(detail.message)) throw contextOverflowError('Cursor');
      if (connectUnavailable(detail)) throw new ProxyTransportError();
      const transient = response.status >= 500;
      if (transient && !stream && tries < 3) {
        logSafe('cursor-rpc-retry', { service, method, status: response.status, code, attempt: tries });
        await new Promise<void>((resolve, reject) => {
          const stop = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, backoff * 2 ** (tries - 1));
          signal.addEventListener('abort', stop, { once: true });
          if (signal.aborted) stop();
        });
        continue;
      }
      const offline = transient && await cursorUnreachable();
      logSafe('cursor-rpc-refused', { service, method, status: response.status, code, transient, offline, tries });
      if (offline) throw new ProxyTransportError();
      throw new CursorError(`Cursor SDK request refused (HTTP ${response.status}, ${code}); no automatic supplier fallback`, transient);
    }
  }
  async run(request: ResponsesRequest, signal?: AbortSignal, retryNote = '', lastAttempt = false): Promise<ProxyOutput> {
    signal?.throwIfAborted();
    const started = performance.now(), requestId = randomId('cursor');
    const sanitized = sanitizeCursorInput(request.input);
    if (sanitized.dropped || sanitized.replaced) logSafe('cursor-input-sanitized', { dropped: sanitized.dropped, replaced: sanitized.replaced });
    request = { ...request, input: sanitized.input as ResponsesRequest['input'] };
    const selection = cursorSelection(request.model, request.reasoning?.effort, this.options.fastest);
    const key = readCursorKey(this.options);
    signal?.throwIfAborted();
    const signature = sessionSignature(request, selection);
    let preferred: CursorBridge | undefined;
    const reuseBridge = process.env.CURSOR_BRIDGE_REUSE !== '0';
    const reuseSession = reuseBridge && process.env.CURSOR_SESSION_REUSE !== '0';
    if (!retryNote && reuseSession && Array.isArray(request.input)) {
      for (let i = request.input.length - 1; i >= 0; i--) {
        const callId = request.input[i]?.call_id;
        if (callId && this.sessions.has(callId)) { preferred = this.sessions.get(callId); break; }
      }
    }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let lease: CursorLease<CursorBridge> | undefined;
    let bridge: CursorBridge | undefined;
    let agentId = '', runId = '', timedOut = false, successful = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancellation: Promise<void> | undefined;
    const idleMs = positiveInt('CURSOR_TIMEOUT_MS', 300_000);
    const touch = () => { clearTimeout(timeout); timeout = setTimeout(() => { timedOut = true; cancel(); }, idleMs); };
    const cancel = () => {
      controller.abort();
      // This request exclusively owns the bridge lease, including any retained agent. No other
      // request can run here until release, so a hard stop is safe even before a run ID arrives.
      if (bridge) {
        const owned = bridge;
        cancellation = (runId ? fetch(`${owned.url}/sdk.v1.SdkAgentService/CancelRun`, { method: 'POST', signal: AbortSignal.timeout(2000), headers: { authorization: `Bearer ${owned.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agentId, runId }) }).then(() => {}, () => {}) : Promise.resolve()).then(() => owned.dispose());
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    let queuedMs = 0, setupMs = 0, runMs = 0, firstEventMs = 0, continued = false;
    try {
      const queued = performance.now();
      lease = await this.pool.acquire(key, combined, preferred);
      queuedMs = performance.now() - queued;
      bridge = lease.value;
      if (!lease.reused) queuedMs = Math.max(0, queuedMs - bridge.startupMs);
      combined.throwIfAborted(); touch();
      // Check at the point a queued request actually acquires ownership. New children verify before
      // spawn; warm children rehash here. Rotation/expiry while queued cannot inherit a stale login.
      if (lease.reused && sha256(await readFile(this.options.binary)) !== this.options.binaryHash) throw new CursorError('Cursor pinned bridge changed; backend paused');
      if (readCursorKey(this.options) !== key) throw new CursorError('Cursor credential changed while queued; retry the turn', true);
      combined.throwIfAborted();
      const activeBridge = bridge;
      const rpc = (service: string, method: string, body: JsonRecord) => this.rpc(activeBridge, service, method, body, combined);
      const models = await verifyCursorProfile(this.options, key, rpc, combined);
      const discovered = isRecord(models) && Array.isArray(models.items) ? models.items.find(item => isRecord(item) && item.id === request.model) : undefined;
      if (!isRecord(discovered) || !Array.isArray(discovered.parameters)) throw new CursorError('Requested model is unavailable on the pinned Cursor account');
      const definitions = discovered.parameters;
      const params = selection.params as Array<{ id: string; value: string }>;
      if (params.some(param => !definitions.some(def => isRecord(def) && def.id === param.id && Array.isArray(def.values) && def.values.some(v => isRecord(v) && v.value === param.value)))) throw new CursorError('Requested Cursor parameters are unavailable');
      let promptRequest = request;
      const session = bridge.session;
      if (!retryNote && reuseSession && session && session.expires > Date.now() && session.signature === signature && Array.isArray(request.input) && request.input.length > session.historyLength && historyHash(request.input.slice(0, session.historyLength)) === session.historyHash) {
        const suffix = request.input.slice(session.historyLength);
        const results = new Set(suffix.filter(item => TOOL_RESULTS.has(item.type ?? '')).map(item => item.call_id));
        if (TOOL_RESULTS.has(suffix[0]?.type ?? '') && [...session.callIds].every(id => results.has(id))) {
          agentId = session.agentId; continued = true;
          // Include the previous assistant calls so generated Codex call IDs are explicit, followed
          // only by the new tool results/messages. All earlier context stays in this agent.
          promptRequest = { ...request, instructions: undefined, tools: undefined, input: request.input.slice(session.inputLength) };
        }
      }
      this.forget(bridge);
      if (!continued) {
        if (session) await this.closeAgent(bridge, session.agentId);
        const agentDir = await mkdtemp(join(bridge.dir, 'agent-')); await chmod(agentDir, 0o700);
        const created: unknown = await (await rpc('SdkAgentService', 'CreateAgent', { options: { apiKey: key, model: selection, tools: { names: [] }, disallowedTools: ['task', 'mcp'], local: { cwd: [agentDir], settingSources: [] } } })).json();
        if (!isRecord(created) || typeof created.agentId !== 'string') throw new CursorError('Cursor agent creation failed');
        agentId = created.agentId;
        bridge.agentDirs.set(agentId, agentDir);
      }
      const prepared = preparePrompt(promptRequest);
      const images = prepared.images.map(image => ({ data: { data: image.source.data, mimeType: image.source.media_type } }));
      setupMs = performance.now() - started;
      const send = async (text: string, attach: typeof images = []): Promise<JsonRecord[]> => {
        const response = await this.rpc(activeBridge, 'SdkAgentService', 'Send', { agentId, message: attach.length ? { text, images: attach } : { text }, options: { enableSteps: true } }, combined, true);
        if (!response.body) throw new CursorError('Cursor returned an empty stream');
        const events: JsonRecord[] = [];
        try {
          for await (const event of connectFrames(response.body)) {
            touch();
            if (!firstEventMs) firstEventMs = performance.now() - started;
            events.push(event);
            const sdk = isRecord(event.sdkMessage) && isRecord(event.sdkMessage.message) ? event.sdkMessage.message : undefined;
            if (sdk && typeof (sdk.runId ?? sdk.run_id) === 'string') runId = String(sdk.runId ?? sdk.run_id);
            if (isRecord(event.result) && typeof event.result.runId === 'string') runId = event.result.runId;
          }
        } catch (error) {
          if (error instanceof ProxyTransportError || combined.aborted || !transportError(error)) throw error;
          throw new CursorError('Cursor bridge stream dropped; no automatic supplier fallback', true);
        }
        combined.throwIfAborted(); return events;
      };
      const captureDir = join(dirname(this.options.cwd), 'invalid-output');
      if (images.length) logSafe('cursor-images-attached', { count: images.length });
      const generation = performance.now();
      let events = await send(`${OUTPUT_RULES}${retryNote}\n\n${prepared.prompt}\n\n${OUTPUT_RULES}`, images);
      let output: ProxyOutput;
      for (let correction = 0; ; correction++) {
        try { output = interpretCursorEvents(events, request, selection, captureDir, lastAttempt && correction === 2); break; }
        catch (error) {
          // Only model-written output is repairable in place. Native execution, identity/model
          // drift, transport/lifecycle failure and cancellation never enter this continuation.
          if (!(error instanceof CursorError) || !error.modelOutput || !error.retryable || correction >= 2 || combined.aborted) throw error;
          const prose = error instanceof CursorProseError;
          logSafe(prose ? 'cursor-prose-correction' : 'cursor-output-correction', { attempt: correction + 1 });
          events = await send(prose ? PROSE_CORRECTION : OUTPUT_CORRECTION + error.message);
        }
      }
      runMs = performance.now() - generation;
      combined.throwIfAborted(); successful = true;
      if (output.toolCalls.length && reuseSession && Array.isArray(request.input)) {
        const prior = [...request.input, ...responseObject(request, output).output];
        const retained: CursorSession = { agentId, signature, historyHash: historyHash(prior), historyLength: prior.length, inputLength: request.input.length, callIds: new Set(output.toolCalls.flatMap(call => call.callId ? [call.callId] : [])), expires: Date.now() + positiveInt('CURSOR_SESSION_IDLE_MS', 900_000) };
        bridge.session = retained;
        for (const id of retained.callIds) this.sessions.set(id, bridge);
      }
      return output;
    } catch (error) {
      if (timedOut) throw new CursorError(`Cursor request timed out after ${Math.round(idleMs / 1000)}s without output; no automatic supplier fallback`, true);
      throw error;
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', cancel);
      logSafe('cursor-turn', { request_id: requestId, bridge_id: bridge?.id, model: request.model, reused: lease?.reused ?? false, continued, success: successful, queue_ms: Math.round(queuedMs), setup_ms: Math.round(setupMs), first_event_ms: Math.round(firstEventMs), run_ms: Math.round(runMs), elapsed_ms: Math.round(performance.now() - started) });
      if (cancellation) await cancellation;
      if (lease && bridge) {
        if (!successful || combined.aborted || bridge.dead) await lease.discard();
        else if (!reuseBridge) {
          try { await this.closeAgent(bridge, agentId); } catch {}
          await lease.discard();
        }
        else if (bridge.session) lease.release();
        else {
          const owned = lease, activeBridge = bridge, cleanup = performance.now();
          // Release validated output immediately. The exclusive lease remains held until agent
          // cleanup finishes; a subsequent request can never race this agent's close or disposal.
          void this.closeAgent(activeBridge, agentId).then(() => owned.release(), () => {
            logSafe('cursor-cleanup-failed', { request_id: requestId, stage: 'agent-close' });
            return owned.discard();
          }).finally(() => logSafe('cursor-cleanup', { request_id: requestId, elapsed_ms: Math.round(performance.now() - cleanup) }));
        }
      }
    }
  }
  private async closeAgent(bridge: CursorBridge, agentId: string): Promise<void> {
    if (!agentId) return;
    const response = await fetch(`${bridge.url}/sdk.v1.SdkAgentService/CloseAgent`, { method: 'POST', signal: AbortSignal.timeout(2000), headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agentId }) });
    if (!response.ok) throw new CursorError('Cursor agent cleanup failed', true);
    const dir = bridge.agentDirs.get(agentId);
    if (dir) { await rm(dir, { recursive: true, force: true }); bridge.agentDirs.delete(agentId); }
  }
}

export function createCursorBackend(options: CursorOptions): CursorBackend {
  if (![options.binary, options.authFile, options.cwd].every(isAbsolute) || !/^[a-z][a-z0-9-]*$/.test(options.prefix) || ['gpt','grok','claude'].includes(options.prefix) || !options.expectedEmail || !options.expectedUserId || !/^[a-f0-9]{64}$/.test(options.binaryHash)) throw new Error('Cursor requires absolute paths, a pinned bridge, account identity and a model namespace');
  const exposed: CursorModel[] = ['kimi-k3', 'grok-4.7', 'claude-opus-5-5', 'muse-wonder-1.0'];
  const runtime = new CursorRuntime(options);
  return {
    name: `Cursor (${options.label})`, reservedPrefix: `${options.prefix}-`,
    models: Object.fromEntries(exposed.map(model => [`${options.prefix}-${model}`, model])),
    catalog: exposed.map(model => ({ slug: `${options.prefix}-${model}`, displayName: `${CURSOR_MODELS[model].name} (${options.label})`, description: `Your subscription through Cursor; Codex executes tools.`, efforts: CURSOR_MODELS[model].efforts, defaultEffort: 'high', inputModalities: CURSOR_MODELS[model].vision ? ['text', 'image'] : ['text'], contextWindow: CURSOR_MODELS[model].window })),
    run: (request, signal) => retryOnce('Cursor', signal, (note, last) => runtime.run(request, signal, note, last)),
    close: () => runtime.close(),
  };
}
export function configuredCursorBackend(env: Readonly<Record<string, string | undefined>> = process.env): CursorBackend | undefined {
  if (!env.CURSOR_BRIDGE_BIN) return undefined;
  return createCursorBackend({ binary: env.CURSOR_BRIDGE_BIN, binaryHash: env.CURSOR_BRIDGE_SHA256 ?? '', authFile: env.CURSOR_AUTH_FILE ?? '', cwd: env.CURSOR_CWD ?? '', expectedEmail: env.CURSOR_EXPECTED_EMAIL ?? '', expectedUserId: env.CURSOR_EXPECTED_USER_ID ?? '', prefix: env.CURSOR_MODEL_PREFIX || 'cursor', label: env.CURSOR_LABEL || 'Cursor', fastest: env.CURSOR_SPEED_POLICY === 'fastest' });
}
