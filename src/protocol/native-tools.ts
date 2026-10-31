// Codex's client tools as plain function tools, for backends whose models make real tool calls (Cursor
// SDK custom tools, xAI Responses). Custom (raw-input) tools take their whole input as the string field
// `input`; namespaced names are flattened to identifier-safe keys and mapped back on the way out.
import { isRecord, type JsonRecord } from '../json';
import type { ToolDescriptor } from './prompt';
import type { ToolCall } from './types';

export type FunctionTool = { description: string; inputSchema: JsonRecord };

export const RAW_INPUT_NOTE = 'Pass the complete raw input as the string field "input".';

/** Each tool under a unique identifier-safe key; `byKey` maps a call back to its Codex tool. */
export function functionTools(descriptors: ToolDescriptor[]): { definitions: Record<string, FunctionTool>; byKey: Map<string, ToolDescriptor> } {
  const definitions: Record<string, FunctionTool> = {};
  const byKey = new Map<string, ToolDescriptor>();
  for (const descriptor of descriptors) {
    const base = descriptor.proxyName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'tool';
    let key = base;
    for (let suffix = 2; byKey.has(key); suffix++) key = `${base.slice(0, 56)}_${suffix}`;
    byKey.set(key, descriptor);
    definitions[key] = { description: toolDescription(descriptor), inputSchema: inputSchema(descriptor) };
  }
  return { definitions, byKey };
}

/** The tools that take one raw string in the field "input". */
export function rawInputTools(byKey: Map<string, ToolDescriptor>): string[] {
  return [...byKey].filter(([, descriptor]) => descriptor.type === 'custom').map(([key]) => key);
}

function toolDescription(descriptor: ToolDescriptor): string {
  const parts = [descriptor.description ?? ''];
  if (descriptor.type === 'custom') {
    parts.push(RAW_INPUT_NOTE);
    const format = isRecord(descriptor.contract) ? descriptor.contract : undefined;
    if (format && typeof format.definition === 'string') parts.push(`Input format (${String(format.syntax ?? format.type ?? 'grammar')}):\n${format.definition}`);
  }
  if (descriptor.type === 'computer') parts.push('Arguments: one action object such as {"type":"click","x":100,"y":200,"button":"left"}, {"type":"type","text":"..."}, {"type":"keypress","keys":["ENTER"]}, {"type":"scroll","x":0,"y":0,"scroll_x":0,"scroll_y":500}, {"type":"screenshot"}, or {"actions":[...]} for several.');
  return parts.filter(Boolean).join('\n\n').slice(0, 16_384);
}

function inputSchema(descriptor: ToolDescriptor): JsonRecord {
  if (descriptor.type === 'custom') return { type: 'object', properties: { input: { type: 'string', description: 'The complete raw input for this tool.' } }, required: ['input'], additionalProperties: false };
  if (descriptor.type === 'computer') return { type: 'object', additionalProperties: true };
  const contract = isRecord(descriptor.contract) ? descriptor.contract : undefined;
  if (!contract) return { type: 'object', properties: {}, additionalProperties: true };
  return contract.type === 'object' ? contract : { ...contract, type: 'object' };
}

/** A raw-input tool's string: `input`, or the single string field a model used instead. */
export function rawInput(args: JsonRecord): string | undefined {
  if (typeof args.input === 'string') return args.input;
  const strings = Object.values(args).filter((value): value is string => typeof value === 'string');
  return Object.keys(args).length === 1 && strings.length === 1 ? strings[0] : undefined;
}

/** The Codex call for a function call, or the error the model is told so it can correct itself. */
export function codexCall(descriptor: ToolDescriptor, args: unknown, callId: string): ToolCall | { error: string } {
  const record = isRecord(args) ? args : {};
  if (descriptor.type === 'custom') {
    const raw = rawInput(record);
    return raw === undefined ? { error: `${descriptor.proxyName} takes raw input. ${RAW_INPUT_NOTE}` } : { name: descriptor.proxyName, arguments: raw, callId };
  }
  return { name: descriptor.proxyName, arguments: JSON.stringify(record), callId };
}
