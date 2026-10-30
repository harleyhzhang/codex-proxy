// Grok through the official Grok Build CLI. Subscription access stays with the CLI; its OAuth token
// is never read or forwarded. Every turn runs in a fresh, private directory with native tools
// removed, denied and hooked, so Codex remains the only thing that executes actions.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { childEnvironment, nonNegativeInt, positiveInt } from '../env';
import { isRecord, type JsonRecord, randomId, sha256 } from '../json';
import { logSafe } from '../log';
import { outputSchema, preparePrompt, requestToPrompt, requestTools, type ToolDescriptor, toolDescriptors } from '../protocol/prompt';
import type { ProxyOutput, ResponseInputItem, ResponsesRequest, ResponseTool, ToolCall } from '../protocol/types';
import { BackendError, classifyCliFailure, CONTEXT_OVERFLOW_TEXT, contextOverflowError, estimateVisibleTokens, OVERLOADED_TEXT, overloadedError, retryOnce, type SubscriptionBackend } from './contract';
import { transportError } from '../transport';
import { sameToolArguments, toolSchemaIssue } from '../protocol/tool-schema';

const MODEL = 'grok-4.7';
const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_TOOL_CALLS = 64;

/**
 * Grok's own tool names, denied by exact internal ID (the CLI has no alias map). `run_terminal_cmd`
 * and `write` are the real shell and write IDs; `search_tool`/`use_tool` are the MCP meta tools the
 * allowlist always keeps unless they are denied. The older names stay for other CLI versions.
 */
const NATIVE_TOOLS = [
  'Agent', 'bash', 'run_terminal_command', 'read_file', 'write_file', 'search_replace', 'apply_patch',
  'list_dir', 'grep_search', 'file_search', 'todo_write', 'web_fetch', 'web_search', 'grep', 'glob', 'ls',
  'view_file', 'edit_file', 'create_file', 'delete_file',
  'run_terminal_cmd', 'write', 'search_tool', 'use_tool',
];
/**
 * The `--tools` allowlist. It must name a tool the CLI recognizes: an unknown name makes Grok Build
 * 1.0.46 log "tools allowlist had unmappable entries; keeping full grok toolset" and enable every
 * remaining native tool. `read_file` is recognized and also denied above, so the session registers no tools at
 * all (verified October 30, 2026: tool_count=0, empty tool_definitions).
 */
const ALLOWED_TOOLS = 'read_file';
const DENIED_TOOLS = ['Bash', 'Read', 'Grep', 'Edit', 'Write', 'WebFetch', 'MCPTool'];
/** The message the PreToolUse hook (scripts/grok-deny-native.py) returns for every native call. */
export const NATIVE_DENIAL = 'Native Grok actions disabled: Codex owns execution';

/**
 * Each hook denial of a native attempt costs Grok one internal turn. Three left no room after a
 * single denial; six does, and every native attempt must still show a confirmed denial.
 */
const MAX_TURNS = 6;

/** Polling tools are expected to repeat, so the loop guard ignores them. */
const POLLING_TOOLS = new Set(['write_stdin', 'wait', 'sleep', 'clock__sleep', 'wait_agent', 'wait_threads']);
function isPollingTool(name: string): boolean {
  const leaf = name.split('.').at(-1) ?? name;
  // Normalize only Codex's explicit MCP convention, never arbitrary suffixes or read/get tools.
  const poll = /^mcp__[A-Za-z0-9_-]+__(wait_agent|wait_threads)$/.exec(leaf)?.[1] ?? leaf;
  return POLLING_TOOLS.has(poll);
}
const CALL_TYPES = new Set(['function_call', 'custom_tool_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);
const BLOCKED_ENV = /^(XAI_API_KEY|GROK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|PROXY_API_KEY)$/;

/** A Grok refusal. Retryable only when nothing reached Codex; see `retryOnce`. */
export class GrokError extends BackendError {
  constructor(message: string, retryable = false, modelOutput = false) {
    super(message, { retryable, modelOutput });
    this.name = 'GrokError';
  }
}

const grokHome = () => process.env.GROK_HOME ?? join(homedir(), '.grok');

/** A hash of every file that can change how Grok behaves: config, policy, hooks and plugins. */
export function grokProfileHash(): string {
  const home = grokHome();
  const parts: Array<string | Uint8Array> = [];
  const files = [
    join(home, 'config.toml'),
    join(home, 'managed_config.toml'),
    join(home, 'requirements.toml'),
    join(home, '..', 'deny-native.py'),
    '/etc/grok/managed_config.toml',
    '/etc/grok/requirements.toml',
  ];
  for (const path of files) {
    if (existsSync(path)) parts.push(path, readFileSync(path));
  }
  for (const folder of [join(home, 'hooks'), join(home, 'plugins')]) {
    if (existsSync(folder)) hashTree(folder, parts, { files: 0, bytes: 0 }, 0);
  }
  return sha256(Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : part))));
}

const PROFILE_TREE_LIMITS = { depth: 8, files: 2000, bytes: 64 * 1024 * 1024 };

/**
 * Hooks and plugins, recursively. Each entry contributes its path, then a file its bytes or a
 * directory its own entries, so a flat folder hashes exactly as the earlier one-level scan did and
 * existing pins stay valid. A symlink pauses the backend: its target's bytes could change behind an
 * unchanged link, and following it could loop or leave the profile. A tree past the limits also
 * pauses the backend instead of hashing part of it.
 */
function hashTree(folder: string, parts: Array<string | Uint8Array>, seen: { files: number; bytes: number }, depth: number): void {
  if (depth > PROFILE_TREE_LIMITS.depth) throw new GrokError('Grok native profile is nested too deeply to verify; backend paused pending isolation review');
  for (const name of readdirSync(folder).sort()) {
    const file = `${folder}/${name}`;
    parts.push(file);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      throw new GrokError('Grok native profile contains a symlink under hooks or plugins; backend paused pending isolation review');
    } else if (stat.isDirectory()) {
      hashTree(file, parts, seen, depth + 1);
    } else if (stat.isFile()) {
      seen.files += 1;
      seen.bytes += stat.size;
      if (seen.files > PROFILE_TREE_LIMITS.files || seen.bytes > PROFILE_TREE_LIMITS.bytes) {
        throw new GrokError('Grok native profile is too large to verify; backend paused pending isolation review');
      }
      parts.push(readFileSync(file));
    }
  }
}

/** The CLI environment: no API keys, and every optional Grok subsystem switched off. */
export function grokEnvironment(): Record<string, string> {
  const env = childEnvironment((key) => BLOCKED_ENV.test(key));
  Object.assign(env, {
    GROK_HOME: grokHome(),
    GROK_DISABLE_AUTOUPDATER: '1',
    GROK_MEMORY: '0',
    GROK_SUBAGENTS: '0',
    GROK_WORKFLOWS: '0',
    GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: '0',
    GROK_LSP_TOOLS: '0',
    GROK_TELEMETRY_ENABLED: '0',
    GROK_TELEMETRY_TRACE_UPLOAD: '0',
    GROK_TELEMETRY_MIXPANEL_ENABLED: '0',
    // Documented `features.session_search`. Every run otherwise indexes all of the CLI's stored
    // sessions before the request goes out (454 sessions, 147 MB read, 0.8 s warm on October 30,
    // 2026), and each router turn adds one more. The router replays full history and never uses it.
    GROK_SESSION_SEARCH: '0',
  });
  for (const vendor of ['CLAUDE', 'CURSOR', 'CODEX']) {
    for (const kind of ['SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS']) env[`GROK_${vendor}_${kind}_ENABLED`] = '0';
  }
  return env;
}

const JSON_ESCAPES = new Set(['"', '\\', '/', 'n', 'r', 't']);

/**
 * Grok's tool arguments are JSON inside JSON, and long shell commands often break the inner level:
 * raw newlines inside strings, or regex and shell backslashes such as `\.` `\s` `\|` `\$` left
 * undoubled. Inside string literals this escapes raw control characters and keeps any non-JSON
 * escape as a literal backslash, which is what the command meant. `\b` and `\f` also stay literal:
 * in a command they are regex word boundaries, never backspace or form feed. Text outside string
 * literals is never touched, so broken structure still fails closed.
 */
export function repairJsonStrings(raw: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
    } else if (ch === '"') {
      out += ch;
      inString = false;
    } else if (ch === '\\') {
      const next = raw[i + 1] ?? '';
      if (JSON_ESCAPES.has(next)) {
        out += ch + next;
        i++;
      } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
        out += raw.slice(i, i + 6);
        i += 5;
      } else {
        out += '\\\\';
      }
    } else {
      const code = ch.charCodeAt(0);
      out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
    }
  }
  return out;
}

/** Valid JSON is authoritative. Repairs are only a fallback for invalid string escaping. */
function parseArgumentJson(raw: string): { value: unknown; serialized: string } {
  try { return { value: JSON.parse(raw) as unknown, serialized: raw }; }
  catch {
    const serialized = repairJsonStrings(raw);
    return { value: JSON.parse(serialized) as unknown, serialized };
  }
}

/**
 * Returns the exact JSON object string Codex will receive, or throws a retryable refusal. Nothing
 * has executed at this point, so a refusal is always safe to retry.
 */
export function functionArguments(raw: string): string {
  let value: unknown;
  let serialized: string;
  try {
    ({ value, serialized } = parseArgumentJson(raw));
  } catch (error) {
    const trimmed = raw.trim();
    logSafe('grok-invalid-arguments', {
      bytes: raw.length,
      starts_object: trimmed.startsWith('{'),
      ends_object: trimmed.endsWith('}'),
      control_chars: /[\u0000-\u001f]/.test(raw),
      backslashes: (raw.match(/\\/g) ?? []).length,
      quotes: (raw.match(/"/g) ?? []).length,
      error: (error instanceof Error ? error.message : 'parse').replace(/[^A-Za-z ]+.*$/, '').slice(0, 60),
    });
    throw new GrokError('Grok returned invalid tool arguments; no tools were executed', true, true);
  }

  let result: string | undefined;
  if (isRecord(value)) {
    result = serialized;
  } else if (typeof value === 'string') {
    // Double-encoded: a JSON string whose content is the real object.
    try {
      const inner = parseArgumentJson(value);
      if (isRecord(inner.value)) result = inner.serialized;
    } catch {}
  }
  if (result === undefined) throw new GrokError('Grok tool arguments must be a JSON object; no tools were executed', true, true);
  if (result !== raw) logSafe('grok-arguments-repaired', { bytes: raw.length });
  return result;
}

/**
 * Grok sometimes swaps a parameter name (`command` for `cmd`), which Codex rejects after the turn.
 * A missing required field becomes a retry that names the mistake. Undeclared extras (Grok likes
 * adding `description`) carry no meaning for the tool, so they are dropped instead.
 */
export function checkArgumentShape(name: string, raw: string, contract: unknown): string {
  let args: unknown;
  try { args = JSON.parse(raw); } catch { throw new GrokError('Grok returned invalid tool arguments; no tools were executed', true, true); }
  if (!isRecord(args)) throw new GrokError('Grok tool arguments must be a JSON object; no tools were executed', true, true);
  const properties = isRecord(contract) && isRecord(contract.properties) ? contract.properties : undefined;
  const declared = properties ? Object.keys(properties) : [];
  const required = isRecord(contract) && Array.isArray(contract.required) ? contract.required.filter((key): key is string => typeof key === 'string') : [];
  const missing = required.filter(key => !Object.hasOwn(args, key));
  const unexpected = properties && isRecord(contract) && contract.additionalProperties === false && !contract.patternProperties ? Object.keys(args).filter(key => !Object.hasOwn(properties, key)) : [];
  const fieldName = (key: string) => (/^[A-Za-z0-9_.-]{1,64}$/.test(key) ? key : '(invalid name)');
  if (missing.length) {
    logSafe('grok-argument-shape', { tool: name, missing: missing.length, dropped: 0 });
    const got = unexpected.length ? `; got ${unexpected.map(fieldName).join(', ')}` : '';
    throw new GrokError(`Grok called ${name} without its required ${missing.map(fieldName).join(', ')}${got}. Its parameters are ${declared.map(fieldName).join(', ')}; no tools were executed`, true, true);
  }
  // Preserve the existing harmless-extra tolerance at the top level. Nested contracts are checked
  // recursively, including required fields, unions, arrays, types, enums and additional properties.
  for (const key of unexpected) delete args[key];
  const issue = toolSchemaIssue(args, contract);
  if (issue) {
    logSafe('grok-argument-shape', { tool: name, missing: 0, dropped: unexpected.length, invalid: true });
    throw new GrokError(`Grok called ${name} with invalid ${issue}; no tools were executed`, true, true);
  }
  if (unexpected.length) { logSafe('grok-argument-shape', { tool: name, missing: 0, dropped: unexpected.length }); return JSON.stringify(args); }
  return raw;
}

type CompletedCall = { name: string; args: string; callId: string; output: string };

const callName = (item: ResponseInputItem) => {
  const name = String(item.name);
  return item.namespace && !name.startsWith(item.namespace + '.') ? `${item.namespace}.${name}` : name;
};
const outputText = (item: ResponseInputItem) =>
  typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
// Volatile headers such as chunk ids and timings differ between identical runs.
const stableOutput = (text: string) => {
  const output = /^(?:Output|Final output):\s*$/m.exec(text);
  if (!output) return text.trim();
  return (text.slice(0, output.index).replace(/^(Chunk ID|Wall time):.*$/gm, '') + text.slice(output.index)).trim();
};

function completedCalls(request: ResponsesRequest): CompletedCall[] {
  const input = Array.isArray(request.input) ? request.input : [];
  const calls = new Map<string, { name: string; args: string }>();
  const completed = new Map<string, CompletedCall>();
  for (const item of input) {
    if (typeof item.call_id !== 'string' || !item.call_id) continue;
    if (CALL_TYPES.has(item.type ?? '')) {
      const args = typeof item.arguments === 'string' ? item.arguments : typeof item.input === 'string' ? item.input : JSON.stringify(item.arguments ?? {});
      calls.set(item.call_id, { name: callName(item), args });
    } else if (OUTPUT_TYPES.has(item.type ?? '')) {
      const call = calls.get(item.call_id);
      if (call) { completed.delete(item.call_id); completed.set(item.call_id, { ...call, callId: item.call_id, output: outputText(item) }); }
    }
  }
  return [...completed.values()];
}

/**
 * Grok's prompt puts the tool list after the conversation, so the newest tool result can sit far
 * from the end and Grok re-runs a command it already has. A call identical to the last two calls,
 * which returned the same result, is refused before it reaches Codex.
 */
export function assertNotLooping(request: ResponsesRequest, toolCalls: Array<{ name: string; arguments: string }>): void {
  const input = Array.isArray(request.input) ? request.input : [];
  // A new instruction is fresh intent even when it asks for the same action. Historical receipts
  // are evidence for the model, never a reason to refuse a user's explicit recheck.
  let boundary = -1;
  for (let i = input.length - 1; i >= 0; i--) if (['user', 'developer', 'system'].includes(input[i]?.role ?? '') || input[i]?.type === 'agent_message') { boundary = i; break; }
  const [before, last] = completedCalls({ ...request, input: input.slice(boundary + 1) }).slice(-2);
  if (!before || !last) return;
  const declared = new Map(toolDescriptors(requestTools(request)).map(tool => [tool.proxyName, tool]));
  const canonicalName = (name: string) => !declared.has(name) && name.startsWith('functions.') && declared.has(name.slice(10)) ? name.slice(10) : name;
  for (const call of toolCalls) {
    if (isPollingTool(call.name)) continue;
    const same = (prior: CompletedCall) => {
      if (canonicalName(prior.name) !== canonicalName(call.name)) return false;
      if (prior.args === call.arguments) return true;
      if (declared.get(canonicalName(call.name))?.type !== 'function') return false;
      try { return sameToolArguments(JSON.parse(prior.args) as unknown, JSON.parse(call.arguments) as unknown); } catch { return false; }
    };
    if (same(before) && same(last) && stableOutput(before.output) === stableOutput(last.output)) {
      logSafe('grok-repeat-guard', { tool: call.name, bytes: call.arguments.length });
      throw new GrokError(
        `Grok repeated ${call.name} with identical arguments a third time; its result (call_id ${last.callId}) is already in the conversation. Use that result and take the next step`,
        true, true,
      );
    }
  }
}

/** Repeats the newest completed step at the very end of the prompt, where Grok attends most. */
export function latestStepRecap(request: ResponsesRequest): string {
  const last = completedCalls(request).at(-1);
  const lastItem = Array.isArray(request.input) ? request.input.at(-1) : undefined;
  if (!last || !lastItem || !OUTPUT_TYPES.has(lastItem.type ?? '') || lastItem.call_id !== last.callId) return '';
  const output = last.output.length > 8000 ? `${last.output.slice(0, 8000)}\n[truncated; the full result is above]` : last.output;
  const next = isPollingTool(last.name)
    ? 'This is a polling/wait tool. If the work is still running or pending, or the wait timed out, continue waiting with this Codex tool. Identical polling arguments are allowed. If it reports completion, use the actual result and continue any remaining requested work. Finish only when the user\'s task is complete. Do not emulate agent waits with shell commands or a nested CLI.'
    : 'Continue from this result. Do not repeat an identical call unless something has changed since.';
  return `\n\n<latest_step>\nYour most recent action was ${last.name} (call_id ${last.callId}) with arguments:\n${last.args.slice(0, 2000)}\nIts result, also shown in full above:\n${output}\n${next}\n</latest_step>`;
}

function toolCallArguments(call: JsonRecord, descriptor: ToolDescriptor): string {
  const fields = ['arguments', 'input', 'parameters'].filter(key => Object.hasOwn(call, key));
  if (fields.length !== 1) throw new GrokError('Grok returned conflicting or missing tool arguments; no tools were executed', true, true);
  const value = call[fields[0]!];
  if (descriptor.type === 'custom') {
    if (typeof value === 'string') return value;
    if (isRecord(value)) {
      const metadata = new Set(['call_id', 'id', 'type']);
      const payload = Object.keys(value).filter(key => !metadata.has(key));
      if (payload.length === 1 && ['arguments', 'argument', 'input', 'code', 'source', 'patch', 'content', 'raw', 'value'].includes(payload[0]!) && typeof value[payload[0]!] === 'string') {
        logSafe('grok-custom-args-unwrapped', { tool: descriptor.proxyName });
        return value[payload[0]!] as string;
      }
    }
    throw new GrokError('Grok requested an unavailable or malformed tool; no tools were executed', true, true);
  }
  if (isRecord(value)) return checkArgumentShape(descriptor.proxyName, JSON.stringify(value), descriptor.contract);
  if (typeof value !== 'string') throw new GrokError('Grok requested an unavailable or malformed tool; no tools were executed', true, true);
  return checkArgumentShape(descriptor.proxyName, functionArguments(value), descriptor.contract);
}

/** Validates Grok's structured output and turns it into the calls Codex will run. */
export function parseGrokOutput(text: string, request: ResponsesRequest): ProxyOutput {
  let value: unknown;
  try {
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text.trim());
    const candidate = fenced ? fenced[1]!.trim() : text;
    const parsed = parseArgumentJson(candidate);
    value = parsed.value;
    if (fenced || parsed.serialized !== candidate) logSafe('grok-output-repaired', { category: fenced ? 'fence' : 'strings', bytes: text.length });
  } catch {
    throw new GrokError('Grok returned invalid structured output; no tools were executed', true, true);
  }
  if (
    !isRecord(value) ||
    typeof value.text !== 'string' ||
    !Array.isArray(value.tool_calls) ||
    value.tool_calls.length > MAX_TOOL_CALLS ||
    Object.keys(value).some((key) => key !== 'text' && key !== 'tool_calls')
  ) {
    throw new GrokError('Grok returned invalid structured output; no tools were executed', true, true);
  }

  const allowed = new Map(toolDescriptors(requestTools(request)).map((tool) => [tool.proxyName, tool]));
  const toolCalls: ToolCall[] = value.tool_calls.map((call: unknown) => {
    if (!isRecord(call)) throw new GrokError('Grok requested an unavailable or malformed tool; no tools were executed', true, true);
    const inner = isRecord(call.function) ? call.function : call;
    if (inner !== call && (['arguments', 'input', 'parameters'].some(key => Object.hasOwn(call, key)) || call.name !== undefined && call.name !== inner.name || call.namespace !== undefined && inner.namespace !== undefined && call.namespace !== inner.namespace)) {
      throw new GrokError('Grok returned conflicting tool envelopes; no tools were executed', true, true);
    }
    let name = typeof inner.name === 'string' ? inner.name : '';
    const namespace = typeof inner.namespace === 'string' ? inner.namespace : typeof call.namespace === 'string' ? call.namespace : undefined;
    if (namespace && !name.startsWith(namespace + '.')) name = namespace + '.' + name;
    if (!allowed.has(name) && name.startsWith('functions.') && allowed.has(name.slice(10))) name = name.slice(10);
    const descriptor = allowed.get(name);
    if (!descriptor) {
      throw new GrokError('Grok requested an unavailable or malformed tool; no tools were executed', true, true);
    }
    return { name: descriptor.proxyName, arguments: toolCallArguments(inner, descriptor), callId: randomId('call') };
  });
  assertNotLooping(request, toolCalls);

  const inputTokens = estimateVisibleTokens(requestToPrompt(request));
  const outputTokens = estimateVisibleTokens(value.text + JSON.stringify(toolCalls));
  return { text: value.text, toolCalls, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
}

/**
 * Arguments as a string meant JSON inside JSON, and Grok kept breaking the inner level. Letting
 * function arguments be a real object means the structured-output layer validates them once.
 */
export function grokOutputSchema(tools: ResponseTool[]): Record<string, unknown> {
  const schema = outputSchema(tools);
  const toolCalls = (schema.properties as JsonRecord).tool_calls;
  const items = isRecord(toolCalls) && isRecord(toolCalls.items) ? toolCalls.items : undefined;
  if (isRecord(toolCalls)) toolCalls.maxItems = typeof toolCalls.maxItems === 'number' ? Math.min(toolCalls.maxItems, MAX_TOOL_CALLS) : MAX_TOOL_CALLS;
  if (items && isRecord(items.properties)) items.properties.arguments = toolDescriptors(tools).every(tool => tool.type === 'custom') ? { type: 'string' } : { anyOf: [{ type: 'object' }, { type: 'string' }] };
  return schema;
}

const ARGUMENT_RULES =
  ' Each arguments value is a JSON string that itself contains JSON, so inside it every backslash must be written as \\\\ and every double quote inside a value as \\". For example, the shell regex a\\.b inside a command becomes a\\\\.b in the inner JSON.';
const SYSTEM_PROMPT = `You are the model inside the Codex external agent loop. The listed Codex tools are real, available tools. Request them using the exact name and arguments in the required structured tool_calls JSON output. Your output must be an object with text (string) and tool_calls (array). Each call must have name (exact listed string) and arguments. For a function tool, arguments is the JSON object with the tool parameters, written directly as an object, not a second JSON encoding. For a custom tool, arguments is the exact raw input string. Ordinary JSON escaping still applies to string values; do not add an extra JSON-encoding layer to function objects. Your native Grok tools, search and subagents are disabled; the listed Codex tools are not. When Codex lists collaboration.spawn_agent, wait_agent or other collaboration tools, use those tools directly to create or wait for helpers. Do not emulate a Codex subagent or poll for it with shell commands or a nested CLI. Use a completed helper response without polling it again, then continue any remaining requested work. Finish only when the user's whole task is complete. To run a command or read a file, return the listed Codex tool (for example exec_command) in tool_calls; Codex owns all execution. Never claim a tool executed without its result in history.`;

/** Headless flags: `--tools` only takes effect in headless mode, never under ACP. */
function grokArgs(dir: string, effort: string, request: ResponsesRequest, promptFile: string, retryNote: string): string[] {
  return [
    '--cwd', dir,
    '-m', MODEL,
    '--effort', effort,
    '--permission-mode', 'dontAsk',
    '--tools', ALLOWED_TOOLS,
    ...DENIED_TOOLS.flatMap((tool) => ['--deny', tool]),
    '--disallowed-tools', NATIVE_TOOLS.join(','),
    '--no-plan',
    '--no-subagents',
    '--disable-web-search',
    '--max-turns', String(MAX_TURNS),
    '--system-prompt-override', SYSTEM_PROMPT + retryNote,
    '--json-schema', JSON.stringify(grokOutputSchema(requestTools(request))),
    '--output-format', 'streaming-messages-json',
    // Raw `stream_event` deltas keep stdout live while the model thinks, so the run can be bounded
    // by silence instead of a total deadline. `interpretRun` only reads `assistant`/`result` records.
    '--include-partial-messages',
    '--prompt-file', promptFile,
    // Without it the CLI replaces any prompt over about 100 KB with an excerpt plus a pointer to an
    // archived copy, hiding the newest history and the tool list (verified to 614 KB with it).
    '--verbatim',
  ];
}

/** Refuses anything Grok cannot consume faithfully before a process starts. Returns the effort. */
function assertGrokRequest(request: ResponsesRequest): string {
  if (request.model !== MODEL) throw new GrokError('Unsupported Grok model');
  const effort = request.reasoning?.effort ?? 'high';
  if (!(EFFORTS as readonly string[]).includes(effort)) throw new GrokError('Unsupported Grok reasoning effort');

  const input = Array.isArray(request.input) ? request.input : [];
  // Ciphertext must never become a misleading placeholder in a foreign model's context.
  const encryptedHandoff = input.some(
    (item) =>
      item.type === 'agent_message' &&
      Array.isArray(item.content) &&
      item.content.some((part) => part.type === 'encrypted_content' && part.encrypted_content?.startsWith('gAAAA')),
  );
  if (encryptedHandoff) throw new GrokError('Grok cannot read encrypted GPT subagent content; use a plaintext handoff or GPT');
  if (input.some((item) => ['compaction', 'compaction_summary', 'context_compaction'].includes(item.type ?? ''))) {
    throw new GrokError('Grok received unrestored compaction; continue with the prior model');
  }

  // Only recognized attachment parts are refused. Ordinary tool JSON that merely mentions a URL or a
  // file id is text and stays in the prompt; inline and remote images are handled by preparePrompt.
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspect);
    } else if (isRecord(value)) {
      const type = String(value.type);
      if (MEDIA_PARTS.has(type) || (IMAGE_PARTS.has(type) && value.file_id !== undefined)) {
        throw new GrokError('Grok bridge cannot safely consume this attachment; use GPT or Claude');
      }
      Object.values(value).forEach(inspect);
    }
  };
  inspect(request.input);
  return effort;
}
const MEDIA_PARTS = new Set(['input_file', 'input_audio', 'audio', 'file', 'input_video', 'video']);
/** An uploaded image referenced by id carries no inline data, so it would vanish from the prompt. */
const IMAGE_PARTS = new Set(['input_image', 'image']);

/**
 * The pinned binary's hash, recomputed only when the file's identity or timestamps change. Hashing
 * the 150 MB CLI cost about 60 ms and a 150 MB allocation on every attempt; a replaced, rewritten or
 * re-permissioned file changes its inode, size, mtime or ctime and is hashed again before it runs.
 */
let pinnedBinary: { key: string; hash: string } | undefined;
function pinnedBinaryHash(binary: string): string {
  const stat = statSync(binary);
  const key = [binary, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  if (pinnedBinary?.key !== key) pinnedBinary = { key, hash: sha256(readFileSync(binary)) };
  return pinnedBinary.hash;
}

/** Integrity gates: a changed native profile or binary pauses the backend until it is reviewed. */
function grokInstallation(): { binary: string; cwd: string } {
  const { GROK_BIN: binary, GROK_CWD: cwd, GROK_PROFILE_SHA256: profileHash, GROK_BIN_SHA256: binaryHash } = process.env;
  if (profileHash && grokProfileHash() !== profileHash) {
    throw new GrokError('Grok native configuration changed; backend paused pending isolation review');
  }
  if (binary && binaryHash && pinnedBinaryHash(binary) !== binaryHash) throw new GrokError('Grok pinned binary changed; backend paused');
  if (!binary || !cwd) throw new GrokError('Grok Build backend is not configured');
  return { binary, cwd };
}

function jsonLines(stdout: string): JsonRecord[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return isRecord(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The CLI's own wording when its subscription login is gone: an expired session whose refresh token
 * was rejected (the CLI then deletes auth.json), or no login at all. Retrying cannot help, and the
 * shared classifier's `log.in` does not match the one-word `login`, so this used to read as a generic
 * retried "process failed". Only stderr and CLI status records are tested, never model text.
 */
const LOGIN_REQUIRED = /grok login|session has expired|not logged in|XAI_API_KEY|ManualLogin|RefreshTokenRejected/i;
const loginRequired = (exit?: number) =>
  new GrokError(`Grok Build is signed out${exit === undefined ? '' : ` (exit ${exit})`}: its isolated login expired or was rejected. Sign in again with \`grok login\` using the router's GROK_HOME; no automatic fallback`);

/**
 * A non-zero exit is classified from stderr and the CLI's own status records only, because stdout
 * also carries model text that can mention any word.
 */
function exitFailure(exit: number, stdout: string, stderr: string): Error {
  const records = jsonLines(stdout);
  const status = records
    .filter((record) => record.type === 'result' || record.type === 'error' || record.is_error === true)
    .map((record) =>
      JSON.stringify({
        type: record.type,
        subtype: record.subtype,
        error: record.error,
        stop: record.stop_reason ?? record.stopReason,
        result: record.is_error ? record.result : undefined,
      }),
    );
  if (LOGIN_REQUIRED.test(`${stderr}\n${status.join('\n')}`)) {
    logSafe('grok-exit', { exit, category: 'login required', records: records.length });
    return loginRequired(exit);
  }
  const { category, retryable } = classifyCliFailure(`${stderr}\n${status.join('\n')}`);
  if (CONTEXT_OVERFLOW_TEXT.test(`${stderr}\n${status.join('\n')}`)) return contextOverflowError('Grok Build');
  // The CLI could not reach xAI: the router's shared offline policy keeps the request pending
  // and retries it, exactly as for every other backend. The fixed transport message hides stderr.
  const network = transportError(new Error(`${stderr}\n${status.join('\n')}`));
  if (network?.reconnectable) { logSafe('grok-exit', { exit, category: 'network', records: records.length }); return network; }
  logSafe('grok-exit', {
    exit,
    category,
    records: records.length,
    last_type: String(records.at(-1)?.type ?? ''),
    has_result: records.some((record) => record.type === 'result'),
    stderr_hint: stderr.trim().split(/\r?\n/).at(-1) ?? '',
  });
  return new GrokError(`Grok Build ${category} (exit ${exit}); no automatic fallback`, retryable);
}

const contentParts = (record: JsonRecord): JsonRecord[] => {
  const content = isRecord(record.message) ? record.message.content : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
};

/**
 * Reads a finished run. Every native tool attempt must have been denied by the hook and the turn
 * must have ended cleanly within its budget; otherwise nothing is returned to Codex.
 */
function interpretRun(stdout: string, request: ResponsesRequest): ProxyOutput {
  let records: unknown[];
  try {
    records = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
  } catch {
    throw new GrokError('Grok Build returned invalid output', true);
  }
  const events = records.filter(isRecord);
  const nativeCalls = events.filter((event) => event.type === 'assistant').flatMap(contentParts).filter((part) => part.type === 'tool_use');
  const nativeResults = events.flatMap(contentParts).filter((part) => part.type === 'tool_result');
  const denied = (call: JsonRecord) =>
    nativeResults.some(
      (result) => result.tool_use_id === call.id && result.is_error === true && JSON.stringify(result.content).includes(NATIVE_DENIAL),
    );
  // Unconfirmed native execution is a safety failure, never retried.
  if (events.some((event) => /auto_compact|compaction/.test(String(event.type ?? ''))) || nativeCalls.some((call) => !denied(call))) {
    logSafe('grok-native-guard');
    throw new GrokError('Grok attempted native compaction or unconfirmed native execution; no Codex actions were returned');
  }

  const result = [...events].reverse().find((event) => event.type === 'result') ?? events.at(-1) ?? {};
  const stop = result.stop_reason ?? result.stopReason;
  const turns = result.num_turns;
  const structured = result.structured_output ?? result.structuredOutput;
  const validTurns = typeof turns === 'number' && Number.isInteger(turns) && turns >= 1 && turns <= MAX_TURNS;
  if (stop !== 'end_turn' || result.is_error || !validTurns) {
    // A CLI-reported error is classified from the CLI's own result record, never model text: auth
    // and quota surface immediately, anything else gets the one retry.
    const errorText = result.is_error
      ? [result.subtype, result.error, result.result].filter((part): part is string => typeof part === 'string').join(' ')
      : '';
    const failure = result.is_error ? classifyCliFailure(errorText) : undefined;
    if (result.is_error && LOGIN_REQUIRED.test(errorText)) {
      logSafe('grok-invalid-turn', { stop: String(stop), is_error: true, category: 'login required' });
      throw loginRequired();
    }
    const network = result.is_error ? transportError(new Error(errorText)) : undefined;
    logSafe('grok-invalid-turn', {
      stop: String(stop),
      turns: typeof turns === 'number' && Number.isInteger(turns) ? turns : null,
      is_error: !!result.is_error,
      category: failure?.category ?? null,
      subtype: String(result.subtype ?? ''),
      denied_native: nativeCalls.length,
      structured: !!structured,
      hint: errorText.slice(0, 120),
    });
    // Resending an oversized prompt can never succeed; give Codex its native overflow code. This comes
    // before the quota and network checks: overflow text can carry a 429-like token count or a "fetch
    // failed" prefix, and reading it as an outage would resend the same prompt forever.
    if (CONTEXT_OVERFLOW_TEXT.test(errorText)) throw contextOverflowError('Grok Build');
    if (failure && !failure.retryable) throw new GrokError(`Grok Build ${failure.category}; no automatic fallback`);
    // A network failure reported in-band is an outage, not a bad turn: pending retry, never a refusal.
    if (network?.reconnectable) throw network;
    if (OVERLOADED_TEXT.test(errorText)) throw overloadedError('Grok Build');
    throw new GrokError(
      nativeCalls.length
        ? 'Grok did not complete a valid constrained turn (it tried disabled native tools; return Codex tool_calls instead)'
        : 'Grok did not complete a valid constrained turn',
      true,
    );
  }
  const text = structured ? JSON.stringify(structured) : String(result.result ?? result.text ?? '');
  return parseGrokOutput(text, request);
}

async function readCapped(stream: ReadableStream<Uint8Array>, keepAll: boolean, onOverflow: () => void, onChunk?: (chunk: Uint8Array) => void): Promise<string> {
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for await (const chunk of stream) {
    onChunk?.(chunk);
    total += chunk.length;
    if (total > MAX_OUTPUT_BYTES) {
      onOverflow();
      throw new GrokError('Grok output exceeded safety limit');
    }
    text = (text + decoder.decode(chunk, { stream: true })).slice(keepAll ? 0 : -65_536);
  }
  return text + decoder.decode();
}

/**
 * Each CLI runs as the leader of its own process group, so ending a run also ends any helper it
 * started (hooks, tool servers) instead of leaving them holding our pipes. Groups still alive when
 * the router exits are killed with it.
 */
const liveGroups = new Set<number>();
process.once('exit', () => { for (const pid of liveGroups) signalGroup(pid, 'SIGKILL'); });
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch {}
}

/**
 * One isolated CLI session per attempt: a private directory and prompt file, never reused between
 * parent and child agents. Everything created here, processes included, is removed on every exit path.
 */
async function runGrokOnce(request: ResponsesRequest, signal?: AbortSignal, retryNote = ''): Promise<ProxyOutput> {
  signal?.throwIfAborted();
  const effort = assertGrokRequest(request);
  let prepared: ReturnType<typeof preparePrompt>;
  // A remote image URL is never fetched; refuse it as a Grok attachment, not a generic failure.
  try { prepared = preparePrompt(request); }
  catch { throw new GrokError('This Grok bridge supports no image input; switch to GPT or Claude for this conversation'); }
  if (prepared.images.length) throw new GrokError('This Grok bridge supports no image input; switch to GPT or Claude for this conversation');

  let dir: string | undefined;
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let exited = false;
  let aborted = false;
  let timedOut = false;
  // SIGTERM first so the CLI can close its session; a CLI that ignores it is killed after the grace.
  const stop = () => {
    if (!proc || escalation) return;
    const { pid } = proc;
    signalGroup(pid, 'SIGTERM');
    escalation = setTimeout(() => signalGroup(pid, 'SIGKILL'), nonNegativeInt('GROK_KILL_GRACE_MS', 2000));
  };
  const cancel = () => {
    aborted = true;
    stop();
  };
  try {
    const { binary, cwd } = grokInstallation();
    dir = await mkdtemp(join(cwd, 'request-'));
    await chmod(dir, 0o700);
    const promptFile = join(dir, 'prompt.txt');
    // The prompt is written verbatim: user text, tool output and code reach Grok exactly as Codex sent them.
    const prompt = prepared.prompt + latestStepRecap(request);
    await writeFile(promptFile, prompt, { mode: 0o600 });
    signal?.throwIfAborted();

    proc = Bun.spawn([binary, ...grokArgs(dir, effort, request, promptFile, retryNote)], {
      cwd: dir,
      env: grokEnvironment(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    const { pid } = proc;
    liveGroups.add(pid);
    // Once the CLI itself has exited nothing in its group has legitimate work left, and a straggler
    // would keep stdout open. Its already-written output stays readable in the pipe.
    void proc.exited.then(() => { exited = true; signalGroup(pid, 'SIGKILL'); });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    // Bound the run by silence, like native Codex (DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300 s): every
    // stdout/stderr chunk restarts the window. A total deadline cut long xhigh turns mid-answer.
    const idleMs = positiveInt('GROK_TIMEOUT_MS', 300_000);
    const touch = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, idleMs);
    };
    touch();

    // Content-free phase timing: when the CLI first wrote, when its result record arrived, when it exited.
    const spawned = performance.now();
    let firstOutput: number | undefined, resultAt: number | undefined, exitAt: number | undefined;
    void proc.exited.then(() => { exitAt = performance.now(); });
    const resultMarker = new TextDecoder();
    const onStdout = (chunk: Uint8Array) => {
      touch();
      firstOutput ??= performance.now();
      if (resultAt === undefined && resultMarker.decode(chunk, { stream: true }).includes('"type":"result"')) resultAt = performance.now();
    };
    const [stdout, stderr, exit] = await Promise.all([
      readCapped(proc.stdout, true, stop, onStdout),
      readCapped(proc.stderr, false, stop, touch),
      proc.exited,
    ]);
    const since = (at: number | undefined) => (at === undefined ? null : Math.round(at - spawned));
    logSafe('grok-turn-phases', { first_output_ms: since(firstOutput), result_ms: since(resultAt), exit_ms: since(exitAt), drained_ms: since(performance.now()), exit, retry: retryNote !== '' });
    if (aborted) throw new GrokError('Grok request cancelled');
    if (timedOut) throw new GrokError(`Grok Build request timed out after ${Math.round(idleMs / 1000)}s without output; no automatic model fallback`, true);
    if (exit !== 0) throw exitFailure(exit, stdout, stderr);
    return interpretRun(stdout, request);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    if (proc) {
      // Every early exit (overflow, cancel, a thrown check) ends the whole group without a grace.
      if (!exited) signalGroup(proc.pid, 'SIGKILL');
      await proc.exited;
      signalGroup(proc.pid, 'SIGKILL');
      clearTimeout(escalation);
      liveGroups.delete(proc.pid);
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

export function runGrok(request: ResponsesRequest, signal?: AbortSignal): Promise<ProxyOutput> {
  return retryOnce('grok', signal, (retryNote) => runGrokOnce(request, signal, retryNote));
}

export const grokBackend: SubscriptionBackend = {
  name: 'Grok',
  models: { [MODEL]: MODEL },
  reservedPrefix: 'grok-',
  catalog: [
    {
      slug: MODEL,
      displayName: 'Grok 4.7',
      description: 'Grok 4.7 through your Grok Build subscription (text only)',
      efforts: EFFORTS,
      defaultEffort: 'high',
      inputModalities: ['text'],
    },
  ],
  run: runGrok,
};
