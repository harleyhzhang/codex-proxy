import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A Responses-style identifier such as `resp_3f2a…`. */
export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * A pinned executable's hash, recomputed only when the file's identity or timestamps change. Hashing a
 * 70-150 MB CLI cost 26-60 ms and as large an allocation on every check; a replaced, rewritten or
 * re-permissioned file changes its inode, size, mtime or ctime and is hashed again before it runs.
 */
const pinned = new Map<string, { key: string; hash: string }>();
export function pinnedFileHash(path: string): string {
  const stat = statSync(path);
  const key = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  let entry = pinned.get(path);
  if (entry?.key !== key) pinned.set(path, entry = { key, hash: sha256(readFileSync(path)) });
  return entry.hash;
}

/** Constant-time string comparison for bearer tokens and account ids. */
export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
