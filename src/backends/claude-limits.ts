// Tracks the Claude plan allowance the CLI reports after each turn, so a known-exhausted model is
// refused up front with its reset time instead of spending a turn to discover it.
import { isRecord } from '../json';
import { BackendError } from './contract';

export type UsageWindow = { used_percent: number; window_minutes: number; resets_at: number | null };

export type ClaudeUsage = {
  updated_at: number;
  status: string | null;
  overage_status: string | null;
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  model_windows?: Record<string, UsageWindow>;
};

const FIVE_HOURS = 300;
const SEVEN_DAYS = 10_080;

function usageWindow(value: unknown, minutes: number): UsageWindow | null {
  if (!isRecord(value) || typeof value.utilization !== 'number') return null;
  return {
    used_percent: Math.round(value.utilization * 1000) / 10,
    window_minutes: minutes,
    resets_at: typeof value.resetsAt === 'number' ? value.resetsAt : null,
  };
}

/** Normalises the CLI's `rate_limit_info` payload into a stable snapshot. */
export function claudeUsageSnapshot(info: unknown, now = Date.now()): ClaudeUsage {
  const record = isRecord(info) ? info : {};
  const windows = isRecord(record.unifiedWindows) ? record.unifiedWindows : {};
  const snapshot: ClaudeUsage = {
    updated_at: Math.floor(now / 1000),
    status: typeof record.status === 'string' ? record.status : null,
    five_hour: usageWindow(windows.five_hour, FIVE_HOURS),
    seven_day: usageWindow(windows.seven_day, SEVEN_DAYS),
    overage_status: typeof record.overageStatus === 'string' ? record.overageStatus : null,
  };
  const modelWindows: Record<string, UsageWindow> = {};
  for (const [key, value] of Object.entries(windows)) {
    if (!/^seven_day_(fable|opus|sonnet)$/.test(key)) continue;
    const normalized = usageWindow(value, SEVEN_DAYS);
    if (normalized) modelWindows[key] = normalized;
  }
  if (Object.keys(modelWindows).length) snapshot.model_windows = modelWindows;
  return snapshot;
}

function windowLabel(windowName?: string): string {
  if (windowName === 'five_hour') return 'session';
  if (windowName === 'seven_day') return 'weekly';
  if (windowName?.startsWith('seven_day_')) return `${windowName.slice('seven_day_'.length)} weekly`;
  return 'usage';
}

function limitMessage(windowName?: string, resetsAt?: number): string {
  const reset = resetsAt
    ? ` Resets ${new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(resetsAt * 1000))}.`
    : '';
  const wait = resetsAt ? ' until reset' : ' for your Claude allowance to reset';
  return `Claude ${windowLabel(windowName)} limit reached.${reset} Switch to GPT or wait${wait}.`;
}

export class ClaudeUsageLimitError extends BackendError {
  constructor(
    readonly windowName?: string,
    readonly resetsAt?: number,
  ) {
    super(limitMessage(windowName, resetsAt), {
      code: 'claude_usage_limit_reached',
      logEvent: { event: 'claude-usage-limit', window: windowName, resets_at: resetsAt },
    });
    this.name = 'ClaudeUsageLimitError';
  }
}

export class ClaudeUsageLimits {
  private snapshot?: ClaudeUsage;

  restore(snapshot: ClaudeUsage): void {
    this.snapshot = snapshot;
  }

  update(info: unknown): void {
    this.snapshot = claudeUsageSnapshot(info);
  }

  /** The refusal for `model` while an allowance is exhausted, or undefined when it may run. */
  blocked(model: string, now = Date.now()): ClaudeUsageLimitError | undefined {
    const usage = this.snapshot;
    // An `allowed` overage means paid credits cover the gap; included usage being spent is fine.
    if (usage?.status !== 'rejected' || usage.overage_status === 'allowed') return undefined;
    const windows: Array<[string, UsageWindow | null]> = [
      ['five_hour', usage.five_hour],
      ['seven_day', usage.seven_day],
    ];
    const family = /(?:^|claude-)(fable|opus|sonnet)(?:-|$)/.exec(model)?.[1];
    if (family) windows.push([`seven_day_${family}`, usage.model_windows?.[`seven_day_${family}`] ?? null]);

    // With several allowances exhausted, the model is usable only once the last one resets.
    let latest: [string, number] | undefined;
    for (const [name, window] of windows) {
      const resetsAt = window?.resets_at;
      if (!window || window.used_percent < 100 || typeof resetsAt !== 'number' || resetsAt * 1000 <= now) continue;
      if (!latest || resetsAt > latest[1]) latest = [name, resetsAt];
    }
    return latest ? new ClaudeUsageLimitError(latest[0], latest[1]) : undefined;
  }

  assertAvailable(model: string): void {
    const error = this.blocked(model);
    if (error) throw error;
  }
}

export const claudeLimits = new ClaudeUsageLimits();
