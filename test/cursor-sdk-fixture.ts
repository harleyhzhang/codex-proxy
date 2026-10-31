// A scripted `@cursor/sdk` that behaves like the real one for the router: agents with custom tools,
// per-send model and tools, live deltas, tool calls answered through the tools' `execute` callbacks,
// a message stream and a terminal run result. A turn's behaviour is chosen by words in the newest user
// message of its prompt; every SDK operation is recorded in `events`.
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createCursorBackend, type CursorBackend, type CursorSdk, type SdkAgent, type SdkRun } from '../src/backends/cursor';
import type { JsonRecord } from '../src/json';

export type SdkEvent = { operation: string; [key: string]: unknown };
type Tool = { description?: string; inputSchema?: JsonRecord; execute(args: unknown, context: JsonRecord): unknown };
type Result = { content: Array<{ type: string; text?: string; mimeType?: string }>; isError?: boolean };

/** An error shaped like the SDK's (name, status, code, isRetryable). */
export function sdkError(name: string, message: string, fields: { status?: number; code?: string; isRetryable?: boolean } = {}): Error {
  return Object.assign(new Error(message), { name, ...fields });
}

export function scriptedSdk(options: { email?: string; userId?: string; models?: unknown[] } = {}) {
  const events: SdkEvent[] = [];
  const state = {
    me: (): unknown => ({ userEmail: options.email ?? 'test@example.com', userId: options.userId ?? 'fixture' }),
    models: (): unknown => options.models ?? [
      { id: 'kimi-k3', parameters: [{ id: 'reasoning', values: [{ value: 'high' }] }] },
      { id: 'claude-opus-5-5', parameters: [{ id: 'effort', values: [{ value: 'high' }] }, { id: 'context', values: [{ value: '1m' }] }, { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }] },
    ],
    /** Called on every Agent.create and send; an error returned is thrown there. */
    createError: (): Error | undefined => undefined,
    sendError: (): Error | undefined => undefined,
    /** Each send's result before it is shaped; tests may replace it. */
    result: (_text: string, model: unknown, final: string): JsonRecord => ({ status: 'finished', result: final, model, usage: { inputTokens: 10, outputTokens: 2 } }),
  };
  let next = 0;
  const record = (operation: string, fields: JsonRecord = {}) => events.push({ operation, ...fields });
  const sdk: CursorSdk = {
    Cursor: { me: async () => { record('me'); return state.me(); }, models: { list: async () => { record('models'); return state.models(); } } },
    JsonlLocalAgentStore: class { constructor(readonly rootDir: string) {} },
    emptyFs: () => ({ empty: true }),
    Agent: {
      async create(created: JsonRecord): Promise<SdkAgent> {
        const createFailure = state.createError();
        if (createFailure) throw createFailure;
        const agentId = `agent-${++next}`;
        const local = created.local as JsonRecord;
        record('create', { agentId, tools: created.tools, disallowed: created.disallowedTools, settingSources: local.settingSources, fs: local.fs, cwd: local.cwd, apiKey: created.apiKey });
        let closed = false;
        return {
          agentId,
          close() { if (!closed) { closed = true; record('close', { agentId }); } },
          async send(message: unknown, sendOptions: JsonRecord = {}): Promise<SdkRun> {
            record('attempt', { agentId });
            const sendFailure = state.sendError();
            if (sendFailure) throw sendFailure;
            const text = typeof message === 'string' ? message : String((message as JsonRecord).text);
            const images = typeof message === 'string' ? 0 : ((message as JsonRecord).images as unknown[] | undefined)?.length ?? 0;
            const sendLocal = (sendOptions.local ?? {}) as JsonRecord;
            const tools = (sendLocal.customTools ?? {}) as Record<string, Tool>;
            const model = sendOptions.model;
            const onDelta = sendOptions.onDelta as ((value: { update: JsonRecord }) => void) | undefined;
            const runId = `run-${agentId}`;
            record('send', { agentId, text, images, model, tools: Object.keys(tools), schemas: Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, tool.inputSchema])) });
            // Like a model, act on the newest user message; a replay carries the whole transcript.
            const latest = text.slice(text.lastIndexOf('<user>'));
            const messages: JsonRecord[] = [];
            const waiters: Array<() => void> = [];
            let finished = false, cancelled = false, result: JsonRecord | undefined;
            const push = (value: JsonRecord) => { messages.push(value); for (const wake of waiters.splice(0)) wake(); };
            const delta = (update: JsonRecord) => onDelta?.({ update });
            const say = (value: string) => { delta({ type: 'text-delta', text: value }); push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: value }] } }); };
            const call = async (toolName: string, args: unknown): Promise<Result> => {
              const toolCall = { type: 'mcp', args: { providerIdentifier: 'custom-user-tools', toolName, args } };
              delta({ type: 'tool-call-started', callId: `tc-${toolName}`, toolCall });
              push({ type: 'tool_call', name: 'mcp', status: 'running', args: toolCall.args });
              const tool = tools[toolName];
              const answer = (tool ? await tool.execute(args, { toolCallId: `tc-${toolName}` }) : { content: [{ type: 'text', text: 'no such tool' }], isError: true }) as Result;
              record('tool-result', { agentId, toolName, result: answer });
              return answer;
            };
            const textOf = (value: Result) => value.content.map(part => part.type === 'text' ? part.text : `image:${part.mimeType}`).join('|');
            const done = (status: string, value?: JsonRecord) => {
              if (finished) return;
              finished = true;
              result = value ?? { status, model };
              for (const wake of waiters.splice(0)) wake();
            };
            void (async () => {
              await Promise.resolve();
              let final = 'hello';
              if (latest.includes('THINK')) delta({ type: 'thinking-delta', text: 'pondering' });
              if (latest.includes('HANG')) { say('thinking'); return; }
              if (latest.includes('NATIVE_SHELL')) { delta({ type: 'tool-call-started', toolCall: { type: 'shell', args: { command: 'touch x' } } }); push({ type: 'tool_call', name: 'shell', status: 'running', args: { command: 'touch x' } }); }
              if (latest.includes('SUMMARY')) push({ type: 'summary', status: 'running' });
              if (latest.includes('ONE_TOOL') || latest.includes('TWO_STEPS')) {
                say('working');
                final = 'got:' + textOf(await call('echo', { value: 'v1' }));
                if (latest.includes('TWO_STEPS')) { say('again'); final += ',' + textOf(await call('echo', { value: 'v2' })); }
              }
              if (latest.includes('PARALLEL')) {
                const first = call('echo', { value: 'a' });
                await Bun.sleep(20);
                const second = call('echo', { value: 'b' });
                final = 'got:' + textOf(await first) + '|' + textOf(await second);
              }
              if (latest.includes('PATCH')) final = 'patched:' + textOf(await call('apply_patch', { input: '*** Begin Patch' }));
              if (latest.includes('BAD_RAW')) { const answer = await call('apply_patch', { a: 1, b: 2 }); final = 'refused:' + String(answer.isError); }
              if (latest.includes('BAD_ARGS')) { const answer = await call('echo', { input: 'x' }); final = 'refused:' + String(answer.isError) + ':' + textOf(answer); }
              if (cancelled) return;
              const outcome = state.result(latest, model, final);
              // A run that errors does so before its final answer.
              if (outcome.status === 'finished') say(String(outcome.result ?? final));
              push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } });
              done(String(outcome.status), outcome);
            })();
            return {
              id: runId,
              async *stream() {
                for (let index = 0; ; index++) {
                  while (index >= messages.length && !finished) await new Promise<void>(resolve => waiters.push(resolve));
                  if (index >= messages.length) return;
                  yield messages[index];
                }
              },
              async wait() { while (!finished) await new Promise<void>(resolve => waiters.push(resolve)); return result; },
              async cancel() { record('cancel', { agentId }); cancelled = true; done('cancelled'); },
            };
          },
        };
      },
    },
  };
  return { sdk, events, state, count: (operation: string) => events.filter(event => event.operation === operation).length };
}

/** A Cursor backend on a scripted SDK, with an owner-only SDK login in a scratch directory. */
export async function scriptedCursor(fields: { prefix?: string; label?: string; email?: string; userId?: string } = {}) {
  const root = await mkdtemp(tmpdir() + '/cursor-sdk-');
  await chmod(root, 0o700);
  const auth = root + '/auth.json';
  await Bun.write(auth, JSON.stringify({ apiKey: 'fixture-key', email: fields.email ?? 'test@example.com', backendUrl: 'https://api2.cursor.sh' }));
  await chmod(auth, 0o600);
  const scripted = scriptedSdk({ email: fields.email, userId: fields.userId });
  const backend: CursorBackend = createCursorBackend({ authFile: auth, cwd: root, expectedEmail: fields.email ?? 'test@example.com', expectedUserId: fields.userId ?? 'fixture', prefix: fields.prefix ?? 'fixture', label: fields.label ?? 'Fixture', sdk: async () => scripted.sdk });
  return { ...scripted, backend, root, auth };
}
