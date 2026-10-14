// Optional Cursor transport through the vendor's pinned SDK bridge. The proxy has no runtime
// package dependency: it speaks sdk.v1 Connect JSON to a short-lived loopback child process.
// Every request starts with tools: [], no setting sources, no MCP and no subagents. Cursor never
// owns execution; validated tool requests return to Codex only after the complete run succeeds.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { positiveInt } from '../env';
import { isRecord, randomId, sha256, type JsonRecord } from '../json';
import { preparePrompt, requestToPrompt, toolDescriptors } from '../protocol/prompt';
import type { ProxyOutput, ResponsesRequest } from '../protocol/types';
import { BackendError, CONTEXT_OVERFLOW_TEXT, contextOverflowError, estimateVisibleTokens, retryOnce, type SubscriptionBackend } from './contract';
import { repairJsonStrings } from './grok';
import { logSafe } from '../log';

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
  constructor(message: string, retryable = false, modelOutput = false, retries = 1) { super(message, { retryable, modelOutput, retries }); this.name = 'CursorError'; }
}

/** Bare narration with no JSON object. The agent that wrote it can be asked to wrap it in place. */
export class CursorProseError extends CursorError {
  constructor(message: string) { super(message, true, true, 2); this.name = 'CursorProseError'; }
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
const CUSTOM_PAYLOAD_KEYS = ['input', 'code', 'source', 'patch', 'script', 'text', 'content', 'arguments', 'argument', 'args', 'raw', 'body', 'value', 'cmd', 'command', 'js', 'javascript'];
const CUSTOM_METADATA_KEYS = new Set(['call_id', 'callId', 'id', 'index', 'name', 'tool', 'type']);
export function coerceCustomArguments(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (!isRecord(value)) return undefined;
  for (const key of CUSTOM_PAYLOAD_KEYS) if (typeof value[key] === 'string') return value[key] as string;
  const keys = Object.keys(value).filter(key => !CUSTOM_METADATA_KEYS.has(key));
  const strings = keys.filter(key => typeof value[key] === 'string');
  if (keys.length === 1 && strings.length === 1) return value[strings[0]!] as string;
  return undefined;
}

function parseJsonLooselyImpl(raw: string): unknown {
  try { return JSON.parse(raw); } catch { /* fall through */ }
  try { return JSON.parse(repairJsonStrings(raw)); } catch { /* fall through */ }
  const value = parseJsonLenient(raw);
  logSafe('cursor-output-repaired', { category: 'lenient', bytes: raw.length });
  return value;
}
const fieldName = (key: unknown) => typeof key === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(key) ? key : '(invalid name)';

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
  const descriptors = toolDescriptors(request.tools ?? []);
  const allowed = new Map(descriptors.map(tool => [tool.proxyName, tool]));
  let candidate = text.trim();
  let value: unknown = parseNativeToolMarkup(text);
  if (value) logSafe('cursor-output-native-markup', { bytes: text.length, calls: (value as JsonRecord).tool_calls instanceof Array ? ((value as JsonRecord).tool_calls as unknown[]).length : 0 });
  else if (!text.includes('{')) {
    // Grok 4.7 narrates mid-task ("I'll read those sections next.") and forgets the envelope entirely.
    // The first time, refuse with the exact wrap so the retry can continue the work; if the retry is
    // still bare prose, deliver it as a text-only message rather than a failed turn. No tool runs.
    if (!acceptProse) {
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
  const toolCalls = rawCalls.map((call: unknown, index: number) => {
    if (!isRecord(call)) return refuse(`tool_calls[${index}] is not an object; each call is {"name": string, "arguments": ...}`, 'call-not-object');
    // OpenAI-style {type:'function', function:{name, arguments}} is a common slip; unwrap it.
    const inner = isRecord(call.function) ? call.function : call;
    let name = typeof inner.name === 'string' ? inner.name : undefined;
    if (!name) return refuse(`tool_calls[${index}] has no string name; use an exact tool name from the list`, 'call-no-name');
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
const MEDIA_PART_TYPES = new Set(['input_image', 'image', 'input_audio', 'audio', 'input_file', 'file']);
const IMAGE_PART_TYPES = new Set(['input_image', 'image']);
const isOpaque = (value: JsonRecord): boolean => OPAQUE_ITEM_TYPES.has(String(value.type)) || typeof value.encrypted_content === 'string';
const isMedia = (value: JsonRecord): boolean => MEDIA_PART_TYPES.has(String(value.type)) || Boolean(value.file_id) || Boolean(value.image_url) || Boolean(value.audio_url) || Boolean(value.file_data);
const imageUrlOf = (value: JsonRecord): string | undefined => typeof value.image_url === 'string' ? value.image_url : isRecord(value.image_url) && typeof value.image_url.url === 'string' ? value.image_url.url : undefined;
// Inline PNG/JPEG/GIF/WebP data URLs are forwarded to the bridge as SelectedImages (the same path the
// Cursor app uses for pasted screenshots). Remote URLs, files and audio stay placeholders.
const isInlineImage = (value: JsonRecord): boolean => IMAGE_PART_TYPES.has(String(value.type)) && !value.file_id && /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(imageUrlOf(value) ?? '');

/**
 * Cursor cannot replay OpenAI-encrypted reasoning, compaction summaries or non-image attachments. Rather
 * than refusing the whole turn (which breaks mid-thread model switches from a GPT backend), drop the opaque
 * history items and replace unsupported media parts with a short text placeholder so the model knows
 * something was omitted. Inline images survive untouched. Returns the sanitized input plus a count of what
 * changed for logging.
 */
export function sanitizeCursorInput(input: unknown): { input: unknown; dropped: number; replaced: number } {
  const stats = { dropped: 0, replaced: 0 };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isRecord(value)) return value;
    if (isInlineImage(value)) return value;
    if (isMedia(value)) { stats.replaced++; return { type: 'input_text', text: '[attachment omitted: the Cursor bridge accepts text and inline images only]' }; }
    if (isOpaque(value)) { stats.replaced++; return { type: 'input_text', text: '[encrypted or compacted content from a previous model; unreadable here]' }; }
    const out: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) out[key] = walk(child);
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
          throw new CursorError('Cursor stream failed; no automatic supplier fallback');
        }
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
  if (!result || result.status !== FINISHED || !run || run.status !== FINISHED || !isRecord(done) || done.runId !== result.runId || typeof run.result !== 'string') throw new CursorError('Cursor did not finish successfully; no automatic supplier fallback');
  const sameModel = isRecord(run.model) && run.model.id === selection.id && Array.isArray(run.model.params) && Array.isArray(selection.params) && JSON.stringify([...run.model.params].sort((a,b) => String(isRecord(a) ? a.id : '').localeCompare(String(isRecord(b) ? b.id : '')))) === JSON.stringify([...selection.params].sort((a,b) => String(isRecord(a) ? a.id : '').localeCompare(String(isRecord(b) ? b.id : ''))));
  if (!sameModel) throw new CursorError('Cursor reported a different model or reasoning setting; request refused');
  const output = parseCursorOutput(run.result, request, captureDir, acceptProse);
  if (isRecord(run.usage)) {
    const input = Number(run.usage.inputTokens ?? 0) + Number(run.usage.cacheReadTokens ?? 0) + Number(run.usage.cacheWriteTokens ?? 0), out = Number(run.usage.outputTokens ?? 0);
    if ([input,out].every(n => Number.isSafeInteger(n) && n >= 0)) output.usage = { inputTokens: input, outputTokens: out, totalTokens: input + out };
  }
  return output;
}

const PROSE_CORRECTION = 'Your last reply was narration with no JSON object, so nothing ran. Reply again now with ONLY one JSON object that begins with { : put that sentence in "text" and the tool call it describes in "tool_calls". If you meant to finish, put your final answer in "text" with "tool_calls": [].';

async function runCursorOnce(options: CursorOptions, request: ResponsesRequest, signal?: AbortSignal, retryNote = '', lastAttempt = false): Promise<ProxyOutput> {
  signal?.throwIfAborted();
  const sanitized = sanitizeCursorInput(request.input);
  if (sanitized.dropped || sanitized.replaced) logSafe('cursor-input-sanitized', { dropped: sanitized.dropped, replaced: sanitized.replaced });
  request = { ...request, input: sanitized.input as ResponsesRequest['input'] };
  const selection = cursorSelection(request.model, request.reasoning?.effort, options.fastest);
  const prepared = preparePrompt(request);
  // SendRequest.message.images is SdkImage{ data: SdkImageData{ data: bytes, mime_type } }; proto JSON
  // encodes bytes as base64 and the oneof by field name. The bridge wraps each as a SelectedImage.
  const images = prepared.images.map(image => ({ data: { data: image.source.data, mimeType: image.source.media_type } }));
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
  let timedOut = false;
  // Native Codex bounds a model stream by silence, never by total length (model-provider-info
  // DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300 s; codex-api "idle timeout waiting for SSE"), and retries
  // that idle timeout like any dropped stream. A total deadline cut a long xhigh Grok turn that was
  // still producing frames (benchmark round 38). Every Connect frame restarts the window.
  const idleMs = positiveInt('CURSOR_TIMEOUT_MS', 300_000);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const touch = () => { clearTimeout(timeout); timeout = setTimeout(() => { timedOut = true; cancel(); }, idleMs); };
  touch();
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
    const send = async (text: string, attach: typeof images = []): Promise<JsonRecord[]> => {
      const response = await rpc('SdkAgentService', 'Send', { agentId, message: attach.length ? { text, images: attach } : { text }, options: { enableSteps: true } }, true);
      if (!response.body) throw new CursorError('Cursor returned an empty stream');
      const events: JsonRecord[] = [];
      for await (const event of connectFrames(response.body)) {
        touch();
        events.push(event);
        const sdk = isRecord(event.sdkMessage) && isRecord(event.sdkMessage.message) ? event.sdkMessage.message : undefined;
        if (sdk && typeof (sdk.runId ?? sdk.run_id) === 'string') runId = String(sdk.runId ?? sdk.run_id);
        if (isRecord(event.result) && typeof event.result.runId === 'string') runId = event.result.runId;
      }
      signal?.throwIfAborted(); controller.signal.throwIfAborted();
      return events;
    };
    const captureDir = join(dirname(options.cwd), 'invalid-output');
    if (images.length) logSafe('cursor-images-attached', { count: images.length });
    const events = await send(`${OUTPUT_RULES}${retryNote}\n\n${prepared.prompt}\n\n${OUTPUT_RULES}`, images);
    try {
      return interpretCursorEvents(events, request, selection, captureDir);
    } catch (error) {
      // A fresh agent given the same prompt repeats the same narration, so ask the agent that wrote
      // it to wrap its own sentence while it still holds the context. Nothing has run yet.
      if (!(error instanceof CursorProseError)) throw error;
      logSafe('cursor-prose-correction', {});
      return interpretCursorEvents(await send(PROSE_CORRECTION), request, selection, captureDir, lastAttempt);
    }
  } catch (error) {
    // The watchdog aborts the local fetch, which surfaces as a bare AbortError. Name it so Codex
    // shows the real cause instead of the generic internal-router message.
    if (timedOut) throw new CursorError(`Cursor request timed out after ${Math.round(idleMs / 1000)}s without output; no automatic supplier fallback`, true);
    throw error;
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
    catalog: exposed.map(model => ({ slug: `${options.prefix}-${model}`, displayName: `${CURSOR_MODELS[model].name} (${options.label})`, description: `Your subscription through Cursor; Codex executes tools.`, efforts: CURSOR_MODELS[model].efforts, defaultEffort: 'high', inputModalities: ['text', 'image'] })),
    run: (request, signal) => retryOnce('Cursor', signal, (note, last) => runCursorOnce(options, request, signal, note, last)),
  };
}
export function configuredCursorBackend(env: Readonly<Record<string, string | undefined>> = process.env): SubscriptionBackend | undefined {
  if (!env.CURSOR_BRIDGE_BIN) return undefined;
  return createCursorBackend({ binary: env.CURSOR_BRIDGE_BIN, binaryHash: env.CURSOR_BRIDGE_SHA256 ?? '', authFile: env.CURSOR_AUTH_FILE ?? '', cwd: env.CURSOR_CWD ?? '', expectedEmail: env.CURSOR_EXPECTED_EMAIL ?? '', expectedUserId: env.CURSOR_EXPECTED_USER_ID ?? '', prefix: env.CURSOR_MODEL_PREFIX || 'cursor', label: env.CURSOR_LABEL || 'Cursor', fastest: env.CURSOR_SPEED_POLICY === 'fastest' });
}
