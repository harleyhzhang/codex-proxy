import { Readable, Transform } from 'node:stream';
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
  const chunks: Buffer[] = [];
  let wire = 0, decoded = 0;
  const frames = encoding === 'zstd' ? new ZstdFrames(limit) : undefined;
  const wireLimit = new Transform({ transform(chunk: Buffer, _encoding, done) {
    wire += chunk.byteLength;
    if (wire > limit) { done(new Error('Request too large')); return; }
    try { frames?.feed(chunk); done(null, chunk); } catch (error) { done(error instanceof Error ? error : new Error('Invalid Zstd framing')); }
  }, flush(done) {
    try { frames?.finish(); done(); } catch { done(new Error('Invalid Zstd framing')); }
  } });
  const collect = new Transform({ transform(chunk: Buffer, _encoding, done) {
    decoded += chunk.byteLength;
    if (decoded > limit) { done(new Error('Request too large')); return; }
    chunks.push(chunk); done();
  } });
  // Bun and @types/node spell the same WHATWG stream with different convenience methods.
  const source = Readable.fromWeb(req.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  try {
    if (encoding === 'zstd') {
      const decoder = createZstdDecompress({ chunkSize: 16 * 1024, params: { [constants.ZSTD_d_windowLogMax]: 27 } });
      await pipeline(source, wireLimit, decoder, collect, { signal: req.signal });
    } else await pipeline(source, wireLimit, collect, { signal: req.signal });
  } catch (error) {
    if (req.signal.aborted) throw req.signal.reason;
    if (error instanceof Error && error.message === 'Request too large') throw error;
    throw new Error('Request body is not valid compressed data');
  }
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
  ended = false;
  constructor(private readonly consume: (event: StreamEvent) => void,
    private readonly terminal: ReadonlySet<string> = TERMINAL_EVENTS, private readonly limit = MAX_EVENT_BYTES) {}

  feed(chunk: Uint8Array): void {
    if (this.ended) return;
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]!;
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
      this.append(chunk.subarray(start, i)); start = i + 1;
      this.line(); this.skipLf = byte === 13;
      if (this.ended) return;
    }
    if (start < chunk.length) this.append(chunk.subarray(start));
  }
  finish(): void {
    if (this.ended) return;
    if (this.parts.length || this.used) this.line();
    if (!this.ended) this.dispatch();
  }
  private line(): void {
    const line = Buffer.concat([...this.parts, this.lineBuffer.subarray(0, this.used)]).toString('utf8'); this.parts = []; this.used = 0;
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
  } finally { await reader.cancel().catch(() => {}); }
}
