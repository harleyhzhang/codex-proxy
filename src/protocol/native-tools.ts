// Codex's client tools as plain function tools, for backends whose models make real tool calls (Cursor
// SDK custom tools, xAI Responses). Custom (raw-input) tools take their whole input as the string field
// `input`; namespaced names are flattened to identifier-safe keys and mapped back on the way out.
import { isRecord, type JsonRecord } from '../json';
import { COMPUTER_TOOL_NAME, TOOL_SEARCH_NAME, type ToolDescriptor } from './prompt';
import type { ResponseInputItem, ToolCall } from './types';

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

/** A model's function call as the Codex call it stands for; raw-input tools get their string back. */
export function codexToolCall(byKey: Map<string, ToolDescriptor>, name: string, raw: string, callId: string | undefined): ToolCall {
  const descriptor = byKey.get(name);
  if (descriptor?.type === 'custom') {
    let args: unknown;
    try { args = JSON.parse(raw); } catch {}
    // Malformed raw input still reaches Codex as written, which reports it to the model like any tool error.
    return { name: descriptor.proxyName, arguments: (isRecord(args) ? rawInput(args) : undefined) ?? raw, callId };
  }
  return { name: descriptor?.proxyName ?? name, arguments: raw, callId };
}

export const HISTORY_CALL_TYPES: ReadonlySet<string> = new Set(['function_call', 'custom_tool_call', 'tool_search_call', 'computer_call']);
export const HISTORY_OUTPUT_TYPES: ReadonlySet<string> = new Set(['function_call_output', 'custom_tool_call_output', 'computer_call_output', 'tool_search_output']);

/** A history call's Codex tool name, as `toolDescriptors` names it. */
export function historyToolName(item: ResponseInputItem): string {
  if (item.type === 'tool_search_call') return TOOL_SEARCH_NAME;
  if (item.type === 'computer_call') return COMPUTER_TOOL_NAME;
  const name = String(item.name ?? '');
  return item.namespace && !name.startsWith(`${item.namespace}.`) ? `${item.namespace}.${name}` : name;
}

/** A history call's arguments as the JSON object string the function tool takes. */
export function historyCallArguments(item: ResponseInputItem): string {
  if (item.type === 'custom_tool_call') return JSON.stringify({ input: item.input ?? '' });
  if (item.type === 'computer_call') return JSON.stringify(item.actions ? { actions: item.actions } : item.action ?? {});
  return typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
}

/** The function key a request declares for a Codex tool name; unknown names are made key-safe. */
export function keyLookup(byKey: Map<string, ToolDescriptor>): (name: string) => string {
  const keys = new Map([...byKey].map(([key, descriptor]) => [descriptor.proxyName, key]));
  return name => keys.get(name) ?? (name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'tool');
}
