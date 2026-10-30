// Account/speed adapters inspect the same serialized history. Parse its exact wire snapshot
// once, rather than each adapter reparsing large tool/image payloads. Weak keys retain no turns.
import { isRecord, type JsonRecord } from '../json';

type Parsed = { serialized: string; value: JsonRecord | undefined };
const parsed = new WeakMap<RequestInit, Parsed>();

/** External initializers work too; replacing their body invalidates the cached snapshot. */
export function requestJson(init: RequestInit): JsonRecord | undefined {
  if (typeof init.body !== 'string') return undefined;
  const cached = parsed.get(init);
  if (cached?.serialized === init.body) return cached.value;
  let value: unknown;
  try { value = JSON.parse(init.body); } catch {}
  const object = isRecord(value) ? value : undefined;
  parsed.set(init, { serialized: init.body, value: object });
  return object;
}

/** Copy transport options without losing a matching, already-parsed body snapshot. */
export function requestOptions(init: RequestInit, overrides: Omit<RequestInit, 'body'> = {}): RequestInit {
  const copied = { ...init, ...overrides };
  const cached = parsed.get(init);
  if (cached && cached.serialized === copied.body) parsed.set(copied, cached);
  return copied;
}

/** Rewrite only routing fields while preserving the original JSON snapshot and request options. */
export function rewriteJson(init: RequestInit, changes: JsonRecord, overrides: Omit<RequestInit, 'body'> = {}): RequestInit {
  const value = { ...requestJson(init), ...changes };
  const serialized = JSON.stringify(value);
  const rewritten: RequestInit = { ...init, ...overrides, body: serialized };
  parsed.set(rewritten, { serialized, value });
  return rewritten;
}
