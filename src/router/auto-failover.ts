// Bounded account retries before output: auto routes may change accounts, explicit slugs never do.
import { AccountAuthenticationError, accountAuthRequired, BackendError } from '../backends/contract';
import { ClaudeUsageLimitError } from '../backends/claude-limits';
import { logSafe } from '../log';
import { abortable } from '../transport';
import type { ResponsesBody } from '../protocol/types';
import type { SmartRouter } from './smart-route';
import { upstreamFailure, UpstreamStatusError } from './upstream';

const QUOTA_CODES = new Set(['usage_limit_reached', 'insufficient_quota']);
const quotaFields = (fields: { type?: string | number; code?: string | number }) => QUOTA_CODES.has(String(fields.type)) || QUOTA_CODES.has(String(fields.code));

export type AutoRouting = { router: SmartRouter; authFailed: (usage: string) => void; refreshUsage?: () => Promise<void> };
type Context = { auto: string; conversation?: string; attempted: Set<string> };

export function isAccountAuthFailure(error: unknown): boolean {
  return error instanceof AccountAuthenticationError || error instanceof UpstreamStatusError && error.status === 401;
}

export class AutoFailover {
  private contexts = new WeakMap<ResponsesBody, Context>();
  private queues = new Map<string, Promise<void>>();
  constructor(private routing: AutoRouting) {}

  /** An exhausted local reserve is backpressure, not an exhausted subscription. */
  async select(auto: string, conversation?: string, signal?: AbortSignal) {
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
      if (pressure) {
        await this.routing.router.waitForCapacity(signal);
        if (this.routing.refreshUsage) await abortable(this.routing.refreshUsage(), signal);
        continue;
      }
      for (const score of selected.scores) logSafe('smart-route-blocked', { auto, account: score.usage, reason: score.reason, reservations: pressure });
      throw new BackendError(`No eligible account is available for this model. ${selected.scores.map(s => `${s.slug}: ${s.reason}`).join('; ')}.`);
    }
  }

  /** FIFO admission per auto route. Release the queue as soon as room is reserved, before inference. */
  private async admit(context: Context, signal?: AbortSignal) {
    const previous = this.queues.get(context.auto) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.queues.set(context.auto, tail);
    try {
      await abortable(previous, signal);
      for (;;) {
        await this.select(context.auto, context.conversation, signal);
        signal?.throwIfAborted();
        // Other auto routes can share this account: recheck and reserve without yielding.
        const selected = this.routing.router.resolve(context.auto, context.conversation);
        const score = selected.scores.find(s => s.slug === selected.slug && s.usable);
        if (score) return { slug: selected.slug, finish: this.routing.router.reserve(selected.slug, score.paid) };
      }
    } finally {
      release();
      void tail.then(() => { if (this.queues.get(context.auto) === tail) this.queues.delete(context.auto); });
    }
  }

  track(body: ResponsesBody, auto: string, conversation?: string): void {
    this.contexts.set(body, { auto, conversation, attempted: new Set() });
  }
  tracked(body: ResponsesBody): boolean { return body.generate !== false && this.contexts.has(body); }
  inherit(from: ResponsesBody, to: ResponsesBody): void {
    const context = this.contexts.get(from);
    if (context) this.contexts.set(to, context);
  }

  async run<T>(body: ResponsesBody, signal: AbortSignal | undefined, attempt: () => Promise<T>, exposed: () => boolean = () => false): Promise<T> {
    const context = this.contexts.get(body);
    if (!context || body.generate === false) return attempt();
    for (;;) {
      signal?.throwIfAborted();
      const { slug, finish } = await this.admit(context, signal);
      if (body.model !== slug) {
        body.model = slug;
        if (Array.isArray(body.input)) body.input = body.input.filter(item => item.type !== 'reasoning');
      }
      let streaming = false;
      try {
        const result = await attempt();
        if (result instanceof Response && result.status === 401) {
          await result.body?.cancel();
          throw accountAuthRequired('Account login rejected; sign in again to its isolated profile.');
        }
        if (result instanceof Response && result.status === 429) {
          const { fields } = await upstreamFailure(result.clone());
          if (quotaFields(fields)) {
            await result.body?.cancel();
            throw new UpstreamStatusError('Account usage limit reached', 429, fields);
          }
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
        const authFailure = isAccountAuthFailure(error);
        const quotaFailure = error instanceof ClaudeUsageLimitError || error instanceof UpstreamStatusError && quotaFields(error.fields);
        if ((!authFailure && !quotaFailure) || signal?.aborted) throw error;
        const failed = this.routing.router.config.routes[context.auto]!.find(c => c.slug === body.model);
        if (!failed) throw error;
        context.attempted.add(failed.slug);
        if (authFailure) this.routing.authFailed(failed.usage);
        else this.routing.router.quotaFailed(failed.usage, error instanceof ClaudeUsageLimitError ? error.resetsAt
          : error instanceof UpstreamStatusError && typeof error.fields.resets_at === 'number' ? error.fields.resets_at : undefined);
        // Quarantine the refused account even after output, but never replay delivered output.
        if (exposed()) throw error;
        const { slug, scores } = this.routing.router.resolve(context.auto, context.conversation);
        if (!scores.some(s => s.slug === slug && s.usable)) {
          if (this.routing.refreshUsage && this.routing.router.reservationBlocked(context.auto)) continue;
          throw error;
        }
        if (context.attempted.has(slug)) throw error;
        logSafe(authFailure ? 'smart-auth-failover' : 'smart-quota-failover', { auto: context.auto, from: failed.slug, to: slug });
        body.model = slug;
        // Account-bound reasoning must not cross logins; user messages, tools and tool results survive.
        if (Array.isArray(body.input)) body.input = body.input.filter(item => item.type !== 'reasoning');
      } finally { if (!streaming) finish(); }
    }
  }
}
