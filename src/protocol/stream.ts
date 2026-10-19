import { isRecord, type JsonRecord } from '../json';
import { logSafe } from '../log';
import { ProxyTransportError } from '../transport';
import type { StreamEvent } from './types';

/** Full conversation replays include base64 images/tool output even below the token window. */
export const MAX_BODY_BYTES = 128 * 1024 * 1024;
/** A single upstream event does not need the larger conversation replay allowance. */
const MAX_EVENT_BYTES = 32 * 1024 * 1024;

const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);

/**
 * Reads a JSON object body with a hard size cap, enforced while streaming rather than after
 * buffering. Codex compresses large bodies with zstd; no other encoding is accepted.
 */
export async function decodeBody(req: Request): Promise<JsonRecord> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw new Error('Request too large');
  const reader = req.body?.getReader();
  if (!reader) throw new Error('Missing request body');

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('Request too large');
    }
    chunks.push(value);
  }

  let bytes = Buffer.concat(chunks);
  const encoding = req.headers.get('content-encoding');
  if (encoding === 'zstd') bytes = Buffer.from(Bun.zstdDecompressSync(bytes));
  else if (encoding && encoding !== 'identity') throw new Error('Unsupported request encoding');
  if (bytes.length > MAX_BODY_BYTES) throw new Error('Request too large');

  let body: unknown;
  try { body = JSON.parse(bytes.toString()); } catch { throw new Error('Request body is not valid JSON'); }
  if (!isRecord(body)) throw new Error('Request body must be a JSON object');
  return body;
}

/**
 * Feeds each server-sent event to `consume` and resolves at the first terminal event. A stream
 * that ends without one was dropped, so it rejects with a retryable transport error.
 */
export async function sseEvents(response: Response, consume: (event: StreamEvent) => void): Promise<void> {
  if (!response.body) throw new Error('Missing upstream response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleFrame = (frame: string): boolean => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return false;
    if (data === '[DONE]') return true;
    let event: StreamEvent;
    // Native Codex skips a frame it cannot parse and keeps reading; one bad frame must not fail the turn.
    try { event = JSON.parse(data) as StreamEvent; }
    catch { logSafe('sse-frame-skipped', { bytes: data.length }); return false; }
    if (!isRecord(event)) { logSafe('sse-frame-skipped', { bytes: data.length }); return false; }
    consume(event);
    return TERMINAL_EVENTS.has(event.type);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) if (handleFrame(frame)) return;
      if (buffer.length > MAX_EVENT_BYTES) throw new Error('Upstream event too large');
    }
    buffer += decoder.decode();
    if (buffer.trim() && handleFrame(buffer)) return;
    throw new ProxyTransportError();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
