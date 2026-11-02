import { logSafe } from '../log';
import { retryDelayMs } from '../transport';
import { BackendError } from './contract';

/** One budget shared by opening the HTTP stream and any fresh pre-exposure backend retry. */
export class RetryBudget {
  private attempts = 0;
  constructor(private readonly provider: string, private readonly maxAttempts = 5) {}
  take(): void {
    if (this.attempts >= this.maxAttempts) throw new BackendError(`${this.provider} remained unavailable after ${this.maxAttempts} attempts; try again later`, { code: 'server_is_overloaded' });
    this.attempts++;
  }
  get remaining(): boolean { return this.attempts < this.maxAttempts; }
  delay(headers?: Headers): number {
    const hint = headers?.get('retry-after-ms');
    const retryAfter = headers?.get('retry-after');
    const parsed = hint ? Number(hint) : retryAfter ? /^\s*\d+(?:\.\d+)?\s*$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now() : undefined;
    const delay = parsed !== undefined && Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 60_000) : retryDelayMs(200, Math.max(0, this.attempts - 1));
    logSafe('provider-retry', { provider: this.provider, attempt: this.attempts, delay_ms: delay, provider_hint: parsed !== undefined });
    return delay;
  }
}
