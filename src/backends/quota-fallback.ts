import { ClaudeUsageLimitError } from './claude-limits';
import type { SubscriptionBackend } from './contract';
import { outputFormat } from '../protocol/output-format';

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
    assertRequestControls(request) {
      primary.assertRequestControls?.(request);
      const native = primary.models[String(request.model)] ?? String(request.model);
      try { primary.assertAvailable?.(native); }
      catch (error) {
        if (native !== model || !(error instanceof ClaudeUsageLimitError)) throw error;
        fallback.assertRequestControls?.({ ...request, model: native });
      }
    },
    async run(request, signal, sink) {
      signal?.throwIfAborted();
      try { return await primary.run(request, signal, sink); }
      catch (error) {
        if (request.model !== model || !(error instanceof ClaudeUsageLimitError) || signal?.aborted || sink?.started) throw error;
        fallback.assertRequestControls?.(request);
        const notice = outputFormat(request) ? '' : `[${primary.name}: using Cursor Opus 5.5 because the direct Claude subscription reached its usage limit.]\n\n`;
        sink?.text(notice);
        const output = await fallback.run(request, signal, sink);
        return { ...output, text: notice + output.text };
      }
    },
  };
}
