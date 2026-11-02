import { positiveInt } from '../env';
import { logSafe } from '../log';

export const streamBufferBytes = () => positiveInt('STREAM_BUFFER_BYTES', 32 * 1024 * 1024);
export class SlowConsumerError extends Error {
  constructor() { super('Client is not reading model output; the bounded stream was cancelled'); this.name = 'SlowConsumerError'; }
}
/** Push-only SDK callbacks cannot await a pull. Bound their queued bytes and cancel explicitly
 * rather than silently dropping tool calls or retaining an arbitrarily large response. */
export function enqueueBounded(out: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array, cancel: (reason: Error) => void): void {
  if (bytes.byteLength > (out.desiredSize ?? 0)) {
    const error = new SlowConsumerError();
    logSafe('slow-consumer', { queued_limit_bytes: streamBufferBytes(), rejected_bytes: bytes.byteLength });
    cancel(error); throw error;
  }
  out.enqueue(bytes);
}
export const byteStrategy = (): QueuingStrategy<Uint8Array> => ({ highWaterMark: streamBufferBytes(), size: bytes => bytes?.byteLength ?? 0 });
