// Deterministic account balancing for "auto" models. An auto slug (e.g. `auto-claude-opus-5-5`) names one
// model served by several subscription accounts; each request is sent to one concrete account slug.
// No model call is involved: the choice is a pure function of the latest usage snapshots and the clock.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../json';

/** One rolling allowance: fraction used (0..1), when it resets (unix seconds) and its length. */
export type UsageWindow = { name: string; used: number; resetsAt: number | null; minutes: number };
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
  unknownScore: number;   // headroom assumed for an account with no snapshot yet
  staleAfterSec: number;  // older snapshots are trusted less
  stalePenalty: number;
  idleRepickSec: number;  // a conversation keeps its account until idle this long (prompt cache is cold by then)
};
export type SmartConfig = { policy: SmartPolicy; routes: Record<string, Candidate[]> };

export const DEFAULT_POLICY: SmartPolicy = {
  personalWeight: 0.3, cap: 3, blockAt: 0.97, overageBlockAt: 0.9, shortBlockAt: 0.9,
  unknownScore: 1, staleAfterSec: 3 * 3600, stalePenalty: 0.8, idleRepickSec: 30 * 60,
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
  if (!snap) return { ...base, usable: true, headroom: p.unknownScore, score: p.unknownScore * weight, reason: 'no snapshot' };
  if (snap.blocked && (snap.blockedUntil == null || snap.blockedUntil > now))
    return { ...base, usable: false, headroom: 0, score: 0, reason: snap.blocked };
  let headroom = p.cap, binding = 'under pace';
  for (const w of snap.windows) {
    if (w.resetsAt != null && w.resetsAt <= now) continue; // reset since the snapshot: fresh
    const limit = w.minutes <= 360 ? p.shortBlockAt : snap.overage ? p.overageBlockAt : p.blockAt;
    if (w.used >= limit) return { ...base, usable: false, headroom: 0, score: 0, reason: `${w.name} ${Math.round(w.used * 100)}%` };
    const left = w.resetsAt == null ? 1 : Math.min(1, Math.max(0.02, (w.resetsAt - now) / (w.minutes * 60)));
    const h = (1 - w.used) / left;
    if (h < headroom) { headroom = h; binding = w.name; }
  }
  const stale = now - snap.updatedAt > p.staleAfterSec;
  const score = headroom * weight * (stale ? p.stalePenalty : 1);
  return { ...base, usable: true, headroom, score, reason: stale ? `${binding}, stale` : binding };
}

/** Best usable candidate; ties keep list order. All blocked: the first work account (it will report its own limit). */
export function rank(candidates: Candidate[], snaps: Record<string, UsageSnapshot | undefined>, now: number, p: SmartPolicy = DEFAULT_POLICY): { pick: string; scores: Score[] } {
  const scores = candidates.map(c => scoreCandidate(c, snaps[c.usage], now, p));
  let best: Score | undefined;
  for (const s of scores) if (s.usable && (!best || s.score > best.score)) best = s;
  return { pick: (best ?? scores.find(s => s.tier === 'work') ?? scores[0]!).slug, scores };
}

type Sticky = { slug: string; at: number };

export class SmartRouter {
  private sticky = new Map<string, Sticky>();
  constructor(readonly config: SmartConfig, private snapshots: () => Record<string, UsageSnapshot | undefined>, private clock = () => Date.now() / 1000) {}

  isAuto(model: unknown): model is string { return typeof model === 'string' && Object.hasOwn(this.config.routes, model); }

  /** Concrete slug for this request, and whether the conversation just moved to another account. */
  resolve(model: string, conversation?: string): { slug: string; switched: boolean; scores: Score[] } {
    const candidates = this.config.routes[model]!;
    const now = this.clock();
    const snaps = this.snapshots();
    const key = conversation ? `${model}\u0000${conversation}` : undefined;
    const held = key ? this.sticky.get(key) : undefined;
    const ranked = rank(candidates, snaps, now, this.config.policy);
    let slug = ranked.pick;
    if (held && now - held.at < this.config.policy.idleRepickSec) {
      const current = ranked.scores.find(s => s.slug === held.slug);
      if (current?.usable) slug = held.slug; // stay put while warm and usable
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
