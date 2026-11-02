import { expect, test } from 'bun:test';
import { HistoryCache, HistoryMiss } from '../src/router/history';
import type { ResponseInputItem } from '../src/protocol/types';

test('incremental histories charge shared immutable items once, including across replacement and eviction', () => {
  const cache = new HistoryCache({ maxBytes: 20_000, maxEntries: 3 });
  const shared = { role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(8000) }] };
  try {
    let input: ResponseInputItem[] = [shared];
    for (let i = 0; i < 10; i++) {
      input = [...input, { role: 'user', content: String(i) }];
      cache.remember({ input }, { id: `r${i}`, output: [] });
    }
    expect(cache.size).toBe(3);
    expect(cache.retainedBytes).toBeGreaterThan(8000);
    expect(cache.retainedBytes).toBeLessThan(15_000);
    const before = cache.retainedBytes;
    cache.remember({ input }, { id: 'r9', output: [] });
    expect(cache.retainedBytes).toBe(before);
    expect(() => cache.expand({ previous_response_id: 'r0', input: [] })).toThrow(HistoryMiss);
    expect(cache.expand({ previous_response_id: 'r9', input: [] }).input).toEqual(input);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared.content[0])).toBe(true);
    // The cache owns its arrays; extending the caller's array cannot change a retained history.
    input.push({ role: 'user', content: 'not retained' });
    expect((cache.expand({ previous_response_id: 'r9', input: [] }).input as unknown[]).length).toBe(11);
  } finally { cache.close(); }
  expect(cache.retainedBytes).toBe(0);
});

test('independent full replays stay independently charged and oversized entries release every reference', () => {
  const cache = new HistoryCache({ maxBytes: 3500, maxEntries: 10 });
  try {
    for (let i = 0; i < 5; i++) cache.remember({ input: [{ role: 'user', content: 'x'.repeat(1000) }] }, { id: `r${i}`, output: [] });
    expect(cache.size).toBe(2);
    expect(cache.retainedBytes).toBeLessThanOrEqual(3500);
    cache.remember({ input: [{ role: 'user', content: 'x'.repeat(5000) }] }, { id: 'huge', output: [] });
    expect(cache.size).toBe(0);
    expect(cache.retainedBytes).toBe(0);
    expect(() => cache.expand({ previous_response_id: 'huge', input: [] })).toThrow(HistoryMiss);
    cache.remember({ input: [{ role: 'user', content: 'full replay' }] }, { id: 'fresh', output: [] });
    expect(cache.expand({ previous_response_id: 'fresh', input: [] }).input).toEqual([{ role: 'user', content: 'full replay' }]);
  } finally { cache.close(); }
});

test('expiry transfers no charge away from a surviving owner, and compaction releases historical input', () => {
  let now = 0;
  const cache = new HistoryCache({ ttlMs: 10, now: () => now });
  const input = [{ role: 'user', content: 'x'.repeat(5000) }];
  try {
    cache.remember({ input }, { id: 'old', output: [] });
    now = 5; cache.remember({ input }, { id: 'new', output: [] });
    now = 11;
    expect(cache.expand({ previous_response_id: 'new', input: [] }).input).toEqual(input);
    expect(cache.size).toBe(1); expect(cache.retainedBytes).toBeGreaterThan(5000);
    cache.remember({ input }, { id: 'new', output: [{ type: 'compaction', encrypted_content: 'sealed' }] });
    expect(cache.retainedBytes).toBeLessThan(1000);
    expect(cache.expand({ previous_response_id: 'new', input: [] }).input).toEqual([{ type: 'compaction', encrypted_content: 'sealed' }]);
  } finally { cache.close(); }
});
