// Cursor's native tool path. Codex's client tools are registered as SDK custom tools, so the model
// calls them as real tool calls and the bridge asks the router to run each one over a host callback.
// The router hands those calls to Codex as the turn's output and answers the held callbacks with
// Codex's results when the next request carries them: the same Cursor run continues instead of being
// re-prompted, and nothing is parsed out of model text.
import { equalSecret, isRecord, randomId, type JsonRecord } from '../json';
import { logSafe } from '../log';
import { imageUrl, isImagePart, type ToolDescriptor } from '../protocol/prompt';
import { checkToolArguments, fieldName } from '../protocol/tool-schema';
import { codexCall, type FunctionTool } from '../protocol/native-tools';
import type { ResponseInputItem, ToolCall } from '../protocol/types';

/** The SDK's MCP provider for host-defined tools; every allowed tool call must target it. */
export const CUSTOM_TOOLS_PROVIDER = 'custom-user-tools';

type ContentItem = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ToolResult = { content: ContentItem[]; isError?: boolean };
/**
 * The tool list for the prompt. Cursor shows the model only tool names and descriptions, so models
 * otherwise spend a model round trip on MCP schema discovery before their first call (measured
 * 2-2.5 s on Grok and Muse). Listing the schemas lets them call at once.
 */
export function nativeToolList(definitions: Record<string, FunctionTool>): string {
  const lines = Object.entries(definitions).map(([name, tool]) => `- ${name}: ${JSON.stringify(tool.inputSchema)}`);
  return lines.length ? `<tool_schemas server="${CUSTOM_TOOLS_PROVIDER}">\n${lines.join('\n')}\n</tool_schemas>` : '';
}

/** Why a function call's arguments do not fit its contract, in words the model can act on. */
function argumentProblem(descriptor: ToolDescriptor, args: unknown): string | undefined {
  if (!isRecord(args)) return `${descriptor.proxyName} takes a JSON object. The tool did not run.`;
  const { declared, missing, issue } = checkToolArguments(args, descriptor.contract);
  const parameters = `its parameters are ${declared.map(fieldName).join(', ')}. The tool did not run.`;
  if (missing.length) return `${descriptor.proxyName} needs ${missing.map(fieldName).join(', ')}; ${parameters}`;
  return issue ? `${descriptor.proxyName} has invalid ${issue}; ${parameters}` : undefined;
}

const TEXT_PARTS = new Set(['input_text', 'output_text', 'text']);

/** A Codex tool output as MCP content: text stays text, inline images stay images. */
export function toolResult(item: ResponseInputItem): ToolResult {
  const content: ContentItem[] = [];
  const legacy = item.type === 'computer_call_output';
  const add = (value: unknown): void => {
    if (typeof value === 'string') { if (value) content.push({ type: 'text', text: value }); return; }
    if (Array.isArray(value)) { for (const part of value) add(part); return; }
    if (!isRecord(value)) return;
    if (isImagePart(value, legacy)) {
      const match = /^data:(image\/[a-z+.-]+);base64,(.*)$/s.exec(imageUrl(value, legacy) ?? '');
      content.push(match ? { type: 'image', mimeType: match[1]!, data: match[2]!.replace(/\s/g, '') } : { type: 'text', text: '[image omitted: only inline images can be shown]' });
      return;
    }
    if (TEXT_PARTS.has(String(value.type)) && typeof value.text === 'string') { add(value.text); return; }
    content.push({ type: 'text', text: JSON.stringify(value) });
  };
  add(item.output);
  return { content: content.length ? content : [{ type: 'text', text: '(no output)' }] };
}

type NativeYield = { text: string; calls: ToolCall[]; finished: boolean; usage?: JsonRecord };
type Held = { callId: string; respond: (result: ToolResult) => void };

/**
 * One Cursor run that may span several Codex turns. Text and tool calls accumulate until the model
 * stops issuing calls for `settleMs` (it writes parallel calls a few hundred ms apart and no event
 * marks the last one) or the run ends; that is one yield, which becomes one Codex response.
 * Delivered calls stay held until `answer` carries Codex's results back into the run.
 */
export class NativeRun {
  text = '';
  usage?: JsonRecord;
  private ready: ToolCall[] = [];
  private readonly held = new Map<string, Held>();
  private readonly delivered = new Map<string, Held>();
  private settle?: ReturnType<typeof setTimeout>;
  private settled = false;
  private finished = false;
  private failure?: Error;
  private wake?: () => void;
  closed = false;

  constructor(readonly byKey: Map<string, ToolDescriptor>, private readonly settleMs: number) {}

  /** Callback from the bridge: the model called `toolName`. Resolves when Codex's result arrives. */
  call(toolName: string, args: unknown): Promise<ToolResult> {
    const descriptor = this.byKey.get(toolName);
    if (this.closed) return Promise.resolve(errorResult('This Codex turn has ended; the tool did not run.'));
    if (!descriptor) return Promise.resolve(errorResult(`Unknown tool ${toolName}; use one of the listed tools.`));
    const callId = randomId('call');
    // Arguments that do not fit the tool go back to the model to fix; Codex never sees them.
    const invalid = descriptor.type === 'function' ? argumentProblem(descriptor, args) : undefined;
    const call = invalid ? { error: invalid } : codexCall(descriptor, args, callId);
    if ('error' in call) {
      logSafe('cursor-native-args-refused', { tool: descriptor.proxyName });
      return Promise.resolve(errorResult(call.error));
    }
    return new Promise<ToolResult>((resolve) => {
      this.held.set(callId, { callId, respond: resolve });
      this.ready.push(call);
      this.settled = false;
      clearTimeout(this.settle);
      this.settle = setTimeout(() => { this.settled = true; this.wake?.(); }, this.settleMs);
    });
  }

  appendText(text: string): void { this.text += text; }
  finish(): void { this.finished = true; clearTimeout(this.settle); this.settled = true; this.wake?.(); }
  fail(error: Error): void { this.failure ??= error; this.wake?.(); }

  /** Waits for the next yield: settled tool calls, or the end of the run. */
  async next(signal: AbortSignal): Promise<NativeYield> {
    for (;;) {
      signal.throwIfAborted();
      if (this.failure) throw this.failure;
      if ((this.ready.length && this.settled) || this.finished) {
        const calls = this.ready;
        this.ready = [];
        for (const call of calls) { const held = this.held.get(call.callId!); if (held) { this.held.delete(held.callId); this.delivered.set(held.callId, held); } }
        const text = this.text;
        this.text = '';
        return { text, calls, finished: this.finished && !calls.length, usage: this.usage };
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        this.wake = () => { signal.removeEventListener('abort', abort); this.wake = undefined; resolve(); };
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }

  /** Calls Codex has been given and not yet answered. */
  pending(): string[] { return [...this.delivered.keys()]; }

  /** Returns Codex's results to the model; the run continues from where it stopped. */
  answer(results: Map<string, ToolResult>): void {
    for (const [callId, result] of results) {
      const held = this.delivered.get(callId);
      if (!held) continue;
      this.delivered.delete(callId);
      held.respond(result);
    }
  }

  /** Releases every held callback so the bridge never waits on a run nobody will continue. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.settle);
    for (const held of [...this.held.values(), ...this.delivered.values()]) held.respond(errorResult(reason));
    this.held.clear();
    this.delivered.clear();
    this.fail(new Error(reason));
  }
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * The loopback endpoint every bridge of one Cursor login calls for custom tools. A call names its
 * agent; only a run the router registered for that agent can answer it. Held callbacks have no
 * deadline here (Codex may wait on a long command or an approval); the run's owner bounds them.
 */
export class NativeCallbackServer {
  readonly token = randomId('cb');
  private readonly runs = new Map<string, NativeRun>();
  private server?: ReturnType<typeof Bun.serve>;

  url(): string {
    this.server ??= Bun.serve({
      hostname: '127.0.0.1', port: 0, idleTimeout: 255,
      fetch: async (req, server) => {
        server.timeout(req, 0);
        if (req.method !== 'POST' || new URL(req.url).pathname !== '/sdk.v1.SdkCustomToolCallbackService/CallCustomTool') return new Response('not found', { status: 404 });
        if (!equalSecret(req.headers.get('authorization') ?? '', `Bearer ${this.token}`)) return new Response('unauthorized', { status: 401 });
        let body: unknown;
        try { body = await req.json(); } catch { return Response.json({ code: 'invalid_argument', message: 'invalid JSON' }, { status: 400 }); }
        const agentId = isRecord(body) && typeof body.agentId === 'string' ? body.agentId : '';
        const toolName = isRecord(body) && typeof body.toolName === 'string' ? body.toolName : '';
        const run = this.runs.get(agentId);
        const result = run ? await run.call(toolName, isRecord(body) ? body.args : undefined) : errorResult('No active Codex turn owns this agent; the tool did not run.');
        return Response.json({ result });
      },
    });
    return `http://127.0.0.1:${this.server.port}`;
  }

  register(agentId: string, run: NativeRun): void { this.runs.set(agentId, run); }
  unregister(agentId: string, run: NativeRun): void { if (this.runs.get(agentId) === run) this.runs.delete(agentId); }
  stop(): void { this.server?.stop(true); this.server = undefined; }
}
