import { describe, expect, test } from 'bun:test';
import { CursorBridgePool } from '../src/backends/cursor-pool';

describe('Cursor bounded exclusive bridge pool', () => {
  const fixture = (limit = 2, idleMs = 1000) => {
    let next = 0;
    const destroyed: number[] = [];
    const pool = new CursorBridgePool(limit, idleMs,
      async (key: string) => ({ id: ++next, key, live: true }),
      async value => { value.live = false; destroyed.push(value.id); }, value => value.live);
    return { pool, destroyed, created: () => next };
  };

  test('caps resident bridges, queues fairly, and aborting a queued request leaves active owners intact', async () => {
    const f = fixture();
    try {
      const a = await f.pool.acquire('key'), b = await f.pool.acquire('key');
      const cancel = new AbortController();
      const queued = f.pool.acquire('key', cancel.signal);
      cancel.abort(new Error('cancel queued'));
      await expect(queued).rejects.toThrow('cancel queued');
      let acquired = false;
      const c = f.pool.acquire('key').then(lease => { acquired = true; return lease; });
      await Bun.sleep(5);
      expect(acquired).toBe(false); expect(f.created()).toBe(2);
      expect(a.value.live).toBe(true); expect(b.value.live).toBe(true);
      a.release();
      const reused = await c;
      expect(reused.value.id).toBe(a.value.id); expect(reused.reused).toBe(true);
      reused.release(); b.release();
    } finally { await f.pool.close(); }
    expect(f.destroyed).toHaveLength(2);
  });

  test('rotation replaces idle credentials; preferred idle sessions are selected without reserving permits', async () => {
    const f = fixture();
    try {
      const a = await f.pool.acquire('one'), b = await f.pool.acquire('one');
      a.release(); b.release();
      const continued = await f.pool.acquire('one', undefined, b.value);
      expect(continued.value).toBe(b.value); continued.release();
      const rotated = await f.pool.acquire('two');
      expect(rotated.value.key).toBe('two'); expect(rotated.reused).toBe(false);
      expect(f.destroyed.sort()).toEqual([1, 2]); rotated.release();
    } finally { await f.pool.close(); }
  });

  test('dead bridges and startup failures free capacity; idle bridges expire', async () => {
    const f = fixture(1, 20);
    try {
      const first = await f.pool.acquire('key');
      first.value.live = false; first.release();
      const second = await f.pool.acquire('key');
      expect(second.value.id).toBe(2); second.release();
      await Bun.sleep(40);
      expect(f.destroyed).toEqual([1, 2]);
    } finally { await f.pool.close(); }
    let attempts = 0;
    const broken = new CursorBridgePool(1, 20, async () => {
      if (++attempts === 1) throw new Error('startup failed');
      return { alive: true };
    }, async () => {}, value => value.alive);
    try {
      const first = broken.acquire('key');
      const second = broken.acquire('key');
      await expect(first).rejects.toThrow('startup failed');
      (await second).release();
    } finally { await broken.close(); }
  });

  test('closing during startup aborts it and rejects all queued requests', async () => {
    let startupSignal: AbortSignal | undefined;
    const pool = new CursorBridgePool(1, 20, async (_key: string, signal?: AbortSignal) => {
      startupSignal = signal;
      await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('startup cancelled')), { once: true }));
      return {};
    }, async () => {}, () => true);
    const first = pool.acquire('key').catch((error: unknown) => error);
    const second = pool.acquire('key').catch((error: unknown) => error);
    await pool.close();
    expect(await first).toEqual(new Error('startup cancelled'));
    expect(await second).toEqual(new Error('Cursor bridge pool is closed'));
    expect(startupSignal?.aborted).toBe(true);
  });
});
