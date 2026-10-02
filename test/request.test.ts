import { describe, expect, test } from "bun:test";
import { COMPUTER_TOOL_NAME, continuationRequest, outputSchema, preparePrompt, requestToPrompt, toolDescriptors, validateRequest } from '../src/protocol/prompt';

describe("Responses request adapter", () => {
  test("preserves conversation items and tool results", () => {
    const prompt = requestToPrompt({
      model: "sonnet",
      instructions: "Be concise",
      input: [
        { role: "user", content: [{ type: "input_text", text: "List files" }] },
        { type: "function_call", name: "shell", call_id: "call_1", arguments: "{\"cmd\":\"ls\"}" },
        { type: "function_call_output", call_id: "call_1", output: "README.md" },
      ],
      tools: [{ type: "function", name: "shell", description: "Run a command", parameters: { type: "object" } }],
    });
    expect(prompt).toContain("<instructions>\nBe concise");
    expect(prompt).toContain("<assistant_tool_call name=\"shell\" call_id=\"call_1\">");
    expect(prompt).toContain("<tool_result call_id=\"call_1\">\nREADME.md");
    expect(prompt).toContain("Return Codex-provided tool requests in tool_calls");
  });

  test("constrains structured output to supplied tools", () => {
    const schema = outputSchema([{ type: "custom", name: "apply_patch" }]);
    expect(JSON.stringify(schema)).toContain('"enum":["apply_patch"]');
  });

  test("keeps plaintext inter-agent payloads and flags OpenAI-encrypted ones", () => {
    const prompt = requestToPrompt({
      model: "sonnet",
      input: [
        { type: "agent_message", content: [{ type: "input_text", text: "Payload:\n" }, { type: "encrypted_content", encrypted_content: "Reply SUBAGENT-OK" }] },
        { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "gAAAAsecret" }] },
      ],
    });
    expect(prompt).toContain("Payload:\n\nReply SUBAGENT-OK");
    expect(prompt).not.toContain("gAAAAsecret");
    expect(prompt).toContain("unreadable by Claude");
  });

  test("normalizes computer and namespaced tools", () => {
    const tools = [
      { type: "computer" },
      { type: "namespace", name: "browser", tools: [{ type: "function", name: "open", parameters: { type: "object" } }] },
    ];
    expect(toolDescriptors(tools)).toEqual([
      expect.objectContaining({ proxyName: COMPUTER_TOOL_NAME, type: "computer" }),
      expect.objectContaining({ proxyName: "browser.open", name: "open", namespace: "browser" }),
    ]);
    expect(JSON.stringify(outputSchema(tools))).toContain(`"${COMPUTER_TOOL_NAME}"`);
    expect(requestToPrompt({ model: "sonnet", input: "open a page", tools })).not.toContain("undefined");
  });

  test("normalizes deferred Codex tool search", () => {
    const tools = [{ type: "tool_search", description: "Search deferred tools" }];
    expect(toolDescriptors(tools)).toEqual([
      expect.objectContaining({ proxyName: "__codex_tool_search", type: "tool_search" }),
    ]);
    expect(JSON.stringify(outputSchema(tools))).toContain('"__codex_tool_search"');
  });

  test("forwards screenshots as native image blocks without file tools", async () => {
    const prepared = preparePrompt({ model: "opus", input: [{ type: "computer_call_output", call_id: "call_1", output: { type: "computer_screenshot", image_url: "data:image/png;base64,aGVsbG8=" } }] });
    expect(prepared.images).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }]);
    expect(prepared.prompt).not.toContain("aGVsbG8=");
    expect(prepared.prompt).not.toContain("Read tool");
  });
  test("does not fetch remote screenshot URLs", async () => {
    expect(() => preparePrompt({ model: "opus", input: [{ type: "computer_call_output", output: { image_url: "http://127.0.0.1:1234/private" } }] })).toThrow("Only inline");
  });
  test("forwards input and MCP image contents", async () => {
    const prepared = preparePrompt({ model: "opus", input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }, { type: "function_call_output", output: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] }] });
    expect(prepared.images).toHaveLength(2);
    expect(prepared.prompt).not.toContain("aGVsbG8=");
  });
  test("rejects hosted tools instead of silently pretending they work", () => {
    expect(() => validateRequest({ model: "opus", input: "test", tools: [{ type: "web_search" }] })).toThrow("Unsupported provider-hosted tool");
  });

  test("rejects malformed requests", () => {
    expect(() => validateRequest({ input: "hello" })).toThrow("model is required");
  });

  test("reduces a tool continuation to new results and following input", () => {
    const request = {
      model: "sonnet",
      instructions: "original instructions",
      input: [
        { role: "user", content: "run it" },
        { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "done" },
        { role: "user", content: "summarize" },
      ],
    };
    expect(continuationRequest(request, new Set(["call_1"]))).toEqual({
      ...request,
      instructions: undefined,
      input: request.input.slice(2),
    });
  });
});
