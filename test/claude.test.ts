import { describe, expect, test } from "bun:test";
import { buildClaudeArgs } from '../src/backends/claude';
import { estimateVisibleTokens } from '../src/backends/contract';

describe("Claude subprocess boundaries", () => {
  test("leaves actions to Codex and disables native tools, MCPs, hooks and plugins", () => {
    const args = buildClaudeArgs({ model: "opus", input: "hello" });
    expect(args).not.toContain("--dangerously-skip-permissions");
    for (const [flag, value] of [["--tools", ""], ["--setting-sources", ""], ["--mcp-config", '{"mcpServers":{}}'], ["--settings", '{"disableAllHooks":true,"fastMode":false}']]) {
      expect(args[args.indexOf(flag) + 1]).toBe(value);
    }
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-chrome");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
  });
  test("estimates Codex-visible UTF-8 content", () => {
    expect(estimateVisibleTokens("hello")).toBe(2);
    expect(estimateVisibleTokens("")).toBe(0);
  });
  test("forwards supported effort and refuses silent downgrade", () => {
    for (const effort of ["low", "medium", "high"]) {
      const args = buildClaudeArgs({ model: "opus", input: "hello", reasoning: { effort } });
      expect(args[args.indexOf("--effort") + 1]).toBe(effort);
    }
    expect(() => buildClaudeArgs({ model: "opus", input: "hello", reasoning: { effort: "max" } })).toThrow("Unsupported staged effort");
  });
});
