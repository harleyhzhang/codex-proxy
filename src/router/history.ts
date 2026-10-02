// Codex continues WebSocket turns with `previous_response_id`, but neither the ChatGPT HTTP
// endpoint nor a CLI backend accepts it, so the router replays the full history itself.
import type { OutputItem, ResponseInputItem, ResponseObject, ResponsesBody } from '../protocol/types';

const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 512;
const MAX_BYTES = 512 * 1024 * 1024;

/** The previous response is gone, so Codex must resend the whole conversation. */
export class HistoryMiss extends Error {
  constructor(message = 'Previous response expired; retry with full conversation history') {
    super(message);
    this.name = 'HistoryMiss';
  }
}

type Entry = { input: ResponseInputItem[]; output: OutputItem[]; bytes: number; until: number };

export class HistoryCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  /**
   * Records a finished turn. Entries share item references with the requests they came from, so
   * only the new bytes are counted. A compaction starts a fresh history.
   */
  remember(body: ResponsesBody, response: ResponseObject | undefined, deltaBytes = 0): void {
    if (!response?.id || !Array.isArray(response.output) || !Array.isArray(body.input)) return;
    const compacted = response.output.some((item) => item.type === 'compaction');
    const entry: Entry = {
      input: compacted ? [] : body.input,
      output: response.output,
      bytes: deltaBytes + Buffer.byteLength(JSON.stringify(response.output)),
      until: Date.now() + TTL_MS,
    };
    const old = this.entries.get(response.id);
    if (old) this.bytes -= old.bytes;
    this.entries.set(response.id, entry);
    this.bytes += entry.bytes;
    this.evict();
  }

  /** Replaces `previous_response_id` with the history it refers to. */
  expand(body: ResponsesBody): ResponsesBody {
    if (!body.previous_response_id) return body;
    const previous = this.entries.get(body.previous_response_id);
    if (!previous || previous.until < Date.now()) throw new HistoryMiss();
    const latest: ResponseInputItem[] = Array.isArray(body.input) ? body.input : [{ role: 'user', content: body.input }];
    const { previous_response_id: _previous, ...rest } = body;
    return { ...rest, input: [...previous.input, ...(previous.output as ResponseInputItem[]), ...latest] };
  }

  /** Drops expired entries, then the oldest, until the cache fits its limits. */
  private evict(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.until >= now && this.bytes <= MAX_BYTES && this.entries.size <= MAX_ENTRIES) continue;
      this.entries.delete(id);
      this.bytes -= entry.bytes;
    }
  }
}
