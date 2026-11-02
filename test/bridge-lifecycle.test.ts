import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { CompactionBridge } from '../src/router/bridge';
import { SummaryCodec } from '../src/router/capsule';
import { UpstreamStatusError } from '../src/router/upstream';
import { sha256 } from '../src/json';
import type { StreamEvent } from '../src/protocol/types';

const codec = new SummaryCodec(Buffer.alloc(32, 9));
const sse = (events: StreamEvent[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
const success = () => sse([{ type: 'response.output_text.delta', delta: 'complete summary' }, { type: 'response.completed', response: { status: 'completed' } }]);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test.each(['response.failed', 'response.incomplete', 'error', 'done-only'])('partial restoration ending in %s is never cached; a successful retry repairs it', async type => {
  const dir = await mkdtemp('/tmp/bridge-terminal-'); let calls = 0;
  const bridge = new CompactionBridge(codec, dir, async () => {
    calls++;
    if (calls > 1) return success();
    const prefix = 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n';
    return type === 'done-only' ? new Response(prefix + 'data: [DONE]\n\n') : sse([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type, response: { status: type.split('.')[1], error: { code: 'server_error' } } },
    ]);
  }, ['fixture']);
  try {
    await expect(bridge.summary('gAAAA-fixture')).rejects.toBeInstanceOf(UpstreamStatusError);
    expect(await readdir(dir)).toEqual([]);
    expect(await bridge.summary('gAAAA-fixture')).toBe('complete summary');
    expect(await bridge.summary('gAAAA-fixture')).toBe('complete summary');
    expect(calls).toBe(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([['usage_limit_reached', 429], ['context_length_exceeded', 400], ['server_error', 502]] as const)('bridge preserves %s classification after partial text', async (code, status) => {
  const dir = await mkdtemp('/tmp/bridge-error-');
  const bridge = new CompactionBridge(codec, dir, async () => sse([
    { type: 'response.output_text.delta', delta: 'partial' },
    { type: 'response.failed', response: { error: { code, resets_at: 42 } } },
  ]), ['fixture']);
  try {
    const error: unknown = await bridge.summary('gAAAA-fixture').catch(error => error);
    expect(error).toBeInstanceOf(UpstreamStatusError);
    expect(error).toMatchObject({ status, fields: { code, resets_at: 42 } });
    expect(await readdir(dir)).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unchecked legacy bridge cache files are restored once under the completion policy', async () => {
  const dir = await mkdtemp('/tmp/bridge-legacy-'); let calls = 0;
  await Bun.write(`${dir}/${sha256('gAAAA-fixture')}.cap`, codec.seal('unchecked old partial'));
  const bridge = new CompactionBridge(codec, dir, async () => { calls++; return success(); });
  try { expect(await bridge.summary('gAAAA-fixture')).toBe('complete summary'); expect(await bridge.summary('gAAAA-fixture')).toBe('complete summary'); expect(calls).toBe(1); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('a cancelled waiter exits promptly without cancelling a shared restoration', async () => {
  const dir = await mkdtemp('/tmp/bridge-waiter-'); const ready = deferred<void>(), release = deferred<void>(); let upstreamSignal: AbortSignal | undefined;
  const bridge = new CompactionBridge(codec, dir, async (_body, signal) => { upstreamSignal = signal; ready.resolve(); await release.promise; return success(); });
  const controller = new AbortController(); const first = bridge.summary('gAAAA-fixture', controller.signal).catch(error => error);
  try {
    await ready.promise; const second = bridge.summary('gAAAA-fixture');
    controller.abort(new Error('cancel first')); expect(await first).toEqual(new Error('cancel first'));
    expect(upstreamSignal?.aborted).toBe(false);
    release.resolve(); expect(await second).toBe('complete summary');
  } finally { release.resolve(); await first; await rm(dir, { recursive: true, force: true }); }
});

test('the last cancelled waiter aborts upstream work; a fresh flight survives late old completion', async () => {
  const dir = await mkdtemp('/tmp/bridge-last-'); const ready = deferred<void>(), release = deferred<void>(); let oldSignal: AbortSignal | undefined, calls = 0;
  const bridge = new CompactionBridge(codec, dir, async (_body, signal) => {
    if (++calls === 1) { oldSignal = signal; ready.resolve(); await release.promise; }
    return success();
  });
  const controller = new AbortController(); const first = bridge.summary('gAAAA-fixture', controller.signal).catch(error => error);
  try {
    await ready.promise; controller.abort(); await first;
    expect(oldSignal?.aborted).toBe(true);
    expect(await bridge.summary('gAAAA-fixture')).toBe('complete summary');
    release.resolve(); await Bun.sleep(5);
    expect(await bridge.summary('gAAAA-fixture')).toBe('complete summary'); expect(calls).toBe(2);
  } finally { release.resolve(); await first; await rm(dir, { recursive: true, force: true }); }
});
