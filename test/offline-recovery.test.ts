import { test, expect } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { reconnectTransport, ProxyTransportError } from '../src/transport';
import { pendingResponse, pendingStream } from '../src/protocol/pending';
import { responseObject } from '../src/protocol/output';
import { startRouter } from '../src/router/server';
import { sseEvents } from '../src/protocol/stream';
import { claudeLimits, claudeUsageSnapshot } from '../src/backends/claude-limits';
import { runClaude } from '../src/backends/claude';

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
  const request = { model: 'claude-opus-5-5', input: 'original' };
  const events: Record<string, unknown>[] = [];
  let remembered = '';
  await pendingResponse(request, async () => {
    await Bun.sleep(35);
    return responseObject(request, { text: 'Recovered', toolCalls: [{ name: 'step', arguments: '{}', callId: 'call_once' }], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
  }, new AbortController().signal, event => events.push(event), response => { remembered = response.id; }, 5);
  expect(events.filter(event => event.type === 'response.in_progress').length).toBeGreaterThan(0);
  expect(events.filter(event => event.type === 'response.created')).toHaveLength(1);
  expect(events.filter(event => event.type === 'response.output_item.done' && (event.item as { type: string }).type === 'function_call')).toHaveLength(1);
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

test('real Claude subprocess recovers inside the same HTTP and WebSocket request with no response.failed', async () => {
  const dir = await mkdtemp(tmpdir() + '/claude-offline-');
  const binary = dir + '/mock-cli';
  const oldBinary = process.env.CLAUDE_BIN;
  const success = JSON.stringify({ type: 'result', is_error: false, structured_output: { text: 'RECOVERED', tool_calls: [] } });
  const failure = JSON.stringify({ type: 'result', is_error: true, result: 'Unable to connect to API' });
  await Bun.write(binary, `#!/bin/sh\nread initial\nprintf '%s\\n' "$initial" >> '${dir}/inputs'\nif [ ! -f '${dir}/connected' ]; then\n touch '${dir}/connected'\n printf '%s\\n' '${failure}'\nelse\n printf '%s\\n' '${success}'\nfi\n`);
  await chmod(binary, 0o700);
  await Bun.write(dir + '/auth.json', JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture', account_id: 'fixture' } }));
  await Bun.write(dir + '/catalog.json', '{}');
  process.env.CLAUDE_BIN = binary;
  claudeLimits.restore(claudeUsageSnapshot({}));
  const server = startRouter({ port: 0, authFile: dir + '/auth.json', catalog: dir + '/catalog.json', heartbeatMs: 20 });
  const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json' };
  const body = { model: 'claude-opus-5-5', input: 'PRESERVE_THIS_REQUEST', stream: true };
  try {
    const response = await fetch(server.url + 'v1/responses', { method: 'POST', headers, body: JSON.stringify(body) });
    const events: Record<string, unknown>[] = [];
    await sseEvents(response, event => events.push(event));
    expect(events.filter(event => event.type === 'response.in_progress').length).toBeGreaterThan(0);
    expect(events.some(event => event.type === 'response.failed')).toBe(false);
    expect(events.at(-1)?.type).toBe('response.completed');
    await rm(dir + '/connected');
    const Socket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
    const ws = new Socket(String(server.url).replace('http:', 'ws:') + 'v1/responses', { headers });
    try {
      const frames: Record<string, unknown>[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('offline recovery timed out')), 3000);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'response.create', ...body }));
        ws.onmessage = event => {
          const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
          frames.push(frame);
          if (frame.type === 'response.completed' || frame.type === 'response.failed') { clearTimeout(timer); resolve(); }
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('socket failed')); };
      });
      expect(frames.filter(event => event.type === 'response.in_progress').length).toBeGreaterThan(0);
      expect(frames.some(event => event.type === 'response.failed')).toBe(false);
      expect(frames.at(-1)?.type).toBe('response.completed');
    } finally { ws.close(); }
    const inputs = (await Bun.file(dir + '/inputs').text()).trim().split('\n');
    expect(inputs).toHaveLength(4);
    for (const input of inputs) expect(input).toContain('PRESERVE_THIS_REQUEST');
  } finally {
    server.stop(true);
    if (oldBinary === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = oldBinary;
    await rm(dir, { recursive: true });
  }
}, 10_000);

test('an interrupted tool continuation replays the original task and receipt without repeating a tool call', async () => {
  const dir = await mkdtemp(tmpdir() + '/claude-offline-continuation-');
  const oldBinary = process.env.CLAUDE_BIN;
  const binary = dir + '/mock-cli';
  const plan = JSON.stringify({ type: 'result', structured_output: { text: '', tool_calls: [{ name: 'step', arguments: '{}' }] } });
  const failure = JSON.stringify({ type: 'result', is_error: true, result: 'Unable to connect to API' });
  const success = JSON.stringify({ type: 'result', structured_output: { text: 'CONTINUATION_RECOVERED', tool_calls: [] } });
  await Bun.write(binary, `#!/bin/sh\nprintf started >> '${dir}/starts'\nread initial\nprintf '%s\\n' "$initial" >> '${dir}/inputs'\nif [ ! -f '${dir}/planned' ]; then\n touch '${dir}/planned'\n printf '%s\\n' '${plan}'\n read continuation\n printf '%s\\n' '${failure}'\nelse\n printf '%s\\n' '${success}'\nfi\n`);
  await chmod(binary, 0o700);
  process.env.CLAUDE_BIN = binary;
  claudeLimits.restore(claudeUsageSnapshot({}));
  const tools = [{ type: 'function', name: 'step', parameters: { type: 'object' } }];
  try {
    const first = await runClaude({ model: 'claude-opus-5-5', input: 'ORIGINAL_TASK', tools });
    const call = first.toolCalls[0]!;
    const recovered = await runClaude({ model: 'claude-opus-5-5', tools, input: [
      { role: 'user', content: 'ORIGINAL_TASK' },
      { type: 'function_call', name: call.name, call_id: call.callId, arguments: call.arguments },
      { type: 'function_call_output', call_id: call.callId, output: 'ALREADY_EXECUTED_RECEIPT' },
    ] });
    expect(recovered.text).toBe('CONTINUATION_RECOVERED');
    expect(recovered.toolCalls).toHaveLength(0);
    expect(await Bun.file(dir + '/starts').text()).toBe('startedstarted');
    const replay = (await Bun.file(dir + '/inputs').text()).trim().split('\n')[1]!;
    expect(replay).toContain('ORIGINAL_TASK');
    expect(replay).toContain('ALREADY_EXECUTED_RECEIPT');
  } finally {
    if (oldBinary === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = oldBinary;
    await rm(dir, { recursive: true });
  }
});
