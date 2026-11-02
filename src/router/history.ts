// Full-history replay for native previous_response_id continuations.
import type { OutputItem, ResponseInputItem, ResponseObject, ResponsesBody } from '../protocol/types';

const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 512;
const MAX_BYTES = 512 * 1024 * 1024;

export class HistoryMiss extends Error {
  constructor(message = 'Previous response expired; retry with full conversation history') { super(message); this.name = 'HistoryMiss'; }
}
type Payload = { bytes: number; refs: number };
type Entry = { input: ResponseInputItem[]; output: OutputItem[]; payloads: Set<object>; bytes: number; until: number };
export type HistoryOptions = { maxBytes?: number; maxEntries?: number; ttlMs?: number; sweepMs?: number; now?: () => number };

export class HistoryCache {
  private readonly entries = new Map<string, Entry>();
  private readonly payloads = new Map<object, Payload>();
  private readonly frozen = new WeakSet<object>();
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
  close(): void { clearInterval(this.sweep); this.entries.clear(); this.payloads.clear(); this.bytes = 0; }
  get retainedBytes(): number { return this.bytes; }
  get size(): number { return this.entries.size; }

  /** Shared item objects are immutable and charged once while any entry owns them. Independently
   * parsed replays are charged independently. Each entry also pays for its arrays and references. */
  remember(body: ResponsesBody, response: ResponseObject | undefined): void {
    if (!response?.id || !Array.isArray(response.output) || !Array.isArray(body.input)) return;
    const input = response.output.some(item => item.type === 'compaction') ? [] : [...body.input];
    const output = [...response.output];
    const payloads = new Set<object>([...input, ...output]);
    const bytes = 256 + 64 * (input.length + output.length);
    // Retain before releasing a replacement: common items keep their existing charge.
    for (const item of payloads) {
      let payload = this.payloads.get(item);
      if (!payload) {
        this.freeze(item);
        payload = { bytes: Buffer.byteLength(JSON.stringify(item)) + 128, refs: 0 };
        this.payloads.set(item, payload); this.bytes += payload.bytes;
      }
      payload.refs++;
    }
    const old = this.entries.get(response.id);
    if (old) this.release(old);
    this.entries.delete(response.id);
    this.entries.set(response.id, { input, output, payloads, bytes, until: this.now() + (this.options.ttlMs ?? TTL_MS) });
    this.bytes += bytes; this.evict();
  }
  private freeze(value: object): void {
    const pending = [value];
    while (pending.length) {
      const item = pending.pop()!;
      if (this.frozen.has(item)) continue;
      this.frozen.add(item);
      for (const child of Object.values(item)) if (child !== null && typeof child === 'object') pending.push(child);
      Object.freeze(item);
    }
  }
  private release(entry: Entry): void {
    this.bytes -= entry.bytes;
    for (const item of entry.payloads) {
      const payload = this.payloads.get(item)!;
      if (--payload.refs === 0) { this.payloads.delete(item); this.bytes -= payload.bytes; }
    }
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
      this.entries.delete(id); this.release(entry);
    }
  }
}
