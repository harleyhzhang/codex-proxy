// Deterministic account balancing for "auto" models. An auto slug (e.g. `auto-claude-opus-5-5`) names one
// model served by several subscription accounts; each request is sent to one concrete account slug.
// No model call is involved: the choice is a pure function of the latest usage snapshots and the clock.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../json';

/** One rolling allowance: fraction used (0..1), when it resets (unix seconds) and its length. */
export type UsageWindow = { name: string; used: number; resetsAt: number | null; minutes: number; observedAt?: number; reserved?: number; requestReserve?: number };
export type UsageSnapshot = {
  updatedAt: number;
  windows: UsageWindow[];
  /** Spending beyond the windows is billed (extra usage, credits). */
  overage?: boolean;
  creditAccess?: { allowed: boolean; observedAt: number };
  /** Provider-reported paid usage, in major currency units; separate from included windows. */
  credits?: { enabled: boolean; used: number; limit: number | null; currency: string; observedAt: number; resetsAt: number | null };
  creditReserved?: number;
  /** Hard stop reported by the provider (rejected, spend control reached), until `blockedUntil`. */
  blocked?: string;
  blockedUntil?: number | null;
};
export type Candidate = { slug: string; usage: string; tier: 'work' | 'personal'; creditWeight?: number };
export type SmartPolicy = {
  personalWeight: number; // personal accounts are a buffer: their score is multiplied by this
  cap: number;            // a window far under pace cannot dominate beyond this headroom
  blockAt: number;        // never start a turn on a window at or above this fraction
  overageBlockAt: number; // the same, for accounts that would bill overage past the window
  shortBlockAt: number;   // the same, for short (<= 6h) session windows
  unknownScore: number;   // retained for configuration compatibility; unknown usage is excluded
  staleAfterSec: number;  // maximum age of verified usage for automatic dispatch
  stalePenalty: number;   // retained for configuration compatibility
  switchRatio: number;    // move a warm conversation when the alternative is materially healthier
  reserveFraction: number; // budget each outstanding dispatch in weekly/monthly windows
  shortReserveFraction: number; // larger safety budget for session windows
  idleRepickSec: number;  // a conversation keeps its account until idle this long (prompt cache is cold by then)
};
export type SmartConfig = { policy: SmartPolicy; routes: Record<string, Candidate[]> };

export const DEFAULT_POLICY: SmartPolicy = {
  personalWeight: 0.3, cap: 3, blockAt: 1, overageBlockAt: 1, shortBlockAt: 1,
  unknownScore: 1, staleAfterSec: 180, stalePenalty: 0.8, idleRepickSec: 30 * 60,
  switchRatio: 1.25, reserveFraction: 0.02, shortReserveFraction: 0.1,
};

export type Score = { slug: string; usage: string; tier: string; usable: boolean; headroom: number; score: number; reason: string; paid?: boolean };

/** Budget exhaustion must be verified independently of reservations and credential health. */
function usageProblem(snap: UsageSnapshot | undefined, now: number, p: SmartPolicy): string | undefined {
  if (!snap) return 'no verified usage';
  if (!Number.isFinite(snap.updatedAt) || now - snap.updatedAt > p.staleAfterSec || !snap.windows.length) return 'usage needs refresh';
  for (const w of snap.windows) {
    if (!Number.isFinite(w.observedAt ?? snap.updatedAt) || now - (w.observedAt ?? snap.updatedAt) > p.staleAfterSec || !Number.isFinite(w.used) || w.used < 0 || !Number.isFinite(w.minutes) || w.minutes <= 0 || (w.resetsAt != null && (!Number.isFinite(w.resetsAt) || w.resetsAt <= now))) return `${w.name} needs refresh`;
  }
}

function creditScore(c: Candidate, snap: UsageSnapshot, now: number, p: SmartPolicy): Score {
  const base: Score = { slug: c.slug, usage: c.usage, tier: c.tier, usable: false, headroom: 0, score: 0, reason: 'paid usage unavailable', paid: true };
  if (c.tier !== 'work' || !c.creditWeight || c.creditWeight <= 0 || !snap.overage) return base;
  if (snap.blocked && (snap.blockedUntil == null || snap.blockedUntil > now)) return { ...base, reason: snap.blocked };
  const credit = snap.credits;
  const access = snap.creditAccess ?? (credit ? { allowed: credit.enabled, observedAt: credit.observedAt } : undefined);
  if (!access?.allowed || !Number.isFinite(access.observedAt) || now - access.observedAt > p.staleAfterSec) return { ...base, reason: 'credit availability needs refresh' };
  if (credit && (!Number.isFinite(credit.used) || credit.used < 0 || !credit.currency)) return base;
  if (credit?.limit != null && (!Number.isFinite(credit.limit) || credit.limit <= credit.used) && (credit.resetsAt == null || credit.resetsAt > now)) return { ...base, reason: 'credit spend limit reached' };
  // Delayed spend telemetry affects soft balancing, not fresh provider permission to use credits.
  const score = c.creditWeight / (1 + (credit?.used ?? 0) + (snap.creditReserved ?? 0));
  return { ...base, usable: true, score, reason: 'paid credits' };
}

/**
 * Headroom = how far an account is under its even-spend pace: remaining fraction divided by the
 * fraction of the window still to run, minimised over its windows (the binding one wins). Above 1 the
 * allowance would partly go unused at reset; below 1 it would run out early.
 */
export function scoreCandidate(c: Candidate, snap: UsageSnapshot | undefined, now: number, p: SmartPolicy = DEFAULT_POLICY): Score {
  const weight = c.tier === 'personal' ? p.personalWeight : 1;
  const base = { slug: c.slug, usage: c.usage, tier: c.tier };
  if (!snap) return { ...base, usable: false, headroom: 0, score: 0, reason: 'no verified usage' };
  if (snap.blocked && (snap.blockedUntil == null || snap.blockedUntil > now))
    return { ...base, usable: false, headroom: 0, score: 0, reason: snap.blocked };
  const problem = usageProblem(snap, now, p);
  if (problem) return { ...base, usable: false, headroom: 0, score: 0, reason: problem };
  let headroom = p.cap, binding = 'under pace';
  for (const w of snap.windows) {
    const limit = w.minutes <= 360 ? p.shortBlockAt : snap.overage ? p.overageBlockAt : p.blockAt;
    if (w.used >= limit) return { ...base, usable: false, headroom: 0, score: 0, reason: `${w.name} ${Math.round(w.used * 100)}%` };
    const budgeted = w.used + (w.reserved ?? 0) + (w.requestReserve ?? 0);
    if (budgeted > limit + 1e-12) return { ...base, usable: false, headroom: 0, score: 0, reason: `${w.name} ${Math.round(w.used * 100)}% (remaining allowance reserved)` };
    const left = w.resetsAt == null ? 1 : Math.min(1, Math.max(0.02, (w.resetsAt - now) / (w.minutes * 60)));
    const h = Math.max(0, 1 - w.used - (w.reserved ?? 0)) / left;
    if (h < headroom) { headroom = h; binding = w.name; }
  }
  return { ...base, usable: true, headroom, score: headroom * weight, reason: binding };
}

/** Best usable candidate; ties keep list order. All blocked: a placeholder slug; dispatch must check its usable score. */
export function rank(candidates: Candidate[], snaps: Record<string, UsageSnapshot | undefined>, now: number, p: SmartPolicy = DEFAULT_POLICY): { pick: string; scores: Score[] } {
  let scores = candidates.map(c => scoreCandidate(c, snaps[c.usage], now, p));
  // A busy/stale/unauthenticated pool is not evidence that every included budget is spent.
  if (!scores.some(s => s.usable) && candidates.every(c => {
    const snap = snaps[c.usage];
    return snap && !usageProblem(snap, now, p) && snap.windows.some(w => w.used >= 1);
  })) {
    const paid = candidates.map(c => creditScore(c, snaps[c.usage]!, now, p));
    const currencies = new Set(paid.filter(s => s.usable).map(s => snaps[s.usage]!.credits?.currency ?? 'USD'));
    if (currencies.size <= 1 && paid.some(s => s.usable)) scores = paid;
  }
  let best: Score | undefined;
  for (const s of scores) if (s.usable && (!best || s.score > best.score)) best = s;
  return { pick: (best ?? scores.find(s => s.tier === 'work') ?? scores[0]!).slug, scores };
}

type Sticky = { slug: string; at: number };
type Reservation = { finished?: number; windows: Map<string, { amount: number; resetsAt: number | null }>; paid: boolean };

export class SmartRouter {
  private sticky = new Map<string, Sticky>();
  private reservations = new Map<string, Set<Reservation>>();
  private quotaBlocks = new Map<string, number>();
  private capacityWaiters = new Set<() => void>();
  constructor(readonly config: SmartConfig, private snapshots: () => Record<string, UsageSnapshot | undefined>, private clock = () => Date.now() / 1000) {}

  /** A provider refusal wins over a delayed utilization counter. */
  quotaFailed(usage: string, resetsAt?: number): void {
    const now = this.clock();
    this.quotaBlocks.set(usage, resetsAt && resetsAt > now ? resetsAt : now + 60);
  }

  /** Reserve before dispatch, synchronously, so simultaneous chats cannot all spend the same room.
   * Keep completed work charged until a provider reading taken after completion accounts for it. */
  reserve(slug: string, paid = false): () => void {
    const candidate = Object.values(this.config.routes).flat().find(c => c.slug === slug);
    if (!candidate) return () => {};
    const snapshot = this.budgetedSnapshots(true, false)[candidate.usage];
    const entries = this.reservations.get(candidate.usage) ?? new Set<Reservation>();
    const entry: Reservation = { paid, windows: new Map(snapshot?.windows.map(w => [w.name, { amount: this.nextReserve(w, snapshot!), resetsAt: w.resetsAt }])) };
    entries.add(entry); this.reservations.set(candidate.usage, entries);
    return () => {
      if (entry.finished !== undefined) return;
      entry.finished = this.clock();
      for (const wake of this.capacityWaiters) wake();
    };
  }

  /** Completion wakes admission immediately; periodic checks also notice provider reads/resets.
   * A cancelled caller removes its listener without cancelling other chats or their inference. */
  waitForCapacity(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.capacityWaiters.delete(wake); signal?.removeEventListener('abort', abort); };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal?.reason); };
      const timer = setTimeout(wake, 5000);
      this.capacityWaiters.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  /** Near exhaustion, one final request can use the remaining fraction. Its captured reservation
   * holds that entire tail until a fresh observation; concurrent requests cannot share it. */
  private nextReserve(w: UsageWindow, snap: UsageSnapshot): number {
    const base = w.minutes <= 360 ? this.config.policy.shortReserveFraction : this.config.policy.reserveFraction;
    const limit = w.minutes <= 360 ? this.config.policy.shortBlockAt : snap.overage ? this.config.policy.overageBlockAt : this.config.policy.blockAt;
    const remaining = limit - w.used - (w.reserved ?? 0);
    return remaining > 1e-12 ? Math.min(base, remaining) : base;
  }

  private budgetedSnapshots(includeReservations = true, includeNext = true): Record<string, UsageSnapshot | undefined> {
    const snaps = { ...this.snapshots() };
    for (const [usage, entries] of this.reservations) {
      const snap = snaps[usage];
      for (const entry of entries) if (entry.finished !== undefined && snap?.windows.length && snap.windows.every(w => (w.observedAt ?? snap.updatedAt) > entry.finished!) && (!entry.paid || (snap.credits?.observedAt ?? 0) > entry.finished)) entries.delete(entry);
      if (!entries.size) { this.reservations.delete(usage); continue; }
      if (snap && includeReservations) snaps[usage] = { ...snap, windows: snap.windows.map(w => ({ ...w,
        reserved: [...entries].reduce((sum, entry) => {
          const held = entry.windows.get(w.name);
          if (entry.finished !== undefined && (w.observedAt ?? snap.updatedAt) > entry.finished) return sum;
          return sum + (held && held.resetsAt === w.resetsAt ? held.amount : (w.minutes <= 360 ? this.config.policy.shortReserveFraction : this.config.policy.reserveFraction));
        }, 0),
      })) };
      if (snap && includeReservations) {
        // A provisional unit per in-flight paid turn breaks ties while the actual spend read lags.
        const current = snaps[usage]!;
        snaps[usage] = { ...current, creditReserved: [...entries].filter(entry => entry.paid && (entry.finished === undefined || (snap.credits?.observedAt ?? 0) <= entry.finished)).length };
      }
    }
    // Also budget the request being considered, including on an otherwise idle account.
    if (includeNext) for (const usage of new Set(Object.values(this.config.routes).flat().map(c => c.usage))) {
      const snap = snaps[usage];
      if (snap) snaps[usage] = { ...snap, windows: snap.windows.map(w => ({ ...w,
        requestReserve: this.nextReserve(w, snap),
      })) };
    }
    for (const [usage, until] of this.quotaBlocks) {
      if (until <= this.clock()) this.quotaBlocks.delete(usage);
      else if (snaps[usage]) snaps[usage] = { ...snaps[usage]!, blocked: 'provider usage limit reached', blockedUntil: until };
    }
    return snaps;
  }

  isAuto(model: unknown): model is string { return typeof model === 'string' && Object.hasOwn(this.config.routes, model); }

  /** Real allowance still fits the next request, but outstanding/unverified dispatches hold it. */
  reservationBlocked(model: string): boolean {
    const candidates = this.config.routes[model]!;
    return rank(candidates, this.budgetedSnapshots(false), this.clock(), this.config.policy).scores.some(s => s.usable);
  }

  /** Concrete slug for this request, and whether the conversation just moved to another account. */
  resolve(model: string, conversation?: string): { slug: string; switched: boolean; scores: Score[] } {
    const candidates = this.config.routes[model]!;
    const now = this.clock();
    const snaps = this.budgetedSnapshots();
    const key = conversation ? `${model}\u0000${conversation}` : undefined;
    const held = key ? this.sticky.get(key) : undefined;
    const ranked = rank(candidates, snaps, now, this.config.policy);
    let slug = ranked.pick;
    if (held && now - held.at < this.config.policy.idleRepickSec) {
      const current = ranked.scores.find(s => s.slug === held.slug);
      const best = ranked.scores.find(s => s.slug === ranked.pick);
      if (current?.usable && best && best.score <= current.score * this.config.policy.switchRatio) slug = held.slug;
    }
    if (key) {
      this.sticky.delete(key);
      this.sticky.set(key, { slug, at: now });
      if (this.sticky.size > 2000) this.sticky.delete(this.sticky.keys().next().value!);
    }
    return { slug, switched: Boolean(held && held.slug !== slug), scores: ranked.scores };
  }
}

function num(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }

/** Reads `smart-routes.json` from the state dir; absent means no auto models. */
export function loadSmartConfig(stateDir: string): SmartConfig | undefined {
  const file = join(stateDir, 'smart-routes.json');
  if (!existsSync(file)) return undefined;
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isRecord(raw) || !isRecord(raw.routes)) throw new Error('smart-routes.json needs routes');
  const policy = { ...DEFAULT_POLICY };
  if (isRecord(raw.policy)) for (const k of Object.keys(DEFAULT_POLICY) as (keyof SmartPolicy)[]) { const v = num(raw.policy[k]); if (v !== undefined) policy[k] = v; }
  const routes: Record<string, Candidate[]> = {};
  for (const [slug, list] of Object.entries(raw.routes)) {
    if (!/^auto-[a-z0-9.-]+$/.test(slug) || !Array.isArray(list) || !list.length) throw new Error(`Invalid smart route ${slug}`);
    routes[slug] = list.map(entry => {
      if (!isRecord(entry) || typeof entry.slug !== 'string' || typeof entry.usage !== 'string' || (entry.tier !== 'work' && entry.tier !== 'personal')) throw new Error(`Invalid candidate in ${slug}`);
      const creditWeight = num(entry.creditWeight);
      if (entry.creditWeight !== undefined && (creditWeight === undefined || creditWeight <= 0)) throw new Error(`Invalid credit weight in ${slug}`);
      return { slug: entry.slug, usage: entry.usage, tier: entry.tier, ...(creditWeight !== undefined ? { creditWeight } : {}) };
    });
  }
  return { policy, routes };
}
