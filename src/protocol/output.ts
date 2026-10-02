// Renders a backend's output as a Responses API object and as the equivalent SSE stream.
import { randomId } from '../json';
import { COMPUTER_TOOL_NAME, TOOL_SEARCH_NAME, toolDescriptors } from './prompt';
import type { OutputItem, ProxyOutput, ResponseObject, ResponseTool, ToolCall } from './types';

type RequestShape = { model?: unknown; tools?: ResponseTool[]; tool_choice?: unknown };

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${what} arguments must be valid JSON`);
  }
}

function toolSearchItem(call: ToolCall): OutputItem {
  const args = parseJson(call.arguments, 'Tool search');
  if (!args || typeof args !== 'object' || typeof (args as { query?: unknown }).query !== 'string') {
    throw new Error('Tool search arguments must include a query string');
  }
  return {
    id: randomId('ts'),
    type: 'tool_search_call',
    status: 'completed',
    call_id: call.callId ?? randomId('call'),
    execution: 'client',
    arguments: args,
  };
}

function computerItem(call: ToolCall): OutputItem {
  const action = parseJson(call.arguments, 'Computer tool');
  const batch =
    action && typeof action === 'object' && Array.isArray((action as { actions?: unknown }).actions)
      ? (action as { actions: unknown[] }).actions
      : undefined;
  return {
    id: randomId('cu'),
    type: 'computer_call',
    status: 'completed',
    call_id: call.callId ?? randomId('call'),
    pending_safety_checks: [],
    ...(batch ? { actions: batch } : { action }),
  };
}

function outputItems(request: RequestShape, output: ProxyOutput): OutputItem[] {
  const items: OutputItem[] = [];
  if (output.text) {
    items.push({
      id: randomId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', annotations: [], text: output.text }],
    });
  }
  const descriptors = toolDescriptors(request.tools ?? []);
  for (const call of output.toolCalls) {
    const descriptor = descriptors.find((tool) => tool.proxyName === call.name);
    if (call.name === TOOL_SEARCH_NAME || descriptor?.type === 'tool_search') {
      items.push(toolSearchItem(call));
    } else if (call.name === COMPUTER_TOOL_NAME || descriptor?.type === 'computer') {
      items.push(computerItem(call));
    } else if (descriptor?.type === 'custom') {
      items.push({
        id: randomId('ctc'),
        type: 'custom_tool_call',
        status: 'completed',
        call_id: call.callId ?? randomId('call'),
        name: descriptor.name,
        namespace: descriptor.namespace,
        input: call.arguments,
      });
    } else {
      items.push({
        id: randomId('fc'),
        type: 'function_call',
        status: 'completed',
        call_id: call.callId ?? randomId('call'),
        name: descriptor?.name ?? call.name,
        namespace: descriptor?.namespace,
        arguments: call.arguments,
      });
    }
  }
  return items;
}

export function responseObject(request: RequestShape, output: ProxyOutput): ResponseObject {
  return {
    id: randomId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: request.model,
    output: outputItems(request, output),
    parallel_tool_calls: true,
    tool_choice: request.tool_choice ?? 'auto',
    tools: request.tools ?? [],
    usage: {
      input_tokens: output.usage.inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: output.usage.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: output.usage.totalTokens,
    },
  };
}

/** Replays a finished response as the event sequence a streaming upstream would have sent. */
export function streamResponse(response: ResponseObject): Response {
  let sequence = 0;
  const chunks: string[] = [];
  const emit = (type: string, data: Record<string, unknown>) => {
    chunks.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  };

  emit('response.created', { response: { ...response, status: 'in_progress', output: [], usage: null } });
  response.output.forEach((item, output_index) => {
    const added: OutputItem = { ...item, status: 'in_progress' };
    if (item.type === 'message') added.content = [];
    if (item.type === 'function_call') added.arguments = '';
    if (item.type === 'custom_tool_call') added.input = '';
    emit('response.output_item.added', { output_index, item: added });

    const at = { item_id: item.id, output_index };
    if (item.type === 'message') {
      const part = (item.content as Array<{ text: string }>)[0] ?? { text: '' };
      const content = { ...at, content_index: 0 };
      emit('response.content_part.added', { ...content, part: { ...part, text: '' } });
      emit('response.output_text.delta', { ...content, delta: part.text });
      emit('response.output_text.done', { ...content, text: part.text });
      emit('response.content_part.done', { ...content, part });
    } else if (item.type === 'function_call') {
      emit('response.function_call_arguments.delta', { ...at, delta: item.arguments });
      emit('response.function_call_arguments.done', { ...at, arguments: item.arguments });
    } else if (item.type === 'custom_tool_call') {
      emit('response.custom_tool_call_input.delta', { ...at, call_id: item.call_id, delta: item.input });
      emit('response.custom_tool_call_input.done', { ...at, call_id: item.call_id, input: item.input });
    }
    emit('response.output_item.done', { output_index, item });
  });
  emit('response.completed', { response });
  chunks.push('data: [DONE]\n\n');

  return new Response(chunks.join(''), {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  });
}
