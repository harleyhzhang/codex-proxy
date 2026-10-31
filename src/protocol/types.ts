// The slice of the OpenAI Responses API that Codex speaks.

export type ResponseTool = {
  type: string;
  name?: string;
  namespace?: string;
  description?: string;
  parameters?: unknown;
  format?: unknown;
  tools?: ResponseTool[];
  [key: string]: unknown;
};

export type ResponseContentPart = {
  type?: string;
  text?: string;
  image_url?: string;
  file_id?: string;
  encrypted_content?: string;
  [key: string]: unknown;
};

export type ResponseInputItem = {
  type?: string;
  id?: string;
  role?: string;
  content?: string | ResponseContentPart[];
  name?: string;
  namespace?: string;
  call_id?: string;
  arguments?: unknown;
  input?: string;
  output?: unknown;
  tools?: unknown[];
  execution?: string;
  status?: string;
  action?: unknown;
  actions?: unknown[];
  author?: string;
  recipient?: string;
  encrypted_content?: string;
};

/** A request that passed `validateRequest`: a backend may rely on every field's type. */
export type ResponsesRequest = {
  model: string;
  instructions?: string;
  input: string | ResponseInputItem[];
  tools?: ResponseTool[];
  tool_choice?: unknown;
  stream?: boolean;
  max_output_tokens?: number;
  reasoning?: { effort?: string };
};

/** A body as Codex sends it. Fields the router does not understand are forwarded untouched. */
export type ResponsesBody = Partial<ResponsesRequest> & {
  previous_response_id?: string;
  generate?: boolean;
  type?: string;
  [key: string]: unknown;
};

export type ToolCall = { name: string; arguments: string; callId?: string };

type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };

/** What a subscription backend returns for one turn. */
export type ProxyOutput = { text: string; toolCalls: ToolCall[]; usage: Usage };

/**
 * Where a backend streams the assistant text of the turn it is running, as it arrives. `started` turns
 * true with the first delta: from then on the text has reached Codex, so the turn must not be retried
 * or replayed (the same text would appear twice). The final output's text must begin with what was streamed.
 */
export type TextSink = { text(delta: string): void; readonly started: boolean };

export type OutputItem = { type: string; id?: string; [key: string]: unknown };

/** Token accounting in the Responses API wire format. */
type ResponseUsage = {
  input_tokens: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details?: { reasoning_tokens: number };
  total_tokens: number;
};

export type ResponseObject = {
  id: string;
  status?: string;
  model?: unknown;
  output: OutputItem[];
  usage?: ResponseUsage | null;
  [key: string]: unknown;
};

export type StreamEvent = { type: string; [key: string]: unknown };

export const EMPTY_OUTPUT: ProxyOutput = {
  text: '',
  toolCalls: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
};
