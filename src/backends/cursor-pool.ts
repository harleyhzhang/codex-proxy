/** Exclusive leases keep a cancelled Cursor run from ever killing another request's bridge. */
export type CursorLease<T> = {
  value: T; reused: boolean;
  /** Returns the bridge to the pool. */
  release(): void;
  discard(): Promise<void>;
};
type Entry<T> = { key: string; value?: T; busy: boolean; startup?: AbortController; timer?: ReturnType<typeof setTimeout>; idleSince?: number };
type Waiter<T> = {
  key: string; signal?: AbortSignal;
  resolve(lease: CursorLease<T>): void; reject(error: unknown): void; abort(): void;
};

/**
 * A bounded resident pool, including startup and cleanup. Idle sessions yield immediately to work.
 * Idle bridges expire after `idleMs`, except that the last `warm` idle bridges per key stay for
 * `warmIdleMs`, so a pause between messages does not pay a cold bridge start.
 */
export class CursorBridgePool<T> {
  private readonly entries = new Set<Entry<T>>();
  private readonly waiting: Waiter<T>[] = [];
  private readonly disposing = new Set<Promise<void>>();
  private readonly creating = new Set<Promise<void>>();
  private draining = false;
  private closed = false;

  constructor(
    private readonly limit: number,
    private readonly idleMs: number,
    private readonly create: (key: string, signal?: AbortSignal) => Promise<T>,
    private readonly destroy: (value: T) => Promise<void>,
    private readonly alive: (value: T) => boolean,
    private readonly warm = 0,
    private readonly warmIdleMs = idleMs,
  ) {}

  acquire(key: string, signal?: AbortSignal): Promise<CursorLease<T>> {
    signal?.throwIfAborted();
    if (this.closed) return Promise.reject(new Error('Cursor bridge pool is closed'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter<T> = {
        key, signal, resolve, reject,
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          signal?.removeEventListener('abort', waiter.abort);
          reject(signal?.reason);
        },
      };
      this.waiting.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.drain();
    });
  }

  /** Starts one bridge ahead of demand, unless one for this key is idle or starting, or capacity is taken. */
  prewarm(key: string): void {
    if (this.closed || this.waiting.length || this.entries.size + this.disposing.size >= this.limit) return;
    if ([...this.entries].some(entry => entry.key === key && (!entry.busy || entry.startup))) return;
    this.acquire(key).then(lease => lease.release(), () => {});
  }

  private drain(): void {
    if (this.closed || this.draining) return;
    this.draining = true;
    try {
      while (this.waiting.length) {
        const waiter = this.waiting[0]!;
        if (waiter.signal?.aborted) { waiter.abort(); continue; }
        // Prune dead/rotated idle bridges before counting capacity. Active leases keep their owner.
        for (const entry of this.entries) {
          if (!entry.busy && entry.value && (!this.alive(entry.value) || entry.key !== waiter.key)) this.evict(entry);
        }
        let entry = [...this.entries].find(entry => !entry.busy && entry.key === waiter.key);
        if (!entry && this.entries.size + this.disposing.size >= this.limit) return;
        this.waiting.shift();
        waiter.signal?.removeEventListener('abort', waiter.abort);
        if (entry) {
          clearTimeout(entry.timer); entry.timer = undefined; entry.busy = true;
          waiter.resolve(this.lease(entry, true));
        } else {
          entry = { key: waiter.key, busy: true, startup: new AbortController() };
          this.entries.add(entry);
          const reserved = entry;
          const startupSignal = waiter.signal ? AbortSignal.any([waiter.signal, entry.startup!.signal]) : entry.startup!.signal;
          const starting = this.create(waiter.key, startupSignal).then(value => {
            reserved.startup = undefined;
            reserved.value = value;
            if (this.closed || waiter.signal?.aborted) {
              this.evict(reserved);
              waiter.reject(waiter.signal?.reason ?? new Error('Cursor bridge pool is closed'));
            } else waiter.resolve(this.lease(reserved, false));
          }, error => {
            reserved.startup = undefined; this.entries.delete(reserved); waiter.reject(error); this.drain();
          });
          this.creating.add(starting);
          void starting.finally(() => this.creating.delete(starting));
        }
      }
    } finally { this.draining = false; }
  }

  private lease(entry: Entry<T>, reused: boolean): CursorLease<T> {
    let released = false;
    return {
      value: entry.value!, reused,
      release: () => {
        if (released) return;
        released = true;
        if (this.closed || !this.alive(entry.value!)) { this.evict(entry); return; }
        entry.busy = false;
        entry.idleSince = Date.now();
        entry.timer = setTimeout(() => this.expire(entry), this.idleMs);
        entry.timer.unref?.();
        this.drain();
      },
      discard: async () => {
        if (released) return;
        released = true;
        await this.evict(entry);
      },
    };
  }

  /** The idle window passed: evict, unless this is one of the key's last `warm` idle bridges. */
  private expire(entry: Entry<T>): void {
    const others = [...this.entries].filter(other => other !== entry && !other.busy && other.key === entry.key).length;
    const remaining = (entry.idleSince ?? 0) + this.warmIdleMs - Date.now();
    if (others < this.warm && remaining > 0) {
      entry.timer = setTimeout(() => this.expire(entry), remaining);
      entry.timer.unref?.();
      return;
    }
    void this.evict(entry);
  }

  private evict(entry: Entry<T>): Promise<void> {
    clearTimeout(entry.timer);
    if (!this.entries.delete(entry)) return Promise.resolve();
    const pending = Promise.resolve().then(() => entry.value ? this.destroy(entry.value) : undefined).catch(() => {});
    this.disposing.add(pending);
    void pending.finally(() => { this.disposing.delete(pending); this.drain(); });
    this.drain();
    return pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.reject(new Error('Cursor bridge pool is closed'));
    }
    for (const entry of this.entries) entry.startup?.abort();
    await Promise.all([...this.entries].filter(entry => entry.value).map(entry => this.evict(entry)));
    await Promise.all(this.creating);
    await Promise.all(this.disposing);
  }
}
