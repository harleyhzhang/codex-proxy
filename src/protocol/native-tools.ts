// Codex's client tools as plain function tools, for backends whose models make real tool calls (Cursor
// SDK custom tools, xAI Responses). Custom (raw-input) tools take their whole input as the string field
// `input`; namespaced names are flattened to identifier-safe keys and mapped back on the way out.
import { isRecord, type JsonRecord } from '../json';
import { COMPUTER_TOOL_NAME, TOOL_SEARCH_NAME, type ToolDescriptor } from './prompt';
import { resolveSchemaRef } from './tool-schema';
import type { ResponseInputItem, ToolCall } from './types';

export type FunctionTool = { description: string; inputSchema: JsonRecord };

const RAW_INPUT_NOTE = 'Pass the complete raw input as the string field "input".';

/** Each tool under a unique identifier-safe key; `byKey` maps a call back to its Codex tool. */
export function functionTools(descriptors: ToolDescriptor[]): { definitions: Record<string, FunctionTool>; byKey: Map<string, ToolDescriptor> } {
  const definitions: Record<string, FunctionTool> = Object.create(null);
  const byKey = new Map<string, ToolDescriptor>();
  const nextSuffix = new Map<string, number>();
  for (const descriptor of descriptors) {
    const base = descriptor.proxyName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'tool';
    let key = base;
    if (byKey.has(key)) {
      // Occupied keys never disappear; bases sharing a truncated stem share its suffix cursor.
      const stem = base.slice(0, 56);
      let suffix = nextSuffix.get(stem) ?? 2;
      do { key = `${stem}_${suffix++}`; } while (byKey.has(key));
      nextSuffix.set(stem, suffix);
    }
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
  const parts: string[] = [];
  if (descriptor.type === 'custom') {
    parts.push(RAW_INPUT_NOTE);
    const format = isRecord(descriptor.contract) ? descriptor.contract : undefined;
    if (format && typeof format.definition === 'string') parts.push(`Input format (${String(format.syntax ?? format.type ?? 'grammar')}):\n${format.definition}`);
  }
  if (descriptor.type === 'computer') parts.push('Arguments: one action object such as {"type":"click","x":100,"y":200,"button":"left"}, {"type":"type","text":"..."}, {"type":"keypress","keys":["ENTER"]}, {"type":"scroll","x":0,"y":0,"scroll_x":0,"scroll_y":500}, {"type":"screenshot"}, or {"actions":[...]} for several.');
  const required = parts.filter(Boolean).join('\n\n');
  if (required.length > 16_384) throw new Error('Unsupported tool contract: required input syntax exceeds the description budget');
  const prose = (descriptor.description ?? '').slice(0, Math.max(0, 16_384 - required.length - (required ? 2 : 0)));
  return [prose, required].filter(Boolean).join('\n\n');
}

/** Check syntax budgets before a foreign-history bridge could spend a generation. */
export function assertToolDescriptions(descriptors: ToolDescriptor[]): void {
  for (const descriptor of descriptors) toolDescription(descriptor);
}

function inputSchema(descriptor: ToolDescriptor): JsonRecord {
  if (descriptor.type === 'custom') return { type: 'object', properties: { input: { type: 'string', description: 'The complete raw input for this tool.' } }, required: ['input'], additionalProperties: false };
  if (descriptor.type === 'computer') return { type: 'object', additionalProperties: true };
  const contract = isRecord(descriptor.contract) ? descriptor.contract : undefined;
  if (!contract) return { type: 'object', properties: {}, additionalProperties: true };
  const object = flattenUnion(contract);
  return { ...(isRecord(contract.$defs) ? { $defs: contract.$defs } : {}), ...(isRecord(contract.definitions) ? { definitions: contract.definitions } : {}), ...object, type: 'object' };
}

const UNIONS = ['anyOf', 'oneOf', 'allOf'] as const;

/**
 * One object schema for a contract with a top-level anyOf/oneOf/allOf, which Anthropic and OpenAI function
 * tools refuse: the branches' properties merged, required only what every alternative requires (all of
 * them for allOf), and the alternatives kept verbatim in the description. Codex still checks the call
 * against the original contract.
 */
function flattenUnion(contract: JsonRecord, root = contract, seen = new Set<unknown>()): JsonRecord {
  if (seen.has(contract) || seen.size > 64) return {};
  const visited = new Set(seen).add(contract);
  const resolve = (schema: unknown): JsonRecord => {
    if (!isRecord(schema)) return {};
    if (typeof schema.$ref !== 'string') return flattenUnion(schema, root, visited);
    const target = resolveSchemaRef(root, schema.$ref);
    if (!isRecord(target)) return {};
    const { $ref: _ref, ...siblings } = schema;
    const resolved = flattenUnion(target, root, visited);
    return Object.keys(siblings).length ? flattenUnion({ allOf: [resolved, siblings] }, root, visited) : resolved;
  };
  // Any top-level union key is refused, even a malformed non-array one, so its presence alone triggers the rewrite.
  if (!UNIONS.some(key => Object.hasOwn(contract, key)) && typeof contract.$ref !== 'string') return contract;
  if (typeof contract.$ref === 'string') return resolve(contract);
  const requiredOf = (schema: JsonRecord) => Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
  const flat: JsonRecord = Object.fromEntries(Object.entries(contract).filter(([key]) => !(UNIONS as readonly string[]).includes(key)));
  const properties: JsonRecord = Object.assign(Object.create(null), isRecord(contract.properties) ? contract.properties : {});
  const required = new Set(requiredOf(contract));
  const notes: string[] = [];
  const combine = (key: 'anyOf' | 'allOf', schemas: unknown[]): unknown => {
    const unique = [...new Map(schemas.map(schema => [JSON.stringify(schema), schema])).values()];
    return unique.length === 1 ? unique[0] : { [key]: unique };
  };
  for (const key of UNIONS) {
    if (!Array.isArray(contract[key])) continue;
    const branches = (contract[key] as unknown[]).map(resolve);
    const names = new Set(branches.flatMap(branch => isRecord(branch.properties) ? Object.keys(branch.properties) : []));
    for (const name of names) {
      const schemas = branches.flatMap(branch => {
        if (isRecord(branch.properties) && Object.hasOwn(branch.properties, name)) return [branch.properties[name]];
        // An alternative permitting arbitrary properties must not narrow this field to another branch.
        return key !== 'allOf' && branch.additionalProperties !== false ? [isRecord(branch.additionalProperties) ? branch.additionalProperties : {}] : [];
      });
      const merged = combine(key === 'allOf' ? 'allOf' : 'anyOf', schemas);
      properties[name] = Object.hasOwn(properties, name) ? combine('allOf', [properties[name], merged]) : merged;
    }
    if (key === 'allOf') for (const branch of branches) for (const name of requiredOf(branch)) required.add(name);
    else {
      const shared = branches.map(requiredOf).reduce<string[] | undefined>((common, list) => common ? common.filter(name => list.includes(name)) : list, undefined) ?? [];
      for (const name of shared) required.add(name);
    }
    notes.push(`Arguments must satisfy the original ${key} contract: ${JSON.stringify(contract[key])}`);
  }
  const description = [typeof contract.description === 'string' ? contract.description.slice(0, 8_192) : '', ...notes].filter(Boolean).join('\n\n');
  delete flat.required; delete flat.description;
  return { ...flat, type: 'object', properties, ...(required.size ? { required: [...required] } : {}), ...(description ? { description } : {}) };
}

/** A raw-input tool's string: `input`, or the single string field a model used instead. */
function rawInput(args: JsonRecord): string | undefined {
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
  const descriptor = byKey.get(name) ?? unambiguousTool(byKey, name)?.[1];
  if (descriptor?.type === 'custom') {
    let args: unknown;
    try { args = JSON.parse(raw); } catch {}
    // Malformed raw input still reaches Codex as written, which reports it to the model like any tool error.
    return { name: descriptor.proxyName, arguments: (isRecord(args) ? rawInput(args) : undefined) ?? raw, callId };
  }
  return { name: descriptor?.proxyName ?? name, arguments: raw, callId };
}

/** Older history can use a bare name before Codex moves that tool into a namespace. Resolve
 * only explicitly declared identities, never a fuzzy spelling or an ambiguous short name. */
function unambiguousTool(byKey: Map<string, ToolDescriptor>, name: string): [string, ToolDescriptor] | undefined {
  let bare: [string, ToolDescriptor] | undefined;
  let ambiguous = false;
  for (const entry of byKey) {
    const descriptor = entry[1];
    if (descriptor.proxyName === name) return entry;
    if (descriptor.name === name) {
      if (bare) ambiguous = true;
      bare = entry;
    }
  }
  return ambiguous ? undefined : bare;
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
  const bare = new Map<string, string | null>();
  for (const [key, descriptor] of byKey) bare.set(descriptor.name, bare.has(descriptor.name) ? null : key);
  for (const [name, key] of bare) if (key !== null && !keys.has(name)) keys.set(name, key);
  return name => byKey.has(name) ? name : keys.get(name) ?? (name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'tool');
}
