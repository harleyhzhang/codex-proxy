import { isRecord, type JsonRecord } from '../json';
import type { ProxyOutput } from './types';
import { toolSchemaIssue } from './tool-schema';

/** The explicit wire contract; unsupported formats fail before any bridge/generation. */
export function outputFormat(request: { text?: unknown }): JsonRecord | undefined {
  if (request.text === undefined) return undefined;
  if (!isRecord(request.text)) throw new Error('Unsupported text: expected an object');
  const format = request.text.format;
  if (format === undefined) return undefined;
  if (!isRecord(format)) throw new Error('Unsupported text.format: expected an object');
  if (format.type === 'text') return undefined;
  if (format.type === 'json_object') return format;
  if (format.type !== 'json_schema' || !isRecord(format.schema)) throw new Error('Unsupported text.format: expected text, json_object or a JSON schema');
  if (format.strict !== undefined && typeof format.strict !== 'boolean') throw new Error('Unsupported text.format.strict: expected a boolean');
  return format;
}

export function claudeOutputFormat(request: { text?: unknown }): JsonRecord | undefined {
  const format = outputFormat(request);
  if (format?.type === 'json_object') throw new Error('Unsupported Claude text.format: use json_schema; arbitrary JSON-object mode is unavailable');
  return format && { type: 'json_schema', schema: format.schema };
}

/** Provider enforcement is primary. A broken/ignored contract must still never become a
 * successful turn. Validate only final completed text; preserve tools and incomplete/refusal
 * status, and never regenerate a turn that might already have executed actions. */
export function checkOutputFormat(request: { text?: unknown }, output: ProxyOutput): ProxyOutput {
  const format = outputFormat(request);
  if (!format || output.toolCalls.length || output.status && output.status !== 'completed') return output;
  let value: unknown;
  let invalid = false;
  try { value = JSON.parse(output.text); } catch { invalid = true; }
  if (!invalid) invalid = format.type === 'json_object' ? !isRecord(value) : toolSchemaIssue(value, format.schema) !== undefined;
  return invalid ? { ...output, status: 'failed', error: { code: 'invalid_prompt', message: 'The provider did not satisfy the requested JSON output format. This turn was not replayed.' } } : output;
}
