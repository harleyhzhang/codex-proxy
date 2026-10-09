import { ClaudeUsageLimitError } from './claude-limits';
import type { SubscriptionBackend } from './contract';

/** Opt-in same-model supplier fallback. Apply only to the chosen secondary Claude backend.
 * Both suppliers buffer an entire response before returning any tool calls to Codex. */
export function withOpusQuotaFallback(primary: SubscriptionBackend, fallback: SubscriptionBackend): SubscriptionBackend {
  const model = 'claude-opus-5-5';
  return {
    ...primary,
    assertAvailable(nativeModel) {
      try { primary.assertAvailable?.(nativeModel); }
      catch (error) { if (nativeModel !== model || !(error instanceof ClaudeUsageLimitError)) throw error; }
    },
    async run(request, signal) {
      signal?.throwIfAborted();
      try { return await primary.run(request, signal); }
      catch (error) {
        if (request.model !== model || !(error instanceof ClaudeUsageLimitError) || signal?.aborted) throw error;
        const output = await fallback.run(request, signal);
        return { ...output, text: `[${primary.name}: using Cursor Opus 5.5 because the direct Claude subscription reached its usage limit.]\n\n${output.text}` };
      }
    },
  };
}
