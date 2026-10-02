// Drives the real Claude worker against a scripted stand-in for the Claude CLI.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude } from '../src/backends/claude';

let directory = '';
let oldClaudeBin: string | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'csp-claude-worker-'));
  const mock = join(directory, 'claude');
  await writeFile(
    mock,
    `#!/bin/sh
turn=0
effort=unset
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--effort" ]; then shift; effort=$1; fi
  shift
done
while IFS= read -r input; do
  if [ "$turn" -eq 1 ]; then
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"continued-in-worker","tool_calls":[]}}'
  elif printf '%s' "$input" | grep -q 'CANCEL_PENDING'; then
    continue
  elif printf '%s' "$input" | grep -q 'EFFORT_CHANGED'; then
    printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"structured_output\\":{\\"text\\":\\"$effort\\",\\"tool_calls\\":[]}}"
  elif printf '%s' "$input" | grep -q 'persistent-first'; then
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"","tool_calls":[{"name":"lookup","arguments":"{\\"query\\":\\"value\\"}"}]}}'
    turn=1
  else
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"mock-ok","tool_calls":[]},"usage":{"input_tokens":440960,"output_tokens":2,"cache_read_input_tokens":180000}}'
  fi
done
`,
  );
  await chmod(mock, 0o755);
  oldClaudeBin = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = mock;
});

afterAll(async () => {
  if (oldClaudeBin === undefined) delete process.env.CLAUDE_BIN;
  else process.env.CLAUDE_BIN = oldClaudeBin;
  await rm(directory, { recursive: true, force: true });
});

const lookup = {
  type: 'function',
  name: 'lookup',
  description: 'Look up a value',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

describe('Claude worker', () => {
  test('answers a plain turn and reports visible usage, not cache reads', async () => {
    const output = await runClaude({ model: 'sonnet', input: 'hello' });
    expect(output.text).toBe('mock-ok');
    expect(output.usage.inputTokens).toBeLessThan(1_000);
  });

  test('continues a tool loop in the same worker', async () => {
    const first = await runClaude({ model: 'sonnet', input: 'persistent-first', tools: [lookup] });
    const call = first.toolCalls[0]!;
    expect(call.name).toBe('lookup');
    const second = await runClaude({
      model: 'sonnet',
      tools: [lookup],
      input: [
        { role: 'user', content: 'persistent-first' },
        { type: 'function_call', name: call.name, call_id: call.callId, arguments: call.arguments },
        { type: 'function_call_output', call_id: call.callId, output: 'result' },
      ],
    });
    expect(second.text).toBe('continued-in-worker');
  });

  test('restarts with a replayed transcript when the effort changes', async () => {
    const tools = [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }];
    const first = await runClaude({ model: 'opus', input: 'persistent-first', tools, reasoning: { effort: 'high' } });
    const call = first.toolCalls[0]!;
    const second = await runClaude({
      model: 'opus',
      tools,
      reasoning: { effort: 'low' },
      input: [
        { role: 'user', content: 'persistent-first' },
        { type: 'function_call', name: call.name, call_id: call.callId, arguments: call.arguments },
        { type: 'function_call_output', call_id: call.callId, output: 'EFFORT_CHANGED' },
      ],
    });
    expect(second.text).toBe('low');
  });

  test('cancellation interrupts a pending subprocess without waiting for the timeout', async () => {
    const controller = new AbortController();
    const pending = runClaude({ model: 'opus', input: 'CANCEL_PENDING' }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow('cancelled');
  });
});

test('never reuses a pre-compaction worker that would miss newly anchored constraints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csp-claude-context-'));
  const binary = join(dir, 'mock');
  const old = process.env.CLAUDE_BIN;
  await Bun.write(
    binary,
    `#!/usr/bin/env bun
await Bun.write('${dir}/starts', (await Bun.file('${dir}/starts').exists() ? await Bun.file('${dir}/starts').text() : '') + 'start\\n');
const rl = (await import('node:readline')).createInterface({ input: process.stdin });
for await (const line of rl) {
  const text = JSON.parse(line).message.content[0].text;
  const out = text.includes('ALERT_NO_WRITE') ? { text: 'ALERT_NO_WRITE', tool_calls: [] } : { text: '', tool_calls: [{ name: 'read', arguments: '{}' }] };
  console.log(JSON.stringify({ type: 'result', is_error: false, structured_output: out }));
}
`,
  );
  await chmod(binary, 0o700);
  process.env.CLAUDE_BIN = binary;
  try {
    const tools = [{ type: 'function', name: 'read' }];
    const first = await runClaude({ model: 'claude-opus-5-5', input: 'read fixture', tools });
    const second = await runClaude({
      model: 'claude-opus-5-5',
      tools,
      input: [
        { role: 'user', content: 'VERBATIM_HISTORICAL_USER_REQUEST:\nALERT_NO_WRITE' },
        { type: 'function_call_output', call_id: first.toolCalls[0]!.callId, output: 'old receipt' },
        { role: 'user', content: 'Earlier conversation context summary:\nLossy old summary' },
      ],
    });
    expect(second.text).toBe('ALERT_NO_WRITE');
    expect(await Bun.file(join(dir, 'starts')).text()).toBe('start\nstart\n');
  } finally {
    if (old === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = old;
    await rm(dir, { recursive: true, force: true });
  }
});
