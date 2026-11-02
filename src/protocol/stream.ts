import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants, createZstdDecompress } from 'node:zlib';
import { isRecord, type JsonRecord } from '../json';
import { logSafe } from '../log';
import { ProxyTransportError } from '../transport';
import type { StreamEvent } from './types';
import { ZstdFrames } from './zstd-frames';

/** Full conversation replays include base64 images/tool output even below the token window. */
export const MAX_BODY_BYTES = 128 * 1024 * 1024;
export const MAX_EVENT_BYTES = 32 * 1024 * 1024;
const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);

/** Bound compressed input and decoded output, including unknown-size/concatenated frames.
 * The decoder uses a bounded window and small output chunks; excess output is never retained.
 * Native async zlib work leaves heartbeats and other chats responsive. */
export async function decodeBody(req: Request, limit = MAX_BODY_BYTES): Promise<JsonRecord> {
  if (Number(req.headers.get('content-length') ?? 0) > limit) throw new Error('Request too large');
  if (!req.body) throw new Error('Missing request body');
  const encoding = req.headers.get('content-encoding');
  if (encoding && encoding !== 'identity' && encoding !== 'zstd') throw new Error('Unsupported request encoding');
  const chunks: Uint8Array[] = [];
  let wire = 0, decoded = 0;
  const frames = encoding === 'zstd' ? new ZstdFrames(limit) : undefined;
  const collect = (chunk: Uint8Array) => {
    decoded += chunk.byteLength;
    if (decoded > limit) throw new Error('Request too large');
    chunks.push(chunk);
  };
  const reader = req.body.getReader();
  const abort = () => cancelReader(reader, req.signal.reason);
  // Own cancellation here: a source's asynchronous cancel hook must not hold the upload open.
  // Plain JSON stays on the native reader; only compressed bytes cross into Node's async codec.
  const read = async () => {
    req.signal.throwIfAborted();
    const next = await reader.read();
    req.signal.throwIfAborted();
    if (next.done) frames?.finish();
    else {
      wire += next.value.byteLength;
      if (wire > limit) throw new Error('Request too large');
      frames?.feed(next.value);
    }
    return next;
  };
  req.signal.addEventListener('abort', abort, { once: true });
  try {
    if (encoding === 'zstd') {
      const source = new Readable({
        read() {
          void read().then(next => this.push(next.done ? null : next.value))
            .catch(error => this.destroy(error instanceof Error ? error : new Error('Invalid request stream')));
        },
        // Decoder/output failures interrupt a pending read without waiting on source cleanup.
        destroy(error, done) { cancelReader(reader, error); done(error); },
      });
      const decoder = createZstdDecompress({ chunkSize: 16 * 1024, params: { [constants.ZSTD_d_windowLogMax]: 27 } });
      const sink = new Writable({
        write(chunk: Buffer, _encoding, done) {
          try { collect(chunk); done(); } catch (error) { done(error instanceof Error ? error : new Error('Invalid decoded body')); }
        },
      });
      await pipeline(source, decoder, sink, { signal: req.signal });
    } else for (;;) { const next = await read(); if (next.done) break; collect(next.value); }
  } catch (error) {
    if (req.signal.aborted) throw req.signal.reason;
    if (error instanceof Error && error.message === 'Request too large') throw error;
    throw new Error('Request body is not valid compressed data');
  } finally { req.signal.removeEventListener('abort', abort); cancelReader(reader); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks, decoded).toString()); } catch { throw new Error('Request body is not valid JSON'); }
  if (!isRecord(body)) throw new Error('Request body must be a JSON object');
  return body;
}

/** Incremental byte framing. Each byte is scanned once, including CR/LF split across chunks;
 * long lines are joined only when complete. The cap applies before parsing complete frames too. */
export class SseParser {
  private parts: Uint8Array[] = [];
  private data: string[] = [];
  private bytes = 0;
  private skipLf = false;
  private lineBuffer = Buffer.allocUnsafe(16 * 1024);
  private used = 0;
  private firstLine = true;
  ended = false;
  constructor(private readonly consume: (event: StreamEvent) => void,
    private readonly terminal: ReadonlySet<string> = TERMINAL_EVENTS, private readonly limit = MAX_EVENT_BYTES) {}

  feed(chunk: Uint8Array): void {
    if (this.ended) return;
    const bytes = chunk;
    let start = 0;
    if (this.skipLf && bytes.length) {
      this.skipLf = false;
      if (bytes[0] === 10) {
        if (this.bytes && ++this.bytes > this.limit) throw new Error('Upstream event too large');
        start = 1;
      }
    }
    // The usual LF-only chunks use native delimiter search and decode complete lines in place.
    // Partial lines still copy their bytes: callers may reuse an input buffer after feed returns.
    if (bytes.length >= 64 && bytes.indexOf(13, start) === -1) {
      for (let end = bytes.indexOf(10, start); end !== -1; end = bytes.indexOf(10, start)) {
        this.bytes += end - start + 1;
        if (this.bytes > this.limit) throw new Error('Upstream event too large');
        this.line(bytes.subarray(start, end)); start = end + 1;
        if (this.ended) return;
      }
      this.bytes += bytes.length - start;
      if (this.bytes > this.limit) throw new Error('Upstream event too large');
      if (start < bytes.length) this.append(bytes.subarray(start));
      return;
    }
    for (let i = start; i < bytes.length; i++) {
      const byte = bytes[i]!;
      if (this.skipLf) {
        this.skipLf = false;
        if (byte === 10) {
          // The final empty-line separator belongs to the event already dispatched on CR.
          if (this.bytes && ++this.bytes > this.limit) throw new Error('Upstream event too large');
          start = i + 1; continue;
        }
      }
      if (++this.bytes > this.limit) throw new Error('Upstream event too large');
      if (byte !== 10 && byte !== 13) continue;
      this.line(bytes.subarray(start, i)); start = i + 1;
      this.skipLf = byte === 13;
      if (this.ended) return;
    }
    if (start < bytes.length) this.append(bytes.subarray(start));
  }
  finish(): void {
    if (this.ended) return;
    if (this.parts.length || this.used) this.line();
    if (!this.ended) this.dispatch();
  }
  private line(tail: Uint8Array = new Uint8Array()): void {
    const bytes = this.parts.length || this.used
      ? Buffer.concat([...this.parts, this.lineBuffer.subarray(0, this.used), tail])
      : Buffer.from(tail.buffer, tail.byteOffset, tail.byteLength);
    let line = bytes.toString('utf8'); this.parts = []; this.used = 0;
    // An SSE stream may start with one UTF-8 BOM, including one split across input chunks.
    if (this.firstLine) { this.firstLine = false; if (line.charCodeAt(0) === 0xfeff) line = line.slice(1); }
    if (!line) { this.dispatch(); this.bytes = 0; return; }
    if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
  }
  private append(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.length) {
      const size = Math.min(bytes.length - offset, this.lineBuffer.length - this.used);
      this.lineBuffer.set(bytes.subarray(offset, offset + size), this.used); this.used += size; offset += size;
      if (this.used === this.lineBuffer.length) { this.parts.push(this.lineBuffer); this.lineBuffer = Buffer.allocUnsafe(16 * 1024); this.used = 0; }
    }
  }
  private dispatch(): void {
    if (!this.data.length) return;
    const data = this.data.join('\n'); this.data = [];
    if (data === '[DONE]') { this.ended = true; return; }
    let event: unknown;
    try { event = JSON.parse(data); }
    catch { logSafe('sse-frame-skipped', { bytes: Buffer.byteLength(data) }); return; }
    if (!isRecord(event)) { logSafe('sse-frame-skipped', { bytes: Buffer.byteLength(data) }); return; }
    this.consume(event as StreamEvent);
    this.ended = this.terminal.has(String(event.type));
  }
}

/** Stop reading immediately, even when the source's asynchronous cleanup remains pending. */
export function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  void reader.cancel(reason).catch(() => {});
  reader.releaseLock();
}

/** Stops on the first terminal event; a dropped stream remains a transport failure. */
export async function sseEvents(response: Response, consume: (event: StreamEvent) => void, terminal: ReadonlySet<string> = TERMINAL_EVENTS): Promise<void> {
  if (!response.body) throw new Error('Missing upstream response');
  const reader = response.body.getReader();
  const parser = new SseParser(consume, terminal);
  try {
    while (!parser.ended) {
      const { value, done } = await reader.read();
      if (done) { parser.finish(); break; }
      parser.feed(value);
    }
    if (!parser.ended) throw new ProxyTransportError();
  } finally { cancelReader(reader); }
}
