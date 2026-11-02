import { expect, test } from 'bun:test';
import { createZstdCompress } from 'node:zlib';
import { SseParser, decodeBody, sseEvents } from '../src/protocol/stream';
import type { StreamEvent } from '../src/protocol/types';

const encoder = new TextEncoder();
const frame = (event: unknown) => 'data: ' + JSON.stringify(event) + '\n\n';
const post = (body: BodyInit | Uint8Array, signal?: AbortSignal) => new Request('http://localhost/', { method: 'POST', headers: { 'content-encoding': 'zstd' }, body: body instanceof Uint8Array ? new Uint8Array(body) : body, signal });

for (const ending of ['\n', '\r\n', '\r']) test('SSE survives every byte boundary with ' + JSON.stringify(ending), async () => {
  const events: StreamEvent[] = [];
  const content = ': heartbeat\n\nevent: ignored\ndata: {"type":"delta",\ndata: "text":"🍁漢字"}\n\ndata: nope\n\ndata: {"type":"response.completed"}\n\n'.replaceAll('\n', ending);
  const bytes = encoder.encode(content);
  const stream = new ReadableStream<Uint8Array>({ start(out) { for (const byte of bytes) out.enqueue(Uint8Array.of(byte)); out.close(); } });
  await sseEvents(new Response(stream), event => events.push(event));
  expect(events).toEqual([{ type: 'delta', text: '🍁漢字' }, { type: 'response.completed' }]);
});

test('SSE strips one leading UTF-8 BOM across every chunk boundary', async () => {
  const bytes = encoder.encode('\uFEFFdata: {"type":"response.completed"}\n\n');
  for (let split = 0; split <= bytes.length; split++) {
    const events: StreamEvent[] = [];
    const parser = new SseParser(event => events.push(event));
    parser.feed(bytes.subarray(0, split)); parser.feed(bytes.subarray(split)); parser.finish();
    expect(events).toEqual([{ type: 'response.completed' }]); expect(parser.ended).toBe(true);
  }
  const events: StreamEvent[] = [];
  const parser = new SseParser(event => events.push(event));
  parser.feed(encoder.encode(': first line\n\n\uFEFFdata: {"type":"ignored"}\n\ndata: {"type":"response.completed"}\n\n'));
  expect(events).toEqual([{ type: 'response.completed' }]);
  expect(() => new SseParser(() => {}, undefined, bytes.length - 1).feed(bytes)).toThrow('Upstream event too large');
});

test('SSE copies partial bytes before the input buffer is reused', () => {
  const events: StreamEvent[] = [];
  const parser = new SseParser(event => events.push(event));
  const prefix = encoder.encode('data: {"type":');
  parser.feed(prefix); prefix.fill(0);
  parser.feed(encoder.encode('"response.completed"}\n\n'));
  expect(events).toEqual([{ type: 'response.completed' }]);
});

test('a terminal SSE event releases its reader without waiting on stalled source cleanup', async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(out) { out.enqueue(encoder.encode(frame({ type: 'response.completed' }))); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  });
  await sseEvents(new Response(source), () => {});
  expect(cancelled).toBe(true); expect(source.locked).toBe(false);
});

test('complete and unterminated SSE frames are capped before delivery in real UTF-8 bytes', () => {
  for (const suffix of ['\n\n', '']) {
    let delivered = 0;
    const parser = new SseParser(() => { delivered++; }, undefined, 128);
    expect(() => { parser.feed(encoder.encode('data: ' + JSON.stringify({ type: 'response.completed', text: '漢'.repeat(35) }) + suffix)); parser.finish(); }).toThrow('Upstream event too large');
    expect(delivered).toBe(0);
  }
});

test('SSE cap includes non-data fields and CRLF split across chunks', () => {
  const bytes = encoder.encode(': comment\r\ndata: {"type":"response.completed"}\r\n\r\n');
  let delivered = 0;
  const parser = new SseParser(() => { delivered++; }, undefined, bytes.length - 4);
  expect(() => { for (const byte of bytes) parser.feed(Uint8Array.of(byte)); }).toThrow('Upstream event too large');
  expect(delivered).toBe(0);
});

test('SSE keeps terminal and EOF policies and cancels the reader on failure', async () => {
  await expect(sseEvents(new Response(frame({ type: 'delta' })), () => {})).rejects.toThrow('Network connection interrupted');
  await sseEvents(new Response('data: [DONE]\n\n'), () => { throw new Error('DONE is not a JSON event'); });
  const events: StreamEvent[] = [];
  await sseEvents(new Response('data: {"type":"response.completed"}'), event => events.push(event));
  expect(events).toHaveLength(1);
  let cancelled = false;
  await expect(sseEvents(new Response(new ReadableStream({ start(out) { out.enqueue(encoder.encode(frame({ type: 'response.completed' }))); }, cancel() { cancelled = true; } })), () => { throw new Error('consumer failed'); })).rejects.toThrow('consumer failed');
  expect(cancelled).toBe(true);
});

async function unknownSizeZstd(value: string): Promise<Buffer> {
  const compressor = createZstdCompress();
  const chunks: Buffer[] = [];
  compressor.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => { compressor.on('end', resolve); compressor.on('error', reject); });
  compressor.end(value); await done;
  return Buffer.concat(chunks);
}

test('plain JSON reads fragmented UTF-8 with the same exact byte limit as compressed input', async () => {
  const value = { text: '🍁漢字', nested: [true, null, { answer: 42 }] };
  const bytes = encoder.encode(JSON.stringify(value));
  for (const encoding of [undefined, 'identity', 'zstd']) {
    const wire = encoding === 'zstd' ? Bun.zstdCompressSync(bytes) : bytes;
    const make = () => new Request('http://localhost/', { method: 'POST', headers: encoding ? { 'content-encoding': encoding } : {}, body: new ReadableStream({
      start(out) { for (const byte of wire) out.enqueue(Uint8Array.of(byte)); out.close(); },
    }) });
    expect(await decodeBody(make(), Math.max(wire.length, bytes.length))).toEqual(value);
    await expect(decodeBody(make(), bytes.length - 1)).rejects.toThrow('Request too large');
  }
  for (const text of ['{', '[]', 'null']) {
    await expect(decodeBody(new Request('http://localhost/', { method: 'POST', body: text }))).rejects.toThrow(text === '{' ? 'Request body is not valid JSON' : 'Request body must be a JSON object');
  }
});

for (const encoding of ['identity', 'zstd']) test(`cancelled ${encoding} uploads release the reader without awaiting source cleanup`, async () => {
  for (const alreadyAborted of [false, true]) {
    let cancelled = false;
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const body = new ReadableStream<Uint8Array>({
      start(out) { out.enqueue(encoding === 'zstd' ? Uint8Array.from([0x28, 0xb5]) : encoder.encode('{')); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    });
    if (alreadyAborted) controller.abort(reason);
    const pending = decodeBody(new Request('http://localhost/', { method: 'POST', headers: { 'content-encoding': encoding }, body, signal: controller.signal })).catch(error => error);
    if (!alreadyAborted) { await Bun.sleep(5); controller.abort(reason); }
    expect(await Promise.race([pending, Bun.sleep(100).then(() => 'still pending')])).toBe(reason);
    expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  }
});

test('unknown-size Zstd overflow interrupts an open upload even when its source cleanup stalls', async () => {
  const compressed = await unknownSizeZstd(JSON.stringify({ text: 'x'.repeat(100_000) }));
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(out) { out.enqueue(compressed); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  });
  const pending = decodeBody(post(body), 4096).catch(error => error instanceof Error ? error.message : 'unexpected error');
  expect(await Promise.race([pending, Bun.sleep(100).then(() => 'still pending')])).toBe('Request too large');
  expect(cancelled).toBe(true); expect(body.locked).toBe(false);
});

test('Zstd bounds known-size and unknown-size output before retaining the entire expansion', async () => {
  const text = JSON.stringify({ text: 'x'.repeat(100_000) });
  for (const bytes of [Bun.zstdCompressSync(text), await unknownSizeZstd(text)]) {
    expect(bytes.byteLength).toBeLessThan(4096);
    await expect(decodeBody(post(bytes), 4096)).rejects.toThrow('Request too large');
  }
});

test('Zstd bounds concatenated frames cumulatively and accepts a valid split JSON object', async () => {
  const good = Buffer.concat([Bun.zstdCompressSync('{"a":'), Bun.zstdCompressSync('1}')]);
  expect(await decodeBody(post(good), 4096)).toEqual({ a: 1 });
  const bad = Buffer.concat([Bun.zstdCompressSync('{"a":"' + 'x'.repeat(3000)), Bun.zstdCompressSync('y'.repeat(3000) + '"}')]);
  await expect(decodeBody(post(bad), 4096)).rejects.toThrow('Request too large');
});

test('Zstd rejects overlarge windows, truncated streams and trailing invalid data', async () => {
  const excessiveWindow = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff, 0x01, 0x00, 0x00]);
  await expect(decodeBody(post(excessiveWindow))).rejects.toThrow('Request body is not valid compressed data');
  const valid = Buffer.from(Bun.zstdCompressSync('{"a":1}'));
  for (const bytes of [valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from('garbage')])]) await expect(decodeBody(post(bytes))).rejects.toThrow();
});

test('cancelling a stalled compressed upload releases its reader immediately', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({ start(out) { out.enqueue(Uint8Array.from([0x28, 0xb5])); }, cancel() { cancelled = true; } });
  const pending = decodeBody(post(body, controller.signal));
  await Bun.sleep(5); controller.abort(new Error('caller cancelled'));
  await expect(pending).rejects.toThrow('caller cancelled');
  expect(cancelled).toBe(true);
});

test('large asynchronous decompression lets an unrelated timer run', async () => {
  const bytes = Bun.zstdCompressSync(JSON.stringify({ value: 'x'.repeat(8 * 1024 * 1024) }));
  let timer = false;
  const waiting = new Promise<void>(resolve => setTimeout(() => { timer = true; resolve(); }, 0));
  const body = await decodeBody(post(bytes));
  expect(timer).toBe(true); expect(String(body.value).length).toBe(8 * 1024 * 1024);
  await waiting;
});
