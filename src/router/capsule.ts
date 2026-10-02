// Compaction for subscription models. Codex keeps compactions as opaque `encrypted_content`; for a
// CLI model the router writes its own capsule instead: the model's summary plus the user's recent
// requests verbatim, sealed with a local AES-256-GCM key so only this router can open it.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isRecord } from '../json';
import { log } from '../log';
import type { ResponseContentPart, ResponseInputItem, ResponsesBody } from '../protocol/types';

const CAPSULE_PREFIX = 'ccp_v1.';
const CONTEXT_FORMAT = 'ccp_context_v2';
// Capsules written by earlier builds stay readable.
const LEGACY_CAPSULE_PREFIXES = ['harley_cc_v1.'];
const LEGACY_CONTEXT_FORMATS = ['harley_cc_context_v2'];

export const ANCHOR_PREFIX = 'VERBATIM_HISTORICAL_USER_REQUEST:\n';
export const SUMMARY_PREFIX = 'Earlier conversation context summary:';
const COMPACTION_TYPES = new Set(['compaction', 'compaction_summary', 'context_compaction']);
const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'computer_call', 'tool_search_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'computer_call_output', 'tool_search_output']);

/** Upper bound for the verbatim part of a capsule. */
const PORTABLE_CAPACITY = 96_000;
const MAX_ANCHOR_CHARS = 8192;
const MAX_RECEIPT_BYTES = 16_384;
const MAX_RECEIPTS = 4;

const IV_BYTES = 12;
const TAG_BYTES = 16;

export const FOREIGN_HISTORY_ERROR =
  'OpenAI-encrypted history cannot be read by a subscription model; use GPT or a new chat with a plaintext summary';

const COMPACT_INSTRUCTION =
  'Summarize the conversation for another model to continue the same task. Preserve user requests, constraints, decisions, exact paths and identifiers, completed work, unresolved work, and tool outcomes. Distinguish facts from uncertainty. Do not execute tools or answer the previous request. Return only a thorough continuation summary.';

const userText = (text: string): ResponseInputItem => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});
const summaryMessage = (text: string) => userText(`${SUMMARY_PREFIX}\n${text}`);

function plainText(content: ResponseInputItem['content']): string {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .filter((part: ResponseContentPart) => ['input_text', 'text', 'output_text'].includes(part.type ?? ''))
    .map((part) => part.text ?? '')
    .join('\n');
}

/**
 * Bundles a model's summary with the user's requests verbatim and the newest small tool receipts,
 * so constraints survive compaction exactly. Over capacity it trims the least valuable material
 * first: oldest receipts, then the oldest middle requests. The first request (the original task)
 * and the newest stay; anything trimmed is still covered by the summary and is counted.
 */
export function portableSummary(summary: string, input: ResponseInputItem[] = []): string {
  const anchors: string[] = [];
  for (const item of input) {
    if (item?.role !== 'user') continue;
    let text = plainText(item.content);
    if (text.startsWith(SUMMARY_PREFIX)) continue;
    if (text.startsWith(ANCHOR_PREFIX)) text = text.slice(ANCHOR_PREFIX.length);
    // Large pasted documents still rely on the summary; short instructions stay exact.
    if (text && text.length <= MAX_ANCHOR_CHARS && !anchors.includes(text)) anchors.push(text);
  }

  const calls = new Map(
    input.filter((item) => CALL_TYPES.has(item?.type ?? '') && item.call_id).map((item) => [item.call_id, item]),
  );
  const receipts = input
    .filter(
      (item) =>
        OUTPUT_TYPES.has(item?.type ?? '') &&
        calls.has(item.call_id) &&
        Buffer.byteLength(JSON.stringify([calls.get(item.call_id), item])) <= MAX_RECEIPT_BYTES,
    )
    .slice(-MAX_RECEIPTS);
  const toolHistory = () => receipts.flatMap((item) => [calls.get(item.call_id), item]);
  const size = () => Buffer.byteLength(JSON.stringify({ anchors, tool_history: toolHistory() }));

  while (size() > PORTABLE_CAPACITY && receipts.length) receipts.shift();
  let omitted = 0;
  while (size() > PORTABLE_CAPACITY && anchors.length > 2) {
    anchors.splice(1, 1);
    omitted++;
  }
  if (size() > PORTABLE_CAPACITY) {
    throw new Error(
      'Compaction verbatim request capacity exceeded; continue with a larger-context model or a new chat retaining these requests',
    );
  }
  if (omitted) log.warn('compaction-anchors-trimmed', { omitted, kept: anchors.length });
  const note = omitted
    ? `\n\n[${omitted} older verbatim user requests exceeded capsule capacity; they are reflected only in this summary.]`
    : '';
  return JSON.stringify({ format: CONTEXT_FORMAT, summary: summary + note, anchors, tool_history: toolHistory() });
}

/** Turns a capsule back into conversation items. Plain-text summaries come back as one message. */
export function restorePortableSummary(text: string): ResponseInputItem[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [summaryMessage(text)];
  }
  if (!isRecord(value) || ![CONTEXT_FORMAT, ...LEGACY_CONTEXT_FORMATS].includes(String(value.format))) {
    return [summaryMessage(text)];
  }
  const toolHistory = value.tool_history ?? [];
  const valid =
    typeof value.summary === 'string' &&
    Array.isArray(value.anchors) &&
    value.anchors.every((anchor) => typeof anchor === 'string') &&
    Array.isArray(toolHistory) &&
    Buffer.byteLength(JSON.stringify({ anchors: value.anchors, tool_history: toolHistory })) <= PORTABLE_CAPACITY;
  if (!valid) throw new Error('Compaction capsule contains invalid verbatim requests');

  return [
    ...(value.anchors as string[]).map((anchor) => userText(ANCHOR_PREFIX + anchor)),
    ...(toolHistory as ResponseInputItem[]),
    summaryMessage(
      `The preceding verbatim requests are historical and may already be completed. Preserve their constraints; later requests supersede earlier ones. Use this summary for current completion state.\n${value.summary}`,
    ),
  ];
}

/** Asks the current model for a continuation summary instead of running the conversation. */
export function compactRequest(body: ResponsesBody): ResponsesBody {
  const input = (Array.isArray(body.input) ? body.input : []).filter((item) => item.type !== 'compaction_trigger');
  const { previous_response_id: _previous, context_management: _context, ...rest } = body;
  return { ...rest, input: [...input, userText(COMPACT_INSTRUCTION)], tools: [], tool_choice: 'auto', stream: true };
}

/** Decrypts an OpenAI-encrypted compaction through GPT; see CompactionBridge. */
export type ForeignSummary = (encrypted: string) => Promise<string>;

/** Seals and opens capsules with the router's local 32-byte key. */
export class SummaryCodec {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Invalid local summary key');
  }

  static isCapsule(value: string): boolean {
    return [CAPSULE_PREFIX, ...LEGACY_CAPSULE_PREFIXES].some((prefix) => value.startsWith(prefix));
  }

  seal(text: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return CAPSULE_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  open(value: string): string {
    const prefix = [CAPSULE_PREFIX, ...LEGACY_CAPSULE_PREFIXES].find((candidate) => value.startsWith(candidate));
    if (!prefix) throw new Error(FOREIGN_HISTORY_ERROR);
    const bytes = Buffer.from(value.slice(prefix.length), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, IV_BYTES));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }

  /**
   * Replaces compaction items with readable context. Local capsules are opened for every model;
   * OpenAI ciphertext is left alone for GPT and translated through `foreignSummary` otherwise.
   */
  async unwrap(body: ResponsesBody, isLocalModel: boolean, foreignSummary?: ForeignSummary): Promise<ResponsesBody> {
    if (!Array.isArray(body.input)) return body;
    let changed = false;
    const input: ResponseInputItem[] = [];
    for (const item of body.input) {
      const encrypted = item?.encrypted_content;
      if (!COMPACTION_TYPES.has(item?.type ?? '') || !encrypted) {
        input.push(item);
      } else if (SummaryCodec.isCapsule(encrypted)) {
        changed = true;
        input.push(...restorePortableSummary(this.open(encrypted)));
      } else if (isLocalModel) {
        if (!foreignSummary) throw new Error(FOREIGN_HISTORY_ERROR);
        changed = true;
        input.push(summaryMessage(await foreignSummary(encrypted)));
      } else {
        input.push(item);
      }
    }
    if (!changed) return { ...body, input };
    const { previous_response_id: _previous, ...rest } = body;
    return { ...rest, input };
  }
}
