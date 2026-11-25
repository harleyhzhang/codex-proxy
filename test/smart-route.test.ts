import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY, loadSmartConfig, rank, scoreCandidate, SmartRouter, type Candidate, type UsageSnapshot } from '../src/router/smart-route';
import { claudeOauthSnapshot, claudeRouterSnapshot, codexSnapshot, mergeUsageSnapshots } from '../src/router/usage-poller';

const now = 1_800_000_000;
const DAY = 86_400;
const week = (used: number, daysLeft: number, extra: Partial<UsageSnapshot> = {}): UsageSnapshot =>
  ({ updatedAt: now, windows: [{ name: 'weekly', used, resetsAt: now + daysLeft * DAY, minutes: 10_080 }], ...extra });
const opus: Candidate[] = [
  { slug: 'whop-claude-opus-5-5', usage: 'whop', tier: 'work' },
  { slug: 'fastwhop-claude-opus-5-5', usage: 'fastwhop', tier: 'work' },
  { slug: 'claude-opus-5-5', usage: 'personal', tier: 'personal' },
];

test('prefers the work account furthest under pace', () => {
  const r = rank(opus, { whop: week(0.8, 1), fastwhop: week(0.2, 3.5), personal: week(0, 3.5) }, now);
  expect(r.pick).toBe('fastwhop-claude-opus-5-5');
});

test('personal is a buffer: used only when work accounts run hot', () => {
  expect(rank(opus, { whop: week(0.5, 3.5), fastwhop: week(0.5, 3.5), personal: week(0, 3.5) }, now).pick).toBe('whop-claude-opus-5-5');
  expect(rank(opus, { whop: week(0.85, 3.5), fastwhop: week(0.8, 3.5), personal: week(0.1, 3.5) }, now).pick).toBe('claude-opus-5-5');
});

test('blocks at the edge, earlier when overage would bill, and on short session windows', () => {
  expect(scoreCandidate(opus[0]!, week(0.97, 2), now).usable).toBe(false);
  expect(scoreCandidate(opus[0]!, week(0.92, 2, { overage: true }), now).usable).toBe(false);
  expect(scoreCandidate(opus[0]!, week(0.92, 2), now).usable).toBe(true);
  const session: UsageSnapshot = { updatedAt: now, windows: [{ name: 'five_hour', used: 0.91, resetsAt: now + 3600, minutes: 300 }] };
  expect(scoreCandidate(opus[0]!, session, now).usable).toBe(false);
  expect(scoreCandidate(opus[0]!, { ...week(0.1, 3), blocked: 'spend limit reached', blockedUntil: now + DAY }, now).usable).toBe(false);
  expect(scoreCandidate(opus[0]!, { ...week(0.1, 3), blocked: 'spend limit reached', blockedUntil: now - 1 }, now).usable).toBe(true);
});

test('a passed reset requires fresh verification', () => {
  const s = scoreCandidate(opus[0]!, { updatedAt: now - DAY, windows: [{ name: 'weekly', used: 0.99, resetsAt: now - 10, minutes: 10_080 }] }, now);
  expect(s.usable).toBe(false);
});

test('everything blocked falls back to the first work account (it reports its own limit)', () => {
  const full = week(1, 2);
  expect(rank(opus, { whop: full, fastwhop: full, personal: full }, now).pick).toBe('whop-claude-opus-5-5');
});

test('deterministic and sticky per conversation until blocked or idle', () => {
  let t = now;
  const snaps: Record<string, UsageSnapshot> = { whop: week(0.2, 3.5), fastwhop: week(0.3, 3.5), personal: week(0, 3.5) };
  const router = new SmartRouter({ policy: DEFAULT_POLICY, routes: { 'auto-claude-opus-5-5': opus } }, () => snaps, () => t);
  const a = router.resolve('auto-claude-opus-5-5', 'c1');
  expect(a).toMatchObject({ slug: 'whop-claude-opus-5-5', switched: false });
  snaps.whop = week(0.35, 3.5); // small differences keep the prompt cache warm
  expect(router.resolve('auto-claude-opus-5-5', 'c1').slug).toBe('whop-claude-opus-5-5');
  expect(router.resolve('auto-claude-opus-5-5', 'c2').slug).toBe('fastwhop-claude-opus-5-5');
  t += 31 * 60; // idle: re-pick, with fresh provider readings
  for (const snap of Object.values(snaps)) snap.updatedAt = t;
  expect(router.resolve('auto-claude-opus-5-5', 'c1')).toMatchObject({ slug: 'fastwhop-claude-opus-5-5', switched: true });
  snaps.fastwhop = { ...week(0.99, 3.5), updatedAt: t }; // blocked mid-conversation: move now
  expect(router.resolve('auto-claude-opus-5-5', 'c1')).toMatchObject({ slug: 'whop-claude-opus-5-5', switched: true });
});

test('parses native Codex, Claude OAuth and router snapshots', () => {
  const codex = codexSnapshot({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: now + 100 }, secondary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: now + DAY },
    credits: { hasCredits: true }, individualLimit: { limit: '4000', used: '4011', remainingPercent: 0, resetsAt: now + 7 * DAY }, spendControlReached: true } }, now)!;
  expect(codex.windows.map(w => [w.name, w.used])).toEqual([['five_hour', 0], ['weekly', 0.16], ['monthly', 1]]);
  expect(codex).toMatchObject({ blocked: 'spend limit reached', blockedUntil: now + 7 * DAY, overage: true });
  const claude = claudeOauthSnapshot({ five_hour: { utilization: 31, resets_at: '2026-11-24T06:30:00+00:00' }, seven_day: { utilization: 19, resets_at: '2026-11-27T10:00:00+00:00' }, extra_usage: { is_enabled: true } }, now)!;
  expect(claude.windows.map(w => [w.name, w.used, w.minutes])).toEqual([['five_hour', 0.31, 300], ['seven_day', 0.19, 10080]]);
  expect(claude.overage).toBe(true);
  const local = claudeRouterSnapshot({ updated_at: now, status: 'rejected', overage_status: 'rejected', five_hour: null, seven_day: { used_percent: 100, window_minutes: 10080, resets_at: now + DAY } })!;
  expect(local).toMatchObject({ blocked: 'rejected', blockedUntil: now + DAY });
});

test('config loads routes and policy overrides, rejects bad slugs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smart-'));
  expect(loadSmartConfig(dir)).toBeUndefined();
  writeFileSync(join(dir, 'smart-routes.json'), JSON.stringify({ policy: { personalWeight: 0.5 }, routes: { 'auto-claude-opus-5-5': opus } }));
  expect(loadSmartConfig(dir)!.policy.personalWeight).toBe(0.5);
  writeFileSync(join(dir, 'smart-routes.json'), JSON.stringify({ routes: { 'claude-opus-5-5': opus } }));
  expect(() => loadSmartConfig(dir)).toThrow('Invalid smart route');
});


test('auto refuses unknown, stale, empty and invalid quota readings', () => {
  for (const snap of [undefined, week(0.1, 2, { updatedAt: now - 181 }), { updatedAt: now, windows: [] },
    { updatedAt: now, windows: [{ name: 'weekly', used: NaN, resetsAt: null, minutes: 10080 }] }])
    expect(scoreCandidate(opus[0]!, snap, now).usable).toBe(false);
});

test('warm conversations move to materially healthier accounts without waiting for the idle timeout', () => {
  const snaps = { whop: week(0.1, 3.5), fastwhop: week(0.2, 3.5), personal: week(0, 3.5) };
  const router = new SmartRouter({ policy: DEFAULT_POLICY, routes: { auto: opus } }, () => snaps, () => now);
  expect(router.resolve('auto', 'warm').slug).toBe(opus[0]!.slug);
  snaps.whop = week(0.7, 3.5);
  expect(router.resolve('auto', 'warm')).toMatchObject({ slug: opus[1]!.slug, switched: true });
});

test('parallel dispatches reserve quota and completed work waits for a newer usage reading', () => {
  let clock = now;
  const snaps = { whop: week(0.85, 2, { overage: true }) };
  const router = new SmartRouter({ policy: DEFAULT_POLICY, routes: { auto: [opus[0]!] } }, () => snaps, () => clock);
  const done = [router.reserve(opus[0]!.slug), router.reserve(opus[0]!.slug), router.reserve(opus[0]!.slug)];
  expect(router.resolve('auto').scores[0]!.usable).toBe(false);
  done.forEach(finish => finish());
  expect(router.resolve('auto').scores[0]!.usable).toBe(false);
  clock++; snaps.whop.updatedAt = clock;
  expect(router.resolve('auto').scores[0]!.usable).toBe(true);
  router.reserve(opus[0]!.slug); clock++; snaps.whop.updatedAt = clock;
  expect(router.resolve('auto').scores[0]!.headroom).toBeCloseTo((1 - 0.89) / (2 / 7));
});

test('rounded response headers cannot lower usage, drop model windows or erase billing risk', () => {
  const polled = week(0.72, 2, { overage: true });
  polled.windows.push({ name: 'seven_day_opus', used: 0.95, resetsAt: now + DAY, minutes: 10080 });
  const headers = week(0.71, 2, { updatedAt: now + 1 }); headers.windows[0]!.resetsAt!++;
  const merged = mergeUsageSnapshots(polled, headers);
  expect(merged.windows.map(w => w.used)).toEqual([0.72, 0.95]);
  expect(merged.overage).toBe(true);
  expect(scoreCandidate(opus[0]!, merged, now + 1).usable).toBe(false);
  const reset = week(0.01, 7, { updatedAt: now + 2 * DAY });
  expect(mergeUsageSnapshots(polled, reset).windows[0]!.used).toBe(0.01);
});


test('the next turn must fit its reserve before it can be dispatched', () => {
  const router = new SmartRouter({ policy: DEFAULT_POLICY, routes: { auto: [opus[0]!] } }, () => ({ whop: week(0.89, 2, { overage: true }) }), () => now);
  expect(router.resolve('auto').scores[0]!.usable).toBe(false);
});

test('partial fresh headers cannot freshen an unobserved allowance; verified resets retire old windows', () => {
  const old = week(0.3, 2, { updatedAt: now - 1000 });
  old.windows.push({ name: 'expired', used: 1, resetsAt: now - 10, minutes: 300 });
  const partial: UsageSnapshot = { updatedAt: now, windows: [{ name: 'five_hour', used: 0, resetsAt: now + 3600, minutes: 300 }] };
  const merged = mergeUsageSnapshots(old, partial);
  expect(merged.windows.some(w => w.name === 'expired')).toBe(false);
  expect(scoreCandidate(opus[0]!, merged, now).usable).toBe(false);
});
