import { describe, expect, test } from "bun:test";
import { responseObject, streamResponse, upgradeToolSearchIds } from '../src/protocol/output';

describe("Responses API output", () => {
  const request = { model: "sonnet", input: "hello", stream: true } as const;
  const output = { text: "Hi", toolCalls: [{ name: "shell", arguments: "{\"cmd\":\"pwd\"}" }], usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } };

  test("creates message and function call items", () => {
    const response = responseObject(request, output);
    expect(response.output.map((item) => item.type)).toEqual(["message", "function_call"]);
    expect(response.usage?.total_tokens).toBe(13);
  });

  test("preserves proxy-assigned tool call IDs", () => {
    const response = responseObject(request, {
      ...output,
      toolCalls: [{ name: "shell", arguments: "{}", callId: "call_session_route" }],
    });
    expect(response.output[1].call_id).toBe("call_session_route");
  });

  test("emits Codex-compatible SSE events", async () => {
    const body = await streamResponse(responseObject(request, output)).text();
    expect(body).toContain("event: response.created");
    expect(body).toContain("event: response.output_text.delta");
    expect(body).toContain("event: response.function_call_arguments.done");
    expect(body).toContain("event: response.completed");
    expect(body).toEndWith("data: [DONE]\n\n");
  });

  test("uses custom tool call items for freeform tools", async () => {
    const customRequest = { ...request, tools: [{ type: "custom" as const, name: "apply_patch" }] };
    const customOutput = { ...output, toolCalls: [{ name: "apply_patch", arguments: "*** Begin Patch" }] };
    const response = responseObject(customRequest, customOutput);
    expect(response.output[1]).toMatchObject({ type: "custom_tool_call", input: "*** Begin Patch" });
    expect(await streamResponse(response).text()).toContain("event: response.custom_tool_call_input.delta");
  });

  test("returns computer calls for browser actions", async () => {
    const computerRequest = { ...request, tools: [{ type: "computer" }] };
    const computerOutput = { ...output, toolCalls: [{ name: "__codex_computer_use", arguments: '{"type":"click","x":10,"y":20,"button":"left"}' }] };
    const response = responseObject(computerRequest, computerOutput);
    expect(response.output[1]).toMatchObject({
      type: "computer_call",
      action: { type: "click", x: 10, y: 20, button: "left" },
      pending_safety_checks: [],
    });
    expect(await streamResponse(response).text()).toContain('"type":"computer_call"');
  });

  test("returns client tool search calls for deferred MCP discovery", () => {
    const searchRequest = { ...request, tools: [{ type: "tool_search" }] };
    const searchOutput = { ...output, toolCalls: [{ name: "__codex_tool_search", arguments: '{"query":"browser cua_repl node_repl","limit":8}' }] };
    const response = responseObject(searchRequest, searchOutput);
    expect(response.output[1]).toMatchObject({
      type: "tool_search_call",
      execution: "client",
      arguments: { query: "browser cua_repl node_repl", limit: 8 },
    });
    expect(String(response.output[1].id)).toMatch(/^tsc_[0-9a-f]{32}$/);
  });

  test("upgrades legacy ts_ tool search ids that OpenAI rejects", () => {
    const legacy = { id: "ts_0123456789abcdef0123456789abcdef", type: "tool_search_call", call_id: "call_1", execution: "client", arguments: { query: "browser" } };
    const current = { id: "tsc_abc", type: "tool_search_call", call_id: "call_2", execution: "client", arguments: { query: "files" } };
    const other = { id: "ts_not_a_search", type: "function_call", call_id: "call_3", name: "f", arguments: "{}" };
    const upgraded = upgradeToolSearchIds({ model: "gpt-test", input: [legacy, current, other] });
    expect(upgraded.input).toEqual([{ ...legacy, id: "tsc_0123456789abcdef0123456789abcdef" }, current, other]);
    const clean = { model: "gpt-test", input: [current, other] };
    expect(upgradeToolSearchIds(clean)).toBe(clean);
  });
});
