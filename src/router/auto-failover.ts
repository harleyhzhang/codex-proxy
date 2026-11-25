// One bounded account retry before output: auto routes may change accounts, explicit slugs never do.
import { AccountAuthenticationError, accountAuthRequired } from '../backends/contract';
import { logSafe } from '../log';
import type { ResponsesBody } from '../protocol/types';
import type { SmartRouter } from './smart-route';
import { UpstreamStatusError } from './upstream';

export type AutoRouting = { router: SmartRouter; authFailed: (usage: string) => void };
type Context = { auto: string; conversation?: string; attempted: Set<string> };

export function isAccountAuthFailure(error: unknown): boolean {
  return error instanceof AccountAuthenticationError || error instanceof UpstreamStatusError && error.status === 401;
}

export class AutoFailover {
  private contexts = new WeakMap<ResponsesBody, Context>();
  constructor(private routing: AutoRouting) {}

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
      try {
        const result = await attempt();
        if (result instanceof Response && result.status === 401) {
          await result.body?.cancel();
          throw accountAuthRequired('Account login rejected; sign in again to its isolated profile.');
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
        if (context.attempted.has(slug) || !scores.some(s => s.slug === slug && s.usable)) throw error;
        logSafe('smart-auth-failover', { auto: context.auto, from: failed.slug, to: slug });
        body.model = slug;
        // Account-bound reasoning must not cross logins; user messages, tools and tool results survive.
        if (Array.isArray(body.input)) body.input = body.input.filter(item => item.type !== 'reasoning');
      }
    }
  }
}
