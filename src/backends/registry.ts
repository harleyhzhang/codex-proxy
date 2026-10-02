// The single list of subscription backends. Adding a family is one entry here plus its adapter
// module; routing, compaction, handoffs, the catalog and the shared contract tests read this list.
import { claudeBackend } from './claude';
import { BackendError, type SubscriptionBackend } from './contract';
import { grokBackend } from './grok';

export const BACKENDS: readonly SubscriptionBackend[] = [claudeBackend, grokBackend];

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
  const owner = BACKENDS.find((backend) => model.startsWith(backend.reservedPrefix));
  if (owner && !Object.hasOwn(owner.models, model)) throw new BackendError(`Unsupported ${owner.name} model`);
}

/** The slugs a backend lists in the model picker. Hidden aliases still route. */
export function publicModels(backend: SubscriptionBackend): string[] {
  return backend.catalog.map((model) => model.slug);
}
