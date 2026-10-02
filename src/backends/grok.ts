// Grok through the official Grok Build CLI. Subscription access stays with the CLI; its OAuth token
// is never read or forwarded. Every turn runs in a fresh, private directory with native tools
// removed, denied and hooked, so Codex remains the only thing that executes actions.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { positiveInt } from '../env';
import { isRecord, type JsonRecord, randomId, sha256 } from '../json';
import { logSafe } from '../log';
import { outputSchema, preparePrompt, requestToPrompt, type ToolDescriptor, toolDescriptors } from '../protocol/prompt';
import type { ProxyOutput, ResponseInputItem, ResponsesRequest, ResponseTool, ToolCall } from '../protocol/types';
import { BackendError, classifyCliFailure, estimateVisibleTokens, retryOnce, type SubscriptionBackend } from './contract';

const MODEL = 'grok-4.7';
const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_TOOL_CALLS = 64;

/** Grok's own tool names. `--tools` alone does not hide them, so they are also disallowed. */
const NATIVE_TOOLS = [
  'Agent', 'bash', 'run_terminal_command', 'read_file', 'write_file', 'search_replace', 'apply_patch',
  'list_dir', 'grep_search', 'file_search', 'todo_write', 'web_fetch', 'web_search', 'grep', 'glob', 'ls',
  'view_file', 'edit_file', 'create_file', 'delete_file',
];
const DENIED_TOOLS = ['Bash', 'Read', 'Grep', 'Edit', 'Write', 'WebFetch', 'MCPTool'];
/** The message the PreToolUse hook (scripts/grok-deny-native.py) returns for every native call. */
export const NATIVE_DENIAL = 'Native Grok actions disabled: Codex owns execution';

/**
 * Each hook denial of a native attempt costs Grok one internal turn. Three left no room after a
 * single denial; six does, and every native attempt must still show a confirmed denial.
 */
const MAX_TURNS = 6;

/** Polling tools are expected to repeat, so the loop guard ignores them. */
const POLLING_TOOLS = new Set(['write_stdin', 'wait', 'clock.sleep', 'sleep']);
const CALL_TYPES = new Set(['function_call', 'custom_tool_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);
const BLOCKED_ENV = /^(XAI_API_KEY|GROK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|PROXY_API_KEY)$/;

/** A Grok refusal. Retryable only when nothing reached Codex; see `retryOnce`. */
export class GrokError extends BackendError {
  constructor(message: string, retryable = false) {
    super(message, { retryable });
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
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).sort()) {
      const file = `${folder}/${name}`;
      parts.push(file);
      try {
        parts.push(readFileSync(file));
      } catch {}
    }
  }
  return sha256(Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : part))));
}

/** The CLI environment: no API keys, and every optional Grok subsystem switched off. */
export function grokEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BLOCKED_ENV.test(key)) env[key] = value;
  }
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

/**
 * Returns the exact JSON object string Codex will receive, or throws a retryable refusal. Nothing
 * has executed at this point, so a refusal is always safe to retry.
 */
export function functionArguments(raw: string): string {
  const repaired = repairJsonStrings(raw);
  let value: unknown;
  try {
    value = JSON.parse(repaired);
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
    throw new GrokError('Grok returned invalid tool arguments; no tools were executed', true);
  }

  let result: string | undefined;
  if (isRecord(value)) {
    result = repaired;
  } else if (typeof value === 'string') {
    // Double-encoded: a JSON string whose content is the real object.
    const inner = repairJsonStrings(value);
    try {
      if (isRecord(JSON.parse(inner))) result = inner;
    } catch {}
  }
  if (result === undefined) throw new GrokError('Grok tool arguments must be a JSON object; no tools were executed', true);
  if (result !== raw) logSafe('grok-arguments-repaired', { bytes: raw.length });
  return result;
}

/**
 * Grok sometimes swaps a parameter name (`command` for `cmd`), which Codex rejects after the turn.
 * A missing required field becomes a retry that names the mistake. Undeclared extras (Grok likes
 * adding `description`) carry no meaning for the tool, so they are dropped instead.
 */
export function checkArgumentShape(name: string, raw: string, contract: unknown): string {
  if (!isRecord(contract) || !isRecord(contract.properties)) return raw;
  const args = JSON.parse(raw) as JsonRecord;
  const declared = Object.keys(contract.properties);
  const required = Array.isArray(contract.required) ? contract.required.filter((key): key is string => typeof key === 'string') : [];
  const missing = required.filter((key) => !(key in args));
  const unexpected = contract.additionalProperties === false ? Object.keys(args).filter((key) => !declared.includes(key)) : [];
  if (!missing.length && !unexpected.length) return raw;

  logSafe('grok-argument-shape', { tool: name, missing: missing.length, dropped: missing.length ? 0 : unexpected.length });
  if (!missing.length) {
    for (const key of unexpected) delete args[key];
    return JSON.stringify(args);
  }
  const fieldName = (key: string) => (/^[A-Za-z0-9_.-]{1,64}$/.test(key) ? key : '(invalid name)');
  const got = unexpected.length ? `; got ${unexpected.map(fieldName).join(', ')}` : '';
  throw new GrokError(
    `Grok called ${name} without its required ${missing.map(fieldName).join(', ')}${got}. Its parameters are ${declared.join(', ')}; no tools were executed`,
    true,
  );
}

type CompletedCall = { name: string; args: string; callId: string; output: string };

const callName = (item: ResponseInputItem) => (item.namespace ? `${item.namespace}.${item.name}` : String(item.name));
const outputText = (item: ResponseInputItem) =>
  typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
// Volatile headers such as chunk ids and timings differ between identical runs.
const stableOutput = (text: string) => text.replace(/^(Chunk ID|Wall time):.*$/gm, '').trim();

function completedCalls(request: ResponsesRequest): CompletedCall[] {
  const input = Array.isArray(request.input) ? request.input : [];
  const outputs = new Map(input.filter((item) => OUTPUT_TYPES.has(item.type ?? '')).map((item) => [item.call_id, outputText(item)]));
  return input.flatMap((item) => {
    const output = outputs.get(item.call_id);
    if (!CALL_TYPES.has(item.type ?? '') || output === undefined) return [];
    const args = typeof item.arguments === 'string' ? item.arguments : (item.input ?? '');
    return [{ name: callName(item), args, callId: String(item.call_id), output }];
  });
}

/**
 * Grok's prompt puts the tool list after the conversation, so the newest tool result can sit far
 * from the end and Grok re-runs a command it already has. A call identical to the last two calls,
 * which returned the same result, is refused before it reaches Codex.
 */
export function assertNotLooping(request: ResponsesRequest, toolCalls: Array<{ name: string; arguments: string }>): void {
  const [before, last] = completedCalls(request).slice(-2);
  if (!before || !last) return;
  for (const call of toolCalls) {
    if (POLLING_TOOLS.has(call.name)) continue;
    const same = (prior: CompletedCall) => prior.name === call.name && prior.args === call.arguments;
    if (same(before) && same(last) && stableOutput(before.output) === stableOutput(last.output)) {
      logSafe('grok-repeat-guard', { tool: call.name, bytes: call.arguments.length });
      throw new GrokError(
        `Grok repeated ${call.name} with identical arguments a third time; its result (call_id ${last.callId}) is already in the conversation. Use that result and take the next step`,
        true,
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
  return `\n\n<latest_step>\nYour most recent action was ${last.name} (call_id ${last.callId}) with arguments:\n${last.args.slice(0, 2000)}\nIts result, also shown in full above:\n${output}\nContinue from this result. Do not repeat an identical call unless something has changed since.\n</latest_step>`;
}

function toolCallArguments(call: JsonRecord, descriptor: ToolDescriptor): string {
  const objectArgs = isRecord(call.arguments);
  if (typeof call.arguments !== 'string' && !(objectArgs && descriptor.type !== 'custom')) {
    throw new GrokError('Grok requested an unavailable or malformed tool; no tools were executed', true);
  }
  if (objectArgs) return checkArgumentShape(descriptor.proxyName, JSON.stringify(call.arguments), descriptor.contract);
  const raw = call.arguments as string;
  if (descriptor.type === 'custom') return raw;
  return checkArgumentShape(descriptor.proxyName, functionArguments(raw), descriptor.contract);
}

/** Validates Grok's structured output and turns it into the calls Codex will run. */
export function parseGrokOutput(text: string, request: ResponsesRequest): ProxyOutput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GrokError('Grok returned invalid structured output; no tools were executed', true);
  }
  if (
    !isRecord(value) ||
    typeof value.text !== 'string' ||
    !Array.isArray(value.tool_calls) ||
    value.tool_calls.length > MAX_TOOL_CALLS ||
    Object.keys(value).some((key) => key !== 'text' && key !== 'tool_calls')
  ) {
    throw new GrokError('Grok returned invalid structured output; no tools were executed', true);
  }

  const allowed = new Map(toolDescriptors(request.tools ?? []).map((tool) => [tool.proxyName, tool]));
  const toolCalls: ToolCall[] = value.tool_calls.map((call: unknown) => {
    const descriptor = isRecord(call) && typeof call.name === 'string' ? allowed.get(call.name) : undefined;
    if (!isRecord(call) || !descriptor) {
      throw new GrokError('Grok requested an unavailable or malformed tool; no tools were executed', true);
    }
    return { name: descriptor.proxyName, arguments: toolCallArguments(call, descriptor), callId: randomId('call') };
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
  if (items && isRecord(items.properties)) items.properties.arguments = { anyOf: [{ type: 'object' }, { type: 'string' }] };
  return schema;
}

const ARGUMENT_RULES =
  ' Each arguments value is a JSON string that itself contains JSON, so inside it every backslash must be written as \\\\ and every double quote inside a value as \\". For example, the shell regex a\\.b inside a command becomes a\\\\.b in the inner JSON.';
const SYSTEM_PROMPT = `You are the model inside the Codex external agent loop. The listed Codex tools are real, available tools. Request them using the exact name and arguments in the required structured tool_calls JSON output. Your output must be an object with text (string) and tool_calls (array). Each call must have name (exact listed string) and arguments. For a function tool, arguments is a JSON object with the tool parameters, written directly as an object (not a string). For a custom tool, arguments is the exact raw input string. You have no tools of your own: there is no run_terminal_command, bash, read_file or similar. To run a command or read a file, return the listed Codex tool (for example exec_command) in tool_calls; Codex owns all execution. Never claim a tool executed without its result in history.${ARGUMENT_RULES}`;

/** Headless flags: `--tools` only takes effect in headless mode, never under ACP. */
function grokArgs(dir: string, effort: string, request: ResponsesRequest, promptFile: string, retryNote: string): string[] {
  return [
    '--cwd', dir,
    '-m', MODEL,
    '--effort', effort,
    '--permission-mode', 'dontAsk',
    '--tools', '__codex_external_only__',
    ...DENIED_TOOLS.flatMap((tool) => ['--deny', tool]),
    '--disallowed-tools', NATIVE_TOOLS.join(','),
    '--no-plan',
    '--no-subagents',
    '--disable-web-search',
    '--max-turns', String(MAX_TURNS),
    '--system-prompt-override', SYSTEM_PROMPT + retryNote,
    '--json-schema', JSON.stringify(grokOutputSchema(request.tools ?? [])),
    '--output-format', 'streaming-messages-json',
    '--prompt-file', promptFile,
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

  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspect);
    } else if (isRecord(value)) {
      if (['input_file', 'input_audio', 'audio', 'file'].includes(String(value.type)) || value.file_id) {
        throw new GrokError('Grok bridge cannot safely consume this attachment; use GPT or Claude');
      }
      Object.values(value).forEach(inspect);
    }
  };
  inspect(request.input);
  return effort;
}

/** Integrity gates: a changed native profile or binary pauses the backend until it is reviewed. */
function grokInstallation(): { binary: string; cwd: string } {
  const { GROK_BIN: binary, GROK_CWD: cwd, GROK_PROFILE_SHA256: profileHash, GROK_BIN_SHA256: binaryHash } = process.env;
  if (profileHash && grokProfileHash() !== profileHash) {
    throw new GrokError('Grok native configuration changed; backend paused pending isolation review');
  }
  if (binary && binaryHash && sha256(readFileSync(binary)) !== binaryHash) throw new GrokError('Grok pinned binary changed; backend paused');
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
 * A non-zero exit is classified from stderr and the CLI's own status records only, because stdout
 * also carries model text that can mention any word.
 */
function exitFailure(exit: number, stdout: string, stderr: string): GrokError {
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
  const { category, retryable } = classifyCliFailure(`${stderr}\n${status.join('\n')}`);
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
    if (failure && !failure.retryable) throw new GrokError(`Grok Build ${failure.category}; no automatic fallback`);
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

async function readCapped(stream: ReadableStream<Uint8Array>, keepAll: boolean, onOverflow: () => void): Promise<string> {
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for await (const chunk of stream) {
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
 * One isolated CLI session per attempt: a private directory and prompt file, never reused between
 * parent and child agents. Everything created here is removed on every exit path.
 */
async function runGrokOnce(request: ResponsesRequest, signal?: AbortSignal, retryNote = ''): Promise<ProxyOutput> {
  signal?.throwIfAborted();
  const effort = assertGrokRequest(request);
  const prepared = preparePrompt(request);
  if (prepared.images.length) throw new GrokError('This Grok bridge supports no image input; switch to GPT or Claude for this conversation');

  let dir: string | undefined;
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;
  let timedOut = false;
  const cancel = () => {
    aborted = true;
    proc?.kill();
  };
  try {
    const { binary, cwd } = grokInstallation();
    dir = await mkdtemp(join(cwd, 'request-'));
    await chmod(dir, 0o700);
    const promptFile = join(dir, 'prompt.txt');
    const prompt = prepared.prompt.replaceAll("Claude Code's native tools", "Grok Build's native tools") + latestStepRecap(request);
    await writeFile(promptFile, prompt, { mode: 0o600 });
    signal?.throwIfAborted();

    proc = Bun.spawn([binary, ...grokArgs(dir, effort, request, promptFile, retryNote)], {
      cwd: dir,
      env: grokEnvironment(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    timeout = setTimeout(() => {
      timedOut = true;
      proc?.kill();
    }, positiveInt('GROK_TIMEOUT_MS', 900_000));

    const kill = () => proc?.kill();
    const [stdout, stderr, exit] = await Promise.all([
      readCapped(proc.stdout, true, kill),
      readCapped(proc.stderr, false, kill),
      proc.exited,
    ]);
    if (aborted) throw new GrokError('Grok request cancelled');
    if (timedOut) throw new GrokError('Grok Build request timed out; no automatic model fallback');
    if (exit !== 0) throw exitFailure(exit, stdout, stderr);
    return interpretRun(stdout, request);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    if (proc) {
      proc.kill();
      await proc.exited;
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
