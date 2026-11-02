import { logSafe } from '../log';
import { BackendError } from './contract';

type Waiter = { priority: number; resolve(release: () => void): void; reject(reason: unknown): void; signal?: AbortSignal; abort(): void; started: number };
/** Bounded per-account model work. A lease ends at a tool yield, so its continuation can always
 * enter again. Continuations outrank fresh work; cancelled waiters never consume a permit. */
export class Admission {
  private active = 0;
  private readonly queue: Waiter[] = [];
  constructor(private readonly provider: string, private readonly capacity: number, private readonly maxQueued = 64) {}
  async acquire(signal?: AbortSignal, priority = 0): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.capacity && !this.queue.length) { this.active++; return this.lease(); }
    if (this.queue.length >= this.maxQueued) throw new BackendError(`${this.provider} request queue is full; retry when other turns finish`, { code: 'server_is_overloaded' });
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { priority, resolve, reject, signal, started: performance.now(), abort: () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal?.reason);
      } };
      this.queue.push(waiter);
      this.queue.sort((a, b) => b.priority - a.priority);
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
  }
  private lease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true; this.active--;
      const waiter = this.queue.shift();
      if (!waiter) return;
      waiter.signal?.removeEventListener('abort', waiter.abort);
      this.active++;
      logSafe('provider-admission', { provider: this.provider, queue_ms: Math.round(performance.now() - waiter.started), active: this.active, queued: this.queue.length, continuation: waiter.priority > 0 });
      waiter.resolve(this.lease());
    };
  }
}
