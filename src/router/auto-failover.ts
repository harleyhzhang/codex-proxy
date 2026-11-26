// One bounded account retry before output: auto routes may change accounts, explicit slugs never do.
import { AccountAuthenticationError, accountAuthRequired, BackendError } from '../backends/contract';
import { logSafe } from '../log';
import { abortable, sleep } from '../transport';
import type { ResponsesBody } from '../protocol/types';
import type { SmartRouter } from './smart-route';
import { UpstreamStatusError } from './upstream';

export type AutoRouting = { router: SmartRouter; authFailed: (usage: string) => void; refreshUsage?: () => Promise<void> };
type Context = { auto: string; conversation?: string; attempted: Set<string> };

export function isAccountAuthFailure(error: unknown): boolean {
  return error instanceof AccountAuthenticationError || error instanceof UpstreamStatusError && error.status === 401;
}

export class AutoFailover {
  private contexts = new WeakMap<ResponsesBody, Context>();
  constructor(private routing: AutoRouting) {}

  /** An exhausted local reserve is backpressure, not an exhausted subscription. */
  async select(auto: string, conversation?: string, signal?: AbortSignal) {
    const deadline = Date.now() + 120_000;
    let refreshed = false;
    for (;;) {
      signal?.throwIfAborted();
      const selected = this.routing.router.resolve(auto, conversation);
      if (selected.scores.some(s => s.usable)) return selected;
      if (!refreshed && this.routing.refreshUsage) {
        logSafe('smart-route-refresh', { auto });
        await abortable(this.routing.refreshUsage(), signal);
        refreshed = true;
        continue;
      }
      const pressure = this.routing.router.reservationBlocked(auto);
      if (pressure && this.routing.refreshUsage && Date.now() < deadline) {
        await sleep(1000, signal);
        await abortable(this.routing.refreshUsage(), signal);
        continue;
      }
      for (const score of selected.scores) logSafe('smart-route-blocked', { auto, account: score.usage, reason: score.reason, reservations: pressure });
      if (pressure) throw new BackendError('Model accounts are busy with parallel requests. Retry shortly.', { retryable: true });
      throw new BackendError(`No eligible account is available for this model. ${selected.scores.map(s => `${s.slug}: ${s.reason}`).join('; ')}.`);
    }
  }

  track(body: ResponsesBody, auto: string, conversation?: string): void {
    this.contexts.set(body, { auto, conversation, attempted: new Set() });
  }
  inherit(from: ResponsesBody, to: ResponsesBody): void {
    const context = this.contexts.get(from);
    if (context) this.contexts.set(to, context);
  }

  async run<T>(body: ResponsesBody, signal: AbortSignal | undefined, attempt: () => Promise<T>, exposed: () => boolean = () => false): Promise<T> {
    const context = this.contexts.get(body);
    if (!context || body.generate === false) return attempt();
    for (;;) {
      signal?.throwIfAborted();
      // Normalization can await history/bridging. Recheck room at actual dispatch time.
      await this.select(context.auto, context.conversation, signal);
      signal?.throwIfAborted();
      // Another waiter may have reserved room while select yielded. Check and reserve atomically.
      const selected = this.routing.router.resolve(context.auto, context.conversation);
      if (!selected.scores.some(s => s.slug === selected.slug && s.usable)) continue;
      if (body.model !== selected.slug) {
        body.model = selected.slug;
        if (Array.isArray(body.input)) body.input = body.input.filter(item => item.type !== 'reasoning');
      }
      const finish = this.routing.router.reserve(body.model);
      let streaming = false;
      try {
        const result = await attempt();
        if (result instanceof Response && result.status === 401) {
          await result.body?.cancel();
          throw accountAuthRequired('Account login rejected; sign in again to its isolated profile.');
        }
        if (result instanceof Response && result.body) {
          streaming = true;
          const reader = result.body.getReader();
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try { const next = await reader.read(); if (next.done) { finish(); controller.close(); } else controller.enqueue(next.value); }
              catch (error) { finish(); controller.error(error); }
            },
            async cancel(reason) { finish(); await reader.cancel(reason); },
          });
          return new Response(stream, { status: result.status, statusText: result.statusText, headers: result.headers }) as T;
        }
        return result;
      } catch (error) {
        if (!isAccountAuthFailure(error) || signal?.aborted) throw error;
        const failed = this.routing.router.config.routes[context.auto]!.find(c => c.slug === body.model);
        if (!failed) throw error;
        context.attempted.add(failed.slug);
        this.routing.authFailed(failed.usage);
        // Always quarantine a rejected login, including a refusal after output, but never replay output.
        if (exposed()) throw error;
        const { slug, scores } = this.routing.router.resolve(context.auto, context.conversation);
        if (!scores.some(s => s.slug === slug && s.usable)) {
          if (this.routing.refreshUsage && this.routing.router.reservationBlocked(context.auto)) continue;
          throw error;
        }
        if (context.attempted.has(slug)) throw error;
        logSafe('smart-auth-failover', { auto: context.auto, from: failed.slug, to: slug });
        body.model = slug;
        // Account-bound reasoning must not cross logins; user messages, tools and tool results survive.
        if (Array.isArray(body.input)) body.input = body.input.filter(item => item.type !== 'reasoning');
      } finally { if (!streaming) finish(); }
    }
  }
}
