import { createHash } from 'node:crypto';

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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
