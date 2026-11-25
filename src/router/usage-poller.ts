// Keeps a fresh usage snapshot for every account an auto model can use, so the smart router sees usage
// spent anywhere (other Macs, Claude Code, the web), not only through this router. Read-only: GPT
// accounts via native `account/rateLimits/read`, Claude accounts via the OAuth usage endpoint with the
// profile's shared inference authorizer, so polling and inference never rotate separate token copies.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../json';
import { logSafe } from '../log';
import { nativeAccountRequest } from './account-upstream';
import { AccountAuthenticationError, accountAuthRequired } from '../backends/contract';
import type { UsageSnapshot, UsageWindow } from './smart-route';

export type UsageSource =
  | { kind: 'codex'; home: string; binary: string }
  | { kind: 'claude'; configDir: string; routerSnapshot?: string };

const MONTH_MIN = 30 * 1440;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;
const epoch = (v: unknown) => num(v) ?? (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Math.floor(Date.parse(v) / 1000) : null);

/** Native Codex `account/rateLimits/read` result → snapshot. */
export function codexSnapshot(result: unknown, now: number): UsageSnapshot | undefined {
  const limits = isRecord(result) && isRecord(result.rateLimits) ? result.rateLimits : undefined;
  if (!limits) return undefined;
  const windows: UsageWindow[] = [];
  for (const name of ['primary', 'secondary'] as const) {
    const w = limits[name];
    const used = isRecord(w) ? num(w.usedPercent) : undefined;
    if (isRecord(w) && used !== undefined) windows.push({ name: (num(w.windowDurationMins) ?? 0) <= 360 ? 'five_hour' : 'weekly', used: used / 100, resetsAt: epoch(w.resetsAt), minutes: num(w.windowDurationMins) ?? 10_080 });
  }
  const individual = limits.individualLimit;
  if (isRecord(individual)) {
    const remaining = num(individual.remainingPercent);
    const used = remaining !== undefined ? 1 - remaining / 100 : (num(individual.used) ?? 0) / (num(individual.limit) || 1);
    windows.push({ name: 'monthly', used: Math.min(1, Math.max(0, used)), resetsAt: epoch(individual.resetsAt), minutes: MONTH_MIN });
  }
  const credits = isRecord(limits.credits) ? limits.credits : {};
  const snap: UsageSnapshot = { updatedAt: now, windows, overage: credits.hasCredits === true };
  const resets = windows.map(w => w.resetsAt ?? 0);
  if (limits.spendControlReached === true) { snap.blocked = 'spend limit reached'; snap.blockedUntil = isRecord(individual) ? epoch(individual.resetsAt) : null; }
  else if (typeof limits.rateLimitReachedType === 'string') { snap.blocked = `limit reached (${limits.rateLimitReachedType})`; snap.blockedUntil = resets.length ? Math.max(...resets) : null; }
  if (isRecord(result) && result.ordinaryUsageAllowed === false && !snap.blocked) { snap.blocked = 'ordinary usage not allowed'; snap.blockedUntil = null; }
  return snap;
}

/** Claude OAuth `/api/oauth/usage` body → snapshot (utilization is a percentage). */
export function claudeOauthSnapshot(body: unknown, now: number): UsageSnapshot | undefined {
  if (!isRecord(body)) return undefined;
  const windows: UsageWindow[] = [];
  for (const [key, minutes] of [['five_hour', 300], ['seven_day', 10_080], ['seven_day_opus', 10_080]] as const) {
    const w = body[key];
    const used = isRecord(w) ? num(w.utilization) : undefined;
    if (isRecord(w) && used !== undefined) windows.push({ name: key, used: used / 100, resetsAt: epoch(w.resets_at), minutes });
  }
  const extra = isRecord(body.extra_usage) ? body.extra_usage : {};
  return { updatedAt: now, windows, overage: extra.is_enabled === true };
}

/** The router's own per-response Claude snapshot (claude-*-usage.json) → snapshot. */
export function claudeRouterSnapshot(raw: unknown): UsageSnapshot | undefined {
  if (!isRecord(raw)) return undefined;
  const windows: UsageWindow[] = [];
  for (const [key, w] of [['five_hour', raw.five_hour], ['seven_day', raw.seven_day], ...Object.entries(isRecord(raw.model_windows) ? raw.model_windows : {})] as [string, unknown][]) {
    const used = isRecord(w) ? num(w.used_percent) : undefined;
    if (isRecord(w) && used !== undefined) windows.push({ name: key, used: used / 100, resetsAt: epoch(w.resets_at), minutes: num(w.window_minutes) ?? (key === 'five_hour' ? 300 : 10_080) });
  }
  const snap: UsageSnapshot = { updatedAt: num(raw.updated_at) ?? 0, windows, overage: raw.overage_status === 'allowed' };
  if (raw.status === 'rejected') { snap.blocked = 'rejected'; snap.blockedUntil = Math.max(0, ...windows.map(w => w.resetsAt ?? 0)) || null; }
  return snap;
}

/** Response headers can be rounded or omit windows present in OAuth. Keep the highest same-window
 * reading, preserve billing/blocks, and accept a lower value only for a newly verified reset window. */
export function mergeUsageSnapshots(a: UsageSnapshot, b: UsageSnapshot): UsageSnapshot {
  const [older, newer] = a.updatedAt <= b.updatedAt ? [a, b] : [b, a];
  const windows = new Map(older.windows.filter(w => w.resetsAt == null || w.resetsAt > newer.updatedAt)
    .map(w => [w.name, { ...w, observedAt: w.observedAt ?? older.updatedAt }]));
  for (const w of newer.windows) {
    const old = windows.get(w.name);
    const sameReset = old && (old.resetsAt === w.resetsAt || old.resetsAt != null && w.resetsAt != null && Math.abs(old.resetsAt - w.resetsAt) <= 1);
    windows.set(w.name, { ...w, observedAt: w.observedAt ?? newer.updatedAt, ...(sameReset ? { used: Math.max(old.used, w.used) } : {}) });
  }
  const activeBlock = [newer, older].find(s => s.blocked && (s.blockedUntil == null || s.blockedUntil > newer.updatedAt));
  return { ...newer, updatedAt: newer.updatedAt, windows: [...windows.values()],
    overage: a.overage === true || b.overage === true,
    ...(activeBlock ? { blocked: activeBlock.blocked, blockedUntil: activeBlock.blockedUntil } : {}),
  };
}

async function claudeToken(configDir: string): Promise<string | undefined> {
  const service = `Claude Code-credentials-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
  const child = Bun.spawn(['security', 'find-generic-password', '-s', service, '-w'], { stdout: 'pipe', stderr: 'ignore' });
  const text = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) return undefined;
  try { const parsed: unknown = JSON.parse(text.trim()); return isRecord(parsed) && isRecord(parsed.claudeAiOauth) && typeof parsed.claudeAiOauth.accessToken === 'string' ? parsed.claudeAiOauth.accessToken : undefined; }
  catch { return undefined; }
}

export class UsagePoller {
  private polled: Record<string, UsageSnapshot> = {};
  private unhealthy: Record<string, { failedAt: number }> = {};
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private lastAttempt = 0;
  constructor(private sources: Record<string, UsageSource>, private stateDir: string, private intervalMs = 5 * 60_000,
    private options: { readClaudeUsage?: (configDir: string) => Promise<unknown>; authFailureCommand?: string[]; authRecoveryCommand?: string[] } = {}) {
    try { const saved: unknown = JSON.parse(readFileSync(join(stateDir, 'usage-snapshots.json'), 'utf8')); if (isRecord(saved)) this.polled = saved as Record<string, UsageSnapshot>; } catch {}
    try {
      const saved: unknown = JSON.parse(readFileSync(join(stateDir, 'account-health.json'), 'utf8'));
      if (isRecord(saved)) for (const [id, value] of Object.entries(saved))
        if (Object.hasOwn(sources, id) && isRecord(value) && typeof value.failedAt === 'number') this.unhealthy[id] = { failedAt: value.failedAt };
    } catch {}
  }

  start(): this { void this.poll(); this.timer = setInterval(() => void this.poll(), this.intervalMs); this.timer.unref?.(); return this; }
  stop(): void { clearInterval(this.timer); }

  /** Newest of the polled snapshot and the router's own per-response Claude snapshot. */
  snapshots(): Record<string, UsageSnapshot | undefined> {
    const out: Record<string, UsageSnapshot | undefined> = { ...this.polled };
    for (const [id, source] of Object.entries(this.sources)) {
      if (source.kind !== 'claude' || !source.routerSnapshot) continue;
      const file = join(this.stateDir, source.routerSnapshot);
      if (!existsSync(file)) continue;
      try { const local = claudeRouterSnapshot(JSON.parse(readFileSync(file, 'utf8'))); if (local) out[id] = out[id] ? mergeUsageSnapshots(out[id]!, local) : local; } catch {}
    }
    // Credential health is independent of usage: a newer quota snapshot cannot revive a bad login.
    for (const id of Object.keys(this.unhealthy)) out[id] = { ...(out[id] ?? { updatedAt: 0, windows: [] }), blocked: 'authentication required', blockedUntil: null };
    return out;
  }

  markAuthFailure(id: string): void {
    if (this.unhealthy[id]) return;
    this.unhealthy[id] = { failedAt: Date.now() / 1000 };
    this.saveHealth();
    logSafe('account-auth-required', { account: id });
    this.notifyAuth(id, false);
  }

  private notifyAuth(id: string, recovered: boolean): void {
    const command = recovered ? this.options.authRecoveryCommand : this.options.authFailureCommand;
    if (command?.length) {
      try {
        const child = Bun.spawn([...command, id], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
        void child.exited.then(code => { if (code) logSafe('account-auth-notification-failed', { account: id, exit: code }); });
      } catch { logSafe('account-auth-notification-failed', { account: id }); }
    }
  }

  private saveHealth(): void {
    try { writeFileSync(join(this.stateDir, 'account-health.json'), JSON.stringify(this.unhealthy, null, 2), { mode: 0o600 }); }
    catch { logSafe('account-health-save-failed'); }
  }

  /** Await startup/in-progress renewal; stale cached usage gets one bounded refresh, not one per request. */
  async ensureFresh(): Promise<void> {
    if (this.polling) return this.polling;
    const now = Date.now() / 1000;
    const snapshots = this.snapshots();
    if (now - this.lastAttempt >= 30 && Object.keys(this.sources).some(id => !snapshots[id] || now - snapshots[id]!.updatedAt >= 60)) await this.poll();
  }

  poll(): Promise<void> {
    return this.polling ??= this.pollOnce().finally(() => { this.polling = undefined; });
  }

  private async pollOnce(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.lastAttempt = now;
    await Promise.all(Object.entries(this.sources).map(async ([id, source]) => {
      const health = this.unhealthy[id];
      try {
        let snap: UsageSnapshot | undefined;
        if (source.kind === 'codex') snap = codexSnapshot(await nativeAccountRequest({ home: source.home, binary: source.binary, prefix: id }, 'account/rateLimits/read', {}), now);
        else {
          if (this.options.readClaudeUsage) snap = claudeOauthSnapshot(await this.options.readClaudeUsage(source.configDir), now);
          else {
            const token = await claudeToken(source.configDir);
            if (!token) throw accountAuthRequired('Claude login unavailable');
            const res = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'codex-subscription-proxy-usage/1.0' }, signal: AbortSignal.timeout(15_000) });
            if (res.status === 401) { await res.body?.cancel(); throw accountAuthRequired('Claude login rejected'); }
            if (!res.ok) { await res.body?.cancel(); logSafe('usage-poll', { account: id, status: res.status }); return; }
            snap = claudeOauthSnapshot(await res.json(), now);
          }
        }
        if (!snap) return;
        this.polled[id] = this.polled[id] ? mergeUsageSnapshots(this.polled[id]!, snap) : snap;
        if (health && this.unhealthy[id] === health) { delete this.unhealthy[id]; this.saveHealth(); logSafe('account-auth-recovered', { account: id }); this.notifyAuth(id, true); }
        appendFileSync(join(this.stateDir, 'usage-history.jsonl'), JSON.stringify({ at: now, account: id, snapshot: snap }) + '\n');
      } catch (error) {
        if (error instanceof AccountAuthenticationError) this.markAuthFailure(id);
        logSafe('usage-poll', { account: id, failed: true });
      }
    }));
    try { writeFileSync(join(this.stateDir, 'usage-snapshots.json'), JSON.stringify(this.polled, null, 2)); } catch {}
  }
}

export function loadUsageSources(raw: unknown): Record<string, UsageSource> {
  const out: Record<string, UsageSource> = {};
  if (!isRecord(raw)) return out;
  for (const [id, s] of Object.entries(raw)) {
    if (!isRecord(s)) continue;
    if (s.kind === 'codex' && typeof s.home === 'string') out[id] = { kind: 'codex', home: s.home, binary: typeof s.binary === 'string' ? s.binary : 'codex' };
    else if (s.kind === 'claude' && typeof s.configDir === 'string') out[id] = { kind: 'claude', configDir: s.configDir, routerSnapshot: typeof s.routerSnapshot === 'string' ? s.routerSnapshot : undefined };
  }
  return out;
}
