import { test, expect } from 'bun:test';
import { reconnectTransport, ProxyTransportError } from '../src/transport';
import { pendingRelay, pendingResponse, pendingStream } from '../src/protocol/pending';
import { responseObject } from '../src/protocol/output';
import type { ResponsesBody } from '../src/protocol/types';

test('a buffered request survives more than five network failures with its original input', async () => {
  let attempts = 0;
  const input = { original: 'Do the original task', toolReceipt: 'already executed' };
  const result = await reconnectTransport(async () => {
    expect(input.toolReceipt).toBe('already executed');
    if (++attempts <= 9) throw Object.assign(new Error('private network diagnostic'), { code: attempts % 2 ? 'ENETUNREACH' : 'ETIMEDOUT' });
    return input;
  }, undefined, { initialDelayMs: 1, maxDelayMs: 2 });
  expect(result).toBe(input);
  expect(attempts).toBe(10);
});

test('cancellation interrupts offline backoff immediately and does not start another attempt', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const pending = reconnectTransport(async () => { attempts++; throw new ProxyTransportError(); }, controller.signal);
  await Bun.sleep(5);
  controller.abort(new Error('cancelled by user'));
  await expect(pending).rejects.toThrow('cancelled by user');
  expect(attempts).toBe(1);
});

test('auth, quota, validation and model timeouts do not become endless offline retries', async () => {
  for (const failure of [new Error('authentication failed'), new Error('Claude session limit reached'), new Error('invalid output'), new ProxyTransportError(true)]) {
    let attempts = 0;
    await expect(reconnectTransport(async () => { attempts++; throw failure; })).rejects.toBe(failure);
    expect(attempts).toBe(1);
  }
});

test('heartbeats preserve one response id and emit validated tool calls exactly once', async () => {
  const request: ResponsesBody = {
    model: 'claude-opus-5-5',
    input: 'original',
    tools: [{ type: 'function', name: 'step' }, { type: 'custom', name: 'patch' }, { type: 'tool_search' }],
  };
  const patch = '*** Begin Patch\n+snowman ☃; literal \\n\n*** End Patch';
  const events: Record<string, unknown>[] = [];
  let remembered = '';
  await pendingResponse(request, async () => {
    await Bun.sleep(35);
    return responseObject(request, { text: 'Recovered', toolCalls: [
      { name: 'step', arguments: '{}', callId: 'call_once' },
      { name: 'patch', arguments: patch, callId: 'call_patch' },
      { name: '__codex_tool_search', arguments: '{"query":"read files","limit":8}', callId: 'call_search' },
    ], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
  }, new AbortController().signal, event => events.push(event), response => { remembered = response.id; }, 5);
  expect(events.filter(event => event.type === 'response.in_progress').length).toBeGreaterThan(0);
  expect(events.filter(event => event.type === 'response.created')).toHaveLength(1);
  expect(events.filter(event => event.type === 'response.output_item.done' && (event.item as { type: string }).type === 'function_call')).toHaveLength(1);
  expect(events.find(event => event.type === 'response.custom_tool_call_input.delta')?.delta).toBe(patch);
  const completedItems = events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
  expect(completedItems).toHaveLength(4);
  expect(completedItems[2]).toMatchObject({ type: 'custom_tool_call', call_id: 'call_patch', input: patch });
  expect(completedItems[3]).toMatchObject({ type: 'tool_search_call', call_id: 'call_search', arguments: { query: 'read files', limit: 8 } });
  for (const event of events.filter(event => event.response)) expect((event.response as { id: string }).id).toBe(remembered);
  expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index));
  expect(events.at(-1)?.type).toBe('response.completed');
});

test('closing a pending HTTP reader cancels generation and stops progress', async () => {
  let backendSignal: AbortSignal | undefined;
  const response = pendingStream({ model: 'opus', input: 'wait' }, signal => {
    backendSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, new AbortController().signal, () => ({ type: 'response.failed' }), undefined, 5);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(backendSignal?.aborted).toBe(true);
});

for (const parentAbort of [false, true]) test('pending relay releases a stalled reader on ' + (parentAbort ? 'parent abort' : 'client cancellation'), async () => {
  const controller = new AbortController();
  let cancelled: unknown;
  const source = new ReadableStream<Uint8Array>({
    start(out) { out.enqueue(new TextEncoder().encode('data: {}\n\n')); },
    cancel(reason) { cancelled = reason; return new Promise<void>(() => {}); },
  });
  const response = pendingRelay({}, async () => new Response(source), controller.signal,
    () => ({ type: 'error' }), async () => ({ type: 'error' }), 100_000);
  const reader = response.body!.getReader();
  await reader.read();
  const reason = new Error('caller stopped');
  if (parentAbort) {
    const pending = reader.read(); controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  } else await reader.cancel(reason);
  expect(cancelled).toBe(reason); expect(source.locked).toBe(false);
  reader.releaseLock();
});

test('a cancelled pending relay disposes a response that connects late', async () => {
  let resolve!: (response: Response) => void;
  let cancelled: unknown;
  const source = new ReadableStream<Uint8Array>({ cancel(reason) { cancelled = reason; } });
  const response = pendingRelay({}, () => new Promise<Response>(done => { resolve = done; }), new AbortController().signal,
    () => ({ type: 'error' }), async () => ({ type: 'error' }), 100_000);
  const reason = new Error('caller stopped');
  await response.body!.cancel(reason);
  resolve(new Response(source)); await Bun.sleep(0);
  expect(cancelled).toBe(reason); expect(source.locked).toBe(false);
});

test('a finished pending relay releases its upstream reader', async () => {
  const source = new ReadableStream<Uint8Array>({ start(out) { out.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); out.close(); } });
  const response = pendingRelay({}, async () => new Response(source), new AbortController().signal,
    () => ({ type: 'error' }), async () => ({ type: 'error' }));
  expect(await response.text()).toBe('data: [DONE]\n\n'); expect(source.locked).toBe(false);
});
