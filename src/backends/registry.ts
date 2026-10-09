// The single list of subscription backends. Adding a family is one entry here plus its adapter
// module; routing, compaction, handoffs, the catalog and the shared contract tests read this list.
import { claudeBackend, configuredClaudeAccount } from './claude';
import { BackendError, type SubscriptionBackend } from './contract';
import { grokBackend } from './grok';
import { configuredCursorBackend } from './cursor';
import { withOpusQuotaFallback } from './quota-fallback';

export const secondaryClaude = configuredClaudeAccount();

export const cursorBackend = configuredCursorBackend();
if (process.env.CURSOR_CLAUDE_ACCOUNT_FALLBACK === '1' && (!secondaryClaude || !cursorBackend)) throw new Error('Cursor Claude fallback requires both a secondary Claude account and Cursor backend');
const workClaude = secondaryClaude && (cursorBackend && process.env.CURSOR_CLAUDE_ACCOUNT_FALLBACK === '1' ? withOpusQuotaFallback(secondaryClaude.backend, cursorBackend) : secondaryClaude.backend);
export const BACKENDS: readonly SubscriptionBackend[] = [claudeBackend, grokBackend, ...(workClaude ? [workClaude] : []), ...(cursorBackend ? [cursorBackend] : [])];

export function backendFor(model: unknown): SubscriptionBackend | undefined {
  if (typeof model !== 'string') return undefined;
  return BACKENDS.find((backend) => Object.hasOwn(backend.models, model));
}

/** True when the model is served by a local subscription CLI rather than by OpenAI. */
export function isLocalModel(model: unknown): boolean {
  return backendFor(model) !== undefined;
}

/** Refuses a slug inside a backend's reserved namespace that is not one of its models. */
export function assertRoutable(model: unknown): void {
  if (typeof model !== 'string') throw new BackendError('Model is required');
  if (backendFor(model)) return;
  const owner = BACKENDS.filter(backend => model.startsWith(backend.reservedPrefix)).sort((a,b) => b.reservedPrefix.length - a.reservedPrefix.length)[0];
  if (owner && !Object.hasOwn(owner.models, model)) throw new BackendError(`Unsupported ${owner.name} model`);
}

/** The slugs a backend lists in the model picker. Hidden aliases still route. */
export function publicModels(backend: SubscriptionBackend): string[] {
  return backend.catalog.map((model) => model.slug);
}
