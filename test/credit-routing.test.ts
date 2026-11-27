import { expect, test } from 'bun:test';
import { DEFAULT_POLICY, rank, SmartRouter, type Candidate, type UsageSnapshot } from '../src/router/smart-route';
import { claudeOauthSnapshot, claudeRouterSnapshot, mergeUsageSnapshots } from '../src/router/usage-poller';

const now = 1_800_000_000;
const candidates: Candidate[] = [
  { slug: 'team-opus', usage: 'team', tier: 'work', creditWeight: 1 },
  { slug: 'preferred-opus', usage: 'preferred', tier: 'work', creditWeight: 2 },
  { slug: 'personal-opus', usage: 'personal', tier: 'personal' },
];
const snapshot = (used = 1, creditUsed = 0): UsageSnapshot => ({ updatedAt: now,
  windows: [{ name: 'weekly', used, resetsAt: now + 86400, minutes: 10080 }], overage: true,
  credits: { enabled: true, used: creditUsed, limit: null, observedAt: now, resetsAt: null, currency: 'USD' },
});
const exhausted = () => ({ team: snapshot(), preferred: snapshot(), personal: snapshot() });

test('paid fallback is opt-in and only starts after every included budget is exhausted', () => {
  const snaps = exhausted();
  let result = rank(candidates, snaps, now);
  expect(result.pick).toBe('preferred-opus');
  expect(result.scores.find(s => s.slug === result.pick)).toMatchObject({ paid: true, usable: true });
  snaps.personal = snapshot(0.9999);
  result = rank(candidates, snaps, now);
  expect(result.pick).toBe('personal-opus');
  expect(result.scores.some(s => s.paid)).toBe(false);
  snaps.personal = snapshot();
  expect(rank(candidates.map(c => ({ ...c, creditWeight: undefined })), snaps, now).scores.every(s => !s.usable)).toBe(true);
});

test('temporary reservations, stale usage and broken logins with unspent budget never unlock paid usage', () => {
  for (const pending of [snapshot(0.5), snapshot(1), snapshot(0.5)]) {
    const snaps = exhausted();
    snaps.personal = pending;
    if (pending.windows[0]!.used < 1) pending.windows[0]!.reserved = 0.6;
    else pending.updatedAt = now - 181;
    pending.blocked = 'authentication required';
    const result = rank(candidates, snaps, now);
    expect(result.scores.every(s => !s.usable)).toBe(true);
    expect(result.scores.some(s => s.paid)).toBe(false);
  }
  const snaps = exhausted(); snaps.personal = snapshot(0.9999);
  const router = new SmartRouter({ policy: DEFAULT_POLICY, routes: { auto: candidates } }, () => snaps, () => now);
  router.reserve('personal-opus');
  expect(router.resolve('auto').scores.every(s => !s.usable)).toBe(true);
  expect(router.reservationBlocked('auto')).toBe(true);
});

test('paid balance favors the preferred account, then moves when its weighted spend catches up', () => {
  const snaps = exhausted();
  snaps.team.credits!.used = 10; snaps.preferred.credits!.used = 10;
  expect(rank(candidates, snaps, now).pick).toBe('preferred-opus');
  snaps.preferred.credits!.used = 30;
  expect(rank(candidates, snaps, now).pick).toBe('team-opus');
});

test('hard credit caps, unavailable credits, auth failure and stale credit counters remain excluded', () => {
  for (const change of [
    (s: UsageSnapshot) => { s.credits!.limit = s.credits!.used; },
    (s: UsageSnapshot) => { s.credits!.enabled = false; },
    (s: UsageSnapshot) => { s.overage = false; },
    (s: UsageSnapshot) => { s.blocked = 'authentication required'; },
    (s: UsageSnapshot) => { s.credits!.observedAt = now - 181; },
    (s: UsageSnapshot) => { delete s.credits; },
  ]) {
    const snaps = exhausted(); change(snaps.preferred);
    const result = rank(candidates, snaps, now);
    expect(result.pick).toBe('team-opus');
    expect(result.scores.find(s => s.slug === 'preferred-opus')!.usable).toBe(false);
  }
  const snaps = exhausted(); snaps.personal.credits!.used = 0;
  expect(rank(candidates.map(c => ({ ...c, creditWeight: c.tier === 'personal' ? 1000 : c.creditWeight })), snaps, now).pick).toBe('preferred-opus');
});

test('a refreshed included allowance wins immediately over a warm paid conversation', () => {
  const snaps = exhausted();
  const router = new SmartRouter({ policy: DEFAULT_POLICY, routes: { auto: candidates } }, () => snaps, () => now);
  expect(router.resolve('auto', 'warm').slug).toBe('preferred-opus');
  snaps.personal = snapshot(0.9999);
  expect(router.resolve('auto', 'warm')).toMatchObject({ slug: 'personal-opus', switched: true });
});

test('in-flight paid reservations balance equal weighted spend while waiting for metering', () => {
  let clock = now;
  const snaps = exhausted(); snaps.preferred.credits!.used = 1;
  const router = new SmartRouter({ policy: DEFAULT_POLICY, routes: { auto: candidates } }, () => snaps, () => clock);
  const done = router.reserve('team-opus', true);
  expect(router.resolve('auto').slug).toBe('preferred-opus');
  done(); clock++;
  snaps.team.updatedAt = clock; // partial quota headers do not clear the paid reserve
  expect(router.resolve('auto').slug).toBe('preferred-opus');
  snaps.team.credits!.observedAt = clock;
  expect(router.resolve('auto').slug).toBe('team-opus');
});

test('flat and structured provider credit counters normalize currency units and hard caps', () => {
  const flat = claudeOauthSnapshot({ seven_day: { utilization: 100 },
    extra_usage: { is_enabled: true, used_credits: 12345, monthly_limit: null, decimal_places: 2, currency: 'USD' } }, now)!;
  expect(flat.credits).toMatchObject({ enabled: true, used: 123.45, limit: null, observedAt: now, currency: 'USD' });
  const structured = claudeOauthSnapshot({ seven_day: { utilization: 100 }, spend: { enabled: true,
    used: { amount_minor: 12345, exponent: 2, currency: 'USD' }, limit: { amount_minor: 20000, exponent: 2, currency: 'USD' } } }, now)!;
  expect(structured.credits).toMatchObject({ used: 123.45, limit: 200 });
  expect(structured.overage).toBe(true);
  const partial = claudeRouterSnapshot({ updated_at: now + 1, seven_day: { used_percent: 100 }, overage_status: 'allowed', status: 'rejected' })!;
  expect(partial.blocked).toBeUndefined();
  const merged = mergeUsageSnapshots(structured, partial);
  expect(merged.credits).toEqual(structured.credits);
  expect(merged.credits!.observedAt).toBe(now);
  const disabled = claudeOauthSnapshot({ seven_day: { utilization: 100 },
    extra_usage: { is_enabled: false, used_credits: 12345, monthly_limit: null } }, now + 2)!;
  expect(mergeUsageSnapshots(merged, disabled).credits!.enabled).toBe(false);
});

test('credit balancing does not compare unlike currencies', () => {
  const snaps = exhausted(); snaps.team.credits!.currency = 'CAD';
  expect(rank(candidates, snaps, now).scores.every(s => !s.usable)).toBe(true);
});

test('fresh provider credit permission keeps paid work moving when spend telemetry is delayed', () => {
  const snaps = exhausted();
  snaps.preferred.credits!.observedAt = now - 1000;
  snaps.preferred.creditAccess = { allowed: true, observedAt: now };
  expect(rank(candidates, snaps, now).pick).toBe('preferred-opus');
  delete snaps.preferred.credits;
  expect(rank(candidates, snaps, now).pick).toBe('preferred-opus');
  snaps.preferred.creditAccess.allowed = false;
  expect(rank(candidates, snaps, now).pick).toBe('team-opus');
});
