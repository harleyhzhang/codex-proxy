// Full-history replay for native previous_response_id continuations.
import type { OutputItem, ResponseInputItem, ResponseObject, ResponsesBody } from '../protocol/types';

const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 512;
const MAX_BYTES = 512 * 1024 * 1024;

export class HistoryMiss extends Error {
  constructor(message = 'Previous response expired; retry with full conversation history') { super(message); this.name = 'HistoryMiss'; }
}
type Entry = { input: ResponseInputItem[]; output: OutputItem[]; bytes: number; until: number };
export type HistoryOptions = { maxBytes?: number; maxEntries?: number; ttlMs?: number; sweepMs?: number; now?: () => number };

export class HistoryCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private readonly now: () => number;
  private readonly sweep: ReturnType<typeof setInterval>;
  constructor(private readonly options: HistoryOptions = {}) {
    this.now = options.now ?? Date.now;
    // The timer must not retain a stopped router (or keep the process alive).
    const weak = new WeakRef(this);
    const sweep = setInterval(() => { const cache = weak.deref(); if (cache) cache.evict(); else clearInterval(sweep); }, options.sweepMs ?? 60_000);
    this.sweep = sweep; sweep.unref?.();
  }
  close(): void { clearInterval(this.sweep); this.entries.clear(); this.bytes = 0; }
  get retainedBytes(): number { return this.bytes; }
  get size(): number { return this.entries.size; }

  /** Charge each entry's complete payload conservatively. Shared histories may be overcounted,
   * never undercounted: eviction of one entry cannot leave uncharged references in another. */
  remember(body: ResponsesBody, response: ResponseObject | undefined): void {
    if (!response?.id || !Array.isArray(response.output) || !Array.isArray(body.input)) return;
    const input = response.output.some(item => item.type === 'compaction') ? [] : body.input;
    const bytes = Buffer.byteLength(JSON.stringify([input, response.output])) + 128 * (input.length + response.output.length + 1);
    const old = this.entries.get(response.id);
    if (old) this.bytes -= old.bytes;
    this.entries.delete(response.id);
    this.entries.set(response.id, { input, output: response.output, bytes, until: this.now() + (this.options.ttlMs ?? TTL_MS) });
    this.bytes += bytes; this.evict();
  }
  expand(body: ResponsesBody): ResponsesBody {
    if (!body.previous_response_id) return body;
    this.evict();
    const previous = this.entries.get(body.previous_response_id);
    if (!previous) throw new HistoryMiss();
    const latest: ResponseInputItem[] = Array.isArray(body.input) ? body.input : [{ role: 'user', content: body.input }];
    const { previous_response_id: _previous, ...rest } = body;
    return { ...rest, input: [...previous.input, ...(previous.output as ResponseInputItem[]), ...latest] };
  }
  private evict(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.until > now && this.bytes <= (this.options.maxBytes ?? MAX_BYTES) && this.entries.size <= (this.options.maxEntries ?? MAX_ENTRIES)) continue;
      this.entries.delete(id); this.bytes -= entry.bytes;
    }
  }
}
