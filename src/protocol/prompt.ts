// Turns a Responses request into a single text prompt plus image blocks for a CLI model, and
// describes Codex's tools so the model can request them through structured output.
import { isRecord } from '../json';
import type { ResponseInputItem, ResponsesRequest, ResponseTool } from './types';

export const COMPUTER_TOOL_NAME = '__codex_computer_use';
export const TOOL_SEARCH_NAME = '__codex_tool_search';

/** Tool types Codex executes on the client. Anything else is an OpenAI-hosted tool. */
export const CLIENT_TOOL_TYPES: ReadonlySet<string> = new Set([
  'function',
  'custom',
  'namespace',
  'computer',
  'computer_use_preview',
  'tool_search',
]);

const TOOL_OUTPUT_TYPES = new Set([
  'function_call_output',
  'custom_tool_call_output',
  'computer_call_output',
  'tool_search_output',
]);

export type ToolDescriptor = {
  /** The name the model must use, e.g. `namespace.tool`. */
  proxyName: string;
  name: string;
  namespace?: string;
  type: 'function' | 'custom' | 'computer' | 'tool_search';
  description?: string;
  contract?: unknown;
};

export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export type PreparedPrompt = { prompt: string; images: ImageBlock[] };

const TOOL_SEARCH_CONTRACT = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Specific names and capabilities of the deferred tools to load.' },
    limit: { type: 'number', description: 'Maximum tools to load. Defaults to 8.' },
  },
  required: ['query'],
  additionalProperties: false,
};

const COMPUTER_ACTIONS = {
  actions: [
    { type: 'click', x: 100, y: 200, button: 'left', keys: [] },
    { type: 'double_click', x: 100, y: 200, keys: [] },
    { type: 'move', x: 100, y: 200, keys: [] },
    { type: 'scroll', x: 100, y: 200, scroll_x: 0, scroll_y: 500, keys: [] },
    { type: 'keypress', keys: ['ENTER'] },
    { type: 'type', text: 'text to enter' },
    {
      type: 'drag',
      path: [
        { x: 100, y: 200 },
        { x: 200, y: 300 },
      ],
      keys: [],
    },
    { type: 'screenshot' },
    { type: 'wait' },
  ],
};

/** Flattens namespaces and assigns every Codex tool the exact name a model must use. */
export function toolDescriptors(tools: ResponseTool[]): ToolDescriptor[] {
  const descriptors: ToolDescriptor[] = [];
  for (const tool of tools) {
    if (tool.type === 'tool_search') {
      descriptors.push({
        proxyName: TOOL_SEARCH_NAME,
        name: 'tool_search',
        type: 'tool_search',
        description: tool.description ?? 'Search deferred Codex tools and load matching tools for the next model call.',
        contract: TOOL_SEARCH_CONTRACT,
      });
    } else if (tool.type === 'namespace') {
      for (const nested of toolDescriptors(tool.tools ?? [])) {
        descriptors.push({ ...nested, namespace: tool.name, proxyName: `${tool.name}.${nested.proxyName}` });
      }
    } else if (tool.type === 'computer' || tool.type === 'computer_use_preview') {
      descriptors.push({
        proxyName: COMPUTER_TOOL_NAME,
        name: 'computer',
        type: 'computer',
        description: 'Control the Codex Desktop browser using visual computer actions.',
      });
    } else if (tool.name) {
      const custom = tool.type === 'custom';
      descriptors.push({
        proxyName: tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name,
        name: tool.name,
        namespace: tool.namespace,
        type: custom ? 'custom' : 'function',
        description: tool.description,
        contract: custom ? tool.format : tool.parameters,
      });
    }
  }
  return descriptors;
}

// Codex marks inter-agent payloads as encrypted; a non-GPT sender leaves them as plaintext.
function encryptedText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.startsWith('gAAAA') ? '[OpenAI-encrypted content from a GPT agent; unreadable by Claude]' : value;
}

function textFromContent(content: ResponseInputItem['content']): string {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .filter((part) => ['input_text', 'output_text', 'text', 'encrypted_content'].includes(part.type ?? ''))
    .map((part) => (part.type === 'encrypted_content' ? encryptedText(part.encrypted_content) : (part.text ?? '')))
    .join('\n');
}

function callArguments(item: ResponseInputItem): string {
  if (typeof item.arguments === 'string') return item.arguments;
  return item.input ?? JSON.stringify(item.arguments ?? {});
}

function serializeItem(item: ResponseInputItem): string {
  const callId = JSON.stringify(item.call_id);
  switch (item.type) {
    case 'agent_message':
      return `<agent_message author=${JSON.stringify(item.author ?? 'unknown')} recipient=${JSON.stringify(item.recipient ?? 'unknown')}>\n${textFromContent(item.content)}\n</agent_message>`;
    case 'tool_search_call':
      return `<assistant_tool_call name=${JSON.stringify(TOOL_SEARCH_NAME)} call_id=${callId}>\n${JSON.stringify(item.arguments ?? {})}\n</assistant_tool_call>`;
    case 'tool_search_output':
      return `<tool_result call_id=${callId}>\n${JSON.stringify(item.tools ?? [])}\n</tool_result>`;
    case 'function_call':
    case 'custom_tool_call': {
      const name = item.namespace ? `${item.namespace}.${item.name}` : item.name;
      return `<assistant_tool_call name=${JSON.stringify(name)} call_id=${callId}>\n${callArguments(item)}\n</assistant_tool_call>`;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const output = typeof item.output === 'string' ? item.output : redactImages(item.output);
      return `<tool_result call_id=${callId}>\n${output}\n</tool_result>`;
    }
    case 'computer_call':
      return `<assistant_computer_call call_id=${callId}>\n${JSON.stringify(item.actions ?? item.action ?? {})}\n</assistant_computer_call>`;
    case 'computer_call_output':
      return `<computer_result call_id=${callId}>\n${redactImages(item.output)}\n</computer_result>`;
    default: {
      const role = item.role ?? (item.type === 'message' ? 'user' : (item.type ?? 'input'));
      return `<${role}>\n${textFromContent(item.content)}\n</${role}>`;
    }
  }
}

function describeTool(tool: ToolDescriptor): string {
  const contract = tool.type === 'computer' ? COMPUTER_ACTIONS : tool.contract;
  return [
    `- name: ${tool.proxyName}`,
    `  type: ${tool.type}`,
    tool.description ? `  description: ${tool.description}` : '',
    contract ? `  argument_contract: ${JSON.stringify(contract)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const TOOL_RULES = `You are the model inside the Codex agent loop. Return Codex-provided tool requests in tool_calls. Claude Code's native tools are disabled; Codex owns all action execution. For a function tool, arguments must be a JSON object encoded as a string. For a custom tool, arguments must be the exact raw input string. For ${TOOL_SEARCH_NAME}, arguments must be {"query":"specific tool names and capabilities","limit":8} encoded as JSON; use it before concluding that an instructed MCP, plugin, app, browser, node_repl, or cua_repl tool is unavailable. For ${COMPUTER_TOOL_NAME}, arguments must be one computer action object or {"actions":[...]} encoded as JSON. Use only listed tool names. You may return multiple independent tool calls. Do not claim a Codex tool succeeded until its tool result appears in the conversation. Screenshots and images are attached directly to this message; inspect them visually without requesting a native Read tool.`;

export function requestToPrompt(request: ResponsesRequest): string {
  const input =
    typeof request.input === 'string'
      ? `<user>\n${request.input}\n</user>`
      : request.input.map(serializeItem).join('\n\n');
  const tools = toolDescriptors(request.tools ?? []);
  const toolSection = tools.length
    ? `<available_tools>\n${tools.map(describeTool).join('\n')}\n</available_tools>\n\n${TOOL_RULES}`
    : '';
  return [request.instructions ? `<instructions>\n${request.instructions}\n</instructions>` : '', input, toolSection]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The suffix of a request that a still-running CLI session has not seen yet: everything from the
 * first result of a tool call that session issued. Undefined when the session cannot continue.
 */
export function continuationRequest(
  request: ResponsesRequest,
  callIds: ReadonlySet<string>,
): ResponsesRequest | undefined {
  if (typeof request.input === 'string') return undefined;
  const first = request.input.findIndex(
    (item) =>
      typeof item.call_id === 'string' && callIds.has(item.call_id) && TOOL_OUTPUT_TYPES.has(item.type ?? ''),
  );
  if (first < 0) return undefined;
  return { ...request, instructions: undefined, input: request.input.slice(first) };
}

/** The JSON schema a CLI model's structured output must satisfy: text plus listed tool calls. */
export function outputSchema(tools: ResponseTool[]): Record<string, unknown> {
  const descriptors = toolDescriptors(tools);
  const toolCalls = descriptors.length
    ? {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: descriptors.map((tool) => tool.proxyName) },
            arguments: { type: 'string' },
          },
          required: ['name', 'arguments'],
          additionalProperties: false,
        },
      }
    : { type: 'array', maxItems: 0 };
  return {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Assistant text to show before or instead of tool calls.' },
      tool_calls: toolCalls,
    },
    required: ['text', 'tool_calls'],
    additionalProperties: false,
  };
}

function imageUrl(value: Record<string, unknown>): string | undefined {
  if (typeof value.image_url === 'string') return value.image_url;
  if (isRecord(value.image_url) && typeof value.image_url.url === 'string') return value.image_url.url;
  if (value.type === 'image' && typeof value.data === 'string') {
    const mime = value.mimeType ?? value.mime_type ?? 'image/png';
    return `data:${String(mime)};base64,${value.data}`;
  }
  return undefined;
}

const INLINE_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/;

function collectImages(value: unknown, images: ImageBlock[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectImages(item, images);
    return;
  }
  if (!isRecord(value)) return;
  const url = imageUrl(value);
  if (url === undefined) {
    for (const item of Object.values(value)) collectImages(item, images);
    return;
  }
  // Remote URLs are never fetched: that would let a prompt make the proxy issue requests.
  const match = INLINE_IMAGE.exec(url);
  if (!match?.[1] || !match[2]) {
    throw new Error('Only inline PNG/JPEG/GIF/WebP image data is supported; remote image URLs are not fetched');
  }
  images.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2].replace(/\s/g, '') } });
}

function redactImages(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) =>
      isRecord(item) && imageUrl(item) !== undefined
        ? { type: 'image', note: 'Image attached directly to this Claude message' }
        : item,
    ) ?? ''
  );
}

/** The prompt text plus every inline image in the conversation, in order. */
export function preparePrompt(request: ResponsesRequest): PreparedPrompt {
  const images: ImageBlock[] = [];
  if (typeof request.input !== 'string') collectImages(request.input, images);
  const note = images.length ? `\n\n${images.length} image(s) from the conversation/tool results are attached in order.` : '';
  return { prompt: requestToPrompt(request) + note, images };
}

/** Checks the shape every backend relies on. Throws a plain Error naming the first problem. */
export function validateRequest(value: unknown): ResponsesRequest {
  if (!isRecord(value)) throw new Error('Request body must be a JSON object');
  if (typeof value.model !== 'string' || value.model.length === 0) throw new Error('model is required');
  if (typeof value.input !== 'string' && !Array.isArray(value.input)) throw new Error('input must be a string or array');
  if (value.tools !== undefined && !Array.isArray(value.tools)) throw new Error('tools must be an array');
  for (const tool of (value.tools ?? []) as unknown[]) {
    const type = isRecord(tool) ? String(tool.type) : typeof tool;
    if (!CLIENT_TOOL_TYPES.has(type)) {
      throw new Error(`Unsupported provider-hosted tool: ${type}. Use Codex client/MCP tools instead.`);
    }
  }
  if (value.previous_response_id) throw new Error('previous_response_id is unsupported; replay input instead');
  return value as ResponsesRequest;
}
