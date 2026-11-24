// Replays a real demand trace against simulated account allowances and compares routing policies.
// Usage: bun scripts/smart-route-bench.ts <bench.json>
// bench.json: { start, days, demand: [{ts, conv, family, account, tokens}], accounts: {id: {...}}, families: {family: [Candidate]} }
// Each account: { windows: [{name, used, resetsAt, minutes, k, rolling?}], overage, blocked?, blockedUntil? }
// k = fraction of the window one weighted token uses (calibrated from observed usage deltas).
import { readFileSync } from 'node:fs';
import { DEFAULT_POLICY, rank, type Candidate, type SmartPolicy, type UsageSnapshot } from '../src/router/smart-route';

type SimWindow = { name: string; used: number; resetsAt: number | null; minutes: number; k: number; rolling?: boolean };
type SimAccount = { windows: SimWindow[]; overage?: boolean; blocked?: string; blockedUntil?: number | null };
type Row = { ts: number; conv: string; family: string; account: string; tokens: number };
type Bench = { start: number; days: number; scale?: number; demand: Row[]; accounts: Record<string, SimAccount>; families: Record<string, Candidate[]> };

const bench: Bench = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const slugToUsage = new Map(Object.values(bench.families).flat().map(c => [c.slug, c]));

function replay(policy: string, scale: number, smartPolicy: SmartPolicy = DEFAULT_POLICY) {
  const accounts: Record<string, SimAccount> = structuredClone(bench.accounts);
  const stats = { turns: 0, overLimit: 0, overageTokens: 0, personal: 0, switches: 0, byAccount: {} as Record<string, number>, peak: {} as Record<string, number>, wastedAtReset: 0, resets: 0 };
  const sticky = new Map<string, { slug: string; at: number }>();
  const day0 = Math.min(...bench.demand.map(r => r.ts));
  const span = Math.max(...bench.demand.map(r => r.ts)) - day0 + 3600;
  const rows: Row[] = [];
  for (let offset = 0; offset < bench.days * 86_400; offset += span)
    for (const r of bench.demand) { const ts = bench.start + offset + (r.ts - day0); if (ts < bench.start + bench.days * 86_400) rows.push({ ...r, ts, conv: `${r.conv}#${offset}` }); }
  rows.sort((a, b) => a.ts - b.ts);
  const roll = (now: number) => {
    for (const a of Object.values(accounts)) for (const w of a.windows) {
      if (w.resetsAt != null && w.resetsAt <= now) {
        if (w.minutes > 360 && !w.rolling) { stats.wastedAtReset += Math.max(0, 1 - w.used); stats.resets++; }
        w.used = 0; w.resetsAt = w.rolling ? null : w.resetsAt + w.minutes * 60;
      }
    }
  };
  const snapshot = (a: SimAccount, now: number): UsageSnapshot => ({ updatedAt: now, overage: a.overage, blocked: a.blocked, blockedUntil: a.blockedUntil, windows: a.windows.map(w => ({ name: w.name, used: w.used, resetsAt: w.resetsAt, minutes: w.minutes })) });
  for (const r of rows) {
    roll(r.ts);
    const candidates = bench.families[r.family];
    if (!candidates) continue;
    let slug: string;
    if (policy === 'manual') slug = r.account;
    else if (policy === 'fallback') {
      // naive chain: first work account that is not over its limits, else personal
      slug = (candidates.find(c => rank([c], { [c.usage]: snapshot(accounts[c.usage]!, r.ts) }, r.ts, smartPolicy).scores[0]!.usable) ?? candidates[0]!).slug;
    } else {
      const snaps = Object.fromEntries(candidates.map(c => [c.usage, snapshot(accounts[c.usage]!, r.ts)]));
      const ranked = rank(candidates, snaps, r.ts, smartPolicy);
      slug = ranked.pick;
      const held = sticky.get(r.conv);
      if (held && r.ts - held.at < smartPolicy.idleRepickSec && ranked.scores.find(s => s.slug === held.slug)?.usable) slug = held.slug;
      if (held && held.slug !== slug) stats.switches++;
      sticky.set(r.conv, { slug, at: r.ts });
    }
    const cand = slugToUsage.get(slug);
    if (!cand) continue;
    const a = accounts[cand.usage]!;
    stats.turns++;
    const tokens = r.tokens * scale;
    const over = (a.blocked && (a.blockedUntil == null || a.blockedUntil > r.ts)) || a.windows.some(w => w.used >= 1);
    if (over) { stats.overLimit++; if (a.overage) stats.overageTokens += tokens; continue; }
    for (const w of a.windows) {
      if (w.rolling && w.resetsAt == null) w.resetsAt = r.ts + w.minutes * 60;
      w.used = Math.min(1.5, w.used + tokens * w.k);
      stats.peak[`${cand.usage}:${w.name}`] = Math.max(stats.peak[`${cand.usage}:${w.name}`] ?? 0, w.used);
    }
    stats.byAccount[cand.usage] = (stats.byAccount[cand.usage] ?? 0) + tokens;
    if (cand.tier === 'personal') stats.personal += tokens;
  }
  const total = Object.values(stats.byAccount).reduce((a, b) => a + b, 0);
  const endUsed = Object.fromEntries(Object.entries(accounts).map(([id, a]) => [id, Object.fromEntries(a.windows.filter(w => w.minutes > 360).map(w => [w.name, +(w.used * 100).toFixed(1)]))]));
  return { policy, scale, turns: stats.turns, overLimitTurns: stats.overLimit, overageTokensM: +(stats.overageTokens / 1e6).toFixed(1),
    personalShare: +(100 * stats.personal / (total || 1)).toFixed(1), switches: stats.switches,
    shareByAccount: Object.fromEntries(Object.entries(stats.byAccount).map(([k, v]) => [k, +(100 * v / total).toFixed(1)])),
    peakPct: Object.fromEntries(Object.entries(stats.peak).map(([k, v]) => [k, +(v * 100).toFixed(0)])), endUsedPct: endUsed };
}

const out = [];
for (const scale of [1, 2, 3]) for (const policy of ['manual', 'fallback', 'smart']) out.push(replay(policy, scale));
console.log(JSON.stringify(out, null, 1));
