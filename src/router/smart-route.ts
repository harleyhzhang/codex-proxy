// Deterministic account balancing for "auto" models. An auto slug (e.g. `auto-claude-opus-5-5`) names one
// model served by several subscription accounts; each request is sent to one concrete account slug.
// No model call is involved: the choice is a pure function of the latest usage snapshots and the clock.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../json';

/** One rolling allowance: fraction used (0..1), when it resets (unix seconds) and its length. */
export type UsageWindow = { name: string; used: number; resetsAt: number | null; minutes: number; observedAt?: number };
export type UsageSnapshot = {
  updatedAt: number;
  windows: UsageWindow[];
  /** Spending beyond the windows is billed (extra usage, credits): stay further from the edge. */
  overage?: boolean;
  /** Hard stop reported by the provider (rejected, spend control reached), until `blockedUntil`. */
  blocked?: string;
  blockedUntil?: number | null;
};
export type Candidate = { slug: string; usage: string; tier: 'work' | 'personal' };
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
  personalWeight: 0.3, cap: 3, blockAt: 0.97, overageBlockAt: 0.9, shortBlockAt: 0.9,
  unknownScore: 1, staleAfterSec: 180, stalePenalty: 0.8, idleRepickSec: 30 * 60,
  switchRatio: 1.25, reserveFraction: 0.02, shortReserveFraction: 0.1,
};

export type Score = { slug: string; usage: string; tier: string; usable: boolean; headroom: number; score: number; reason: string };

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
  if (!Number.isFinite(snap.updatedAt) || now - snap.updatedAt > p.staleAfterSec || !snap.windows.length)
    return { ...base, usable: false, headroom: 0, score: 0, reason: 'usage needs refresh' };
  let headroom = p.cap, binding = 'under pace';
  for (const w of snap.windows) {
    if (!Number.isFinite(w.observedAt ?? snap.updatedAt) || now - (w.observedAt ?? snap.updatedAt) > p.staleAfterSec || !Number.isFinite(w.used) || w.used < 0 || !Number.isFinite(w.minutes) || w.minutes <= 0 || (w.resetsAt != null && (!Number.isFinite(w.resetsAt) || w.resetsAt <= now)))
      return { ...base, usable: false, headroom: 0, score: 0, reason: `${w.name} needs refresh` };
    const limit = w.minutes <= 360 ? p.shortBlockAt : snap.overage ? p.overageBlockAt : p.blockAt;
    if (w.used >= limit) return { ...base, usable: false, headroom: 0, score: 0, reason: `${w.name} ${Math.round(w.used * 100)}%` };
    const left = w.resetsAt == null ? 1 : Math.min(1, Math.max(0.02, (w.resetsAt - now) / (w.minutes * 60)));
    const h = (1 - w.used) / left;
    if (h < headroom) { headroom = h; binding = w.name; }
  }
  return { ...base, usable: true, headroom, score: headroom * weight, reason: binding };
}

/** Best usable candidate; ties keep list order. All blocked: a placeholder slug; dispatch must check its usable score. */
export function rank(candidates: Candidate[], snaps: Record<string, UsageSnapshot | undefined>, now: number, p: SmartPolicy = DEFAULT_POLICY): { pick: string; scores: Score[] } {
  const scores = candidates.map(c => scoreCandidate(c, snaps[c.usage], now, p));
  let best: Score | undefined;
  for (const s of scores) if (s.usable && (!best || s.score > best.score)) best = s;
  return { pick: (best ?? scores.find(s => s.tier === 'work') ?? scores[0]!).slug, scores };
}

type Sticky = { slug: string; at: number };

export class SmartRouter {
  private sticky = new Map<string, Sticky>();
  private reservations = new Map<string, Set<{ finished?: number }>>();
  constructor(readonly config: SmartConfig, private snapshots: () => Record<string, UsageSnapshot | undefined>, private clock = () => Date.now() / 1000) {}

  /** Reserve before dispatch, synchronously, so simultaneous chats cannot all spend the same room.
   * Keep completed work charged until a provider reading taken after completion accounts for it. */
  reserve(slug: string): () => void {
    const candidate = Object.values(this.config.routes).flat().find(c => c.slug === slug);
    if (!candidate) return () => {};
    const entries = this.reservations.get(candidate.usage) ?? new Set<{ finished?: number }>();
    const entry: { finished?: number } = {};
    entries.add(entry); this.reservations.set(candidate.usage, entries);
    return () => { entry.finished ??= this.clock(); };
  }

  private budgetedSnapshots(): Record<string, UsageSnapshot | undefined> {
    const snaps = { ...this.snapshots() };
    for (const [usage, entries] of this.reservations) {
      const snap = snaps[usage];
      for (const entry of entries) if (entry.finished !== undefined && snap && snap.updatedAt > entry.finished) entries.delete(entry);
      if (!entries.size) { this.reservations.delete(usage); continue; }
      if (snap) snaps[usage] = { ...snap, windows: snap.windows.map(w => ({ ...w,
        used: w.used + entries.size * (w.minutes <= 360 ? this.config.policy.shortReserveFraction : this.config.policy.reserveFraction),
      })) };
    }
    // Also budget the request being considered, including on an otherwise idle account.
    for (const usage of new Set(Object.values(this.config.routes).flat().map(c => c.usage))) {
      const snap = snaps[usage];
      if (snap) snaps[usage] = { ...snap, windows: snap.windows.map(w => ({ ...w,
        used: w.used + (w.minutes <= 360 ? this.config.policy.shortReserveFraction : this.config.policy.reserveFraction),
      })) };
    }
    return snaps;
  }

  isAuto(model: unknown): model is string { return typeof model === 'string' && Object.hasOwn(this.config.routes, model); }

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
      return { slug: entry.slug, usage: entry.usage, tier: entry.tier };
    });
  }
  return { policy, routes };
}
