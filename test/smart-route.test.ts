import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY, loadSmartConfig, rank, scoreCandidate, SmartRouter, type Candidate, type UsageSnapshot } from '../src/router/smart-route';
import { claudeOauthSnapshot, claudeRouterSnapshot, codexSnapshot } from '../src/router/usage-poller';

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

test('a window that already reset counts as fresh', () => {
  const s = scoreCandidate(opus[0]!, { updatedAt: now - DAY, windows: [{ name: 'weekly', used: 0.99, resetsAt: now - 10, minutes: 10_080 }] }, now);
  expect(s.usable).toBe(true);
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
  snaps.whop = week(0.6, 3.5); // fastwhop now better, but the conversation stays while warm
  expect(router.resolve('auto-claude-opus-5-5', 'c1').slug).toBe('whop-claude-opus-5-5');
  expect(router.resolve('auto-claude-opus-5-5', 'c2').slug).toBe('fastwhop-claude-opus-5-5');
  t += 31 * 60; // idle: re-pick
  expect(router.resolve('auto-claude-opus-5-5', 'c1')).toMatchObject({ slug: 'fastwhop-claude-opus-5-5', switched: true });
  snaps.fastwhop = week(0.99, 3.5); // blocked mid-conversation: move now
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
