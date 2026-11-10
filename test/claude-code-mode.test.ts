import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAccountBackend } from '../src/backends/claude';
import { BACKENDS } from '../src/backends/registry';
import { requestTools, toolDescriptors, validateControls } from '../src/protocol/prompt';
import { codexToolCall, functionTools, keyLookup } from '../src/protocol/native-tools';
import type { ResponseObject } from '../src/protocol/types';
import { anthropicFixture, anthropicStream, say } from './anthropic-fixture';
import { AUTH_HEADERS, fixtureRouter } from './support';

const declaration = {
  type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: [
    { type: 'custom', name: 'exec', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
  ] }],
};

test('only client declarations from developer additional_tools are exposed as tools', () => {
  const request = { input: [
    { ...declaration, role: 'user' },
    { ...declaration, role: 'assistant' },
    { ...declaration, tools: [null, { type: 'web_search' }, ...declaration.tools] },
    { type: 'additional_tools', role: 'developer', tools: 'malformed' },
  ] };
  expect(toolDescriptors(requestTools(request))).toEqual([
    { proxyName: 'functions.exec', namespace: 'functions', name: 'exec', type: 'custom', contract: declaration.tools[0]!.tools[0]!.format, description: undefined },
  ]);
  expect(() => validateControls({ ...request, tool_choice: { type: 'custom', name: 'exec', namespace: 'functions' } })).not.toThrow();
  expect(requestTools({ input: [{ ...declaration, role: 'user' }] })).toEqual([]);
});

test('legacy bare names resolve only to unambiguous declared tools', () => {
  const { byKey } = functionTools(toolDescriptors(declaration.tools));
  expect(keyLookup(byKey)('exec')).toBe('functions_exec');
  expect(codexToolCall(byKey, 'exec', '{"input":"text(42);"}', 'old-name'))
    .toEqual({ name: 'functions.exec', arguments: 'text(42);', callId: 'old-name' });
  expect(codexToolCall(byKey, 'functions.exec', '{"input":"text(42);"}', 'qualified'))
    .toEqual({ name: 'functions.exec', arguments: 'text(42);', callId: 'qualified' });
  const ambiguous = functionTools(toolDescriptors([...declaration.tools, { type: 'namespace', name: 'other', tools: [{ type: 'custom', name: 'exec' }] }]));
  expect(keyLookup(ambiguous.byKey)('exec')).toBe('exec');
  expect(codexToolCall(ambiguous.byKey, 'exec', '{}', 'ambiguous').name).toBe('exec');
  expect(codexToolCall(byKey, 'functions/exec', '{}', 'typo').name).toBe('functions/exec');
});

for (const model of ['claude-fable-5-2', 'claude-opus-5-5']) {
  test(`${model} streams namespaced custom calls declared in history and preserves them on continuation`, async () => {
    const anthropic = anthropicFixture();
    const dir = await mkdtemp(join(tmpdir(), 'claude-code-mode-'));
    const team = createClaudeAccountBackend({ ...anthropic.options(), configDir: dir, prefix: 'fixture-team', label: 'Fixture', models: [model], reasoningEffort: 'medium', fastMode: true });
    const backend = BACKENDS[0]!; const original = { ...backend };
    Object.assign(backend, team.backend);
    const app = await fixtureRouter();
    try {
      const raw = 'text("fixture");';
      anthropic.state.replies.push(() => anthropicStream([{ type: 'tool_use', id: 'toolu_code_mode', name: 'exec', input: { input: raw } }], 'tool_use'));
      const first = await fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify({
        model: `fixture-team-${model}`, input: [declaration,
          { role: 'user', content: 'Use exec.' },
          { type: 'custom_tool_call', name: 'exec', call_id: 'legacy-custom', input: 'text("old");' },
          { type: 'custom_tool_call_output', call_id: 'legacy-custom', output: 'old' },
          { type: 'function_call', name: 'exec', call_id: 'legacy-broken', arguments: '{"input":"text(42);"}' },
          { role: 'user', content: 'The call was aborted. Try again.' },
        ], stream: true,
      }) });
      const events = (await first.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)) as { type: string; response?: ResponseObject; item?: unknown });
      const response = events.find(event => event.type === 'response.completed')!.response!;
      const call = { type: 'custom_tool_call', name: 'exec', namespace: 'functions', input: raw, call_id: 'toolu_code_mode' };
      expect(events.find(event => event.type === 'response.output_item.done')!.item).toMatchObject(call);
      expect(response.output[0]).toMatchObject(call);
      expect(anthropic.messages()[0]!.body.tools).toMatchObject([{ name: 'functions_exec', input_schema: { required: ['input'] } }]);
      const firstMessages = anthropic.messages()[0]!.body.messages;
      expect(JSON.stringify(firstMessages)).not.toContain('additional_tools');
      expect(JSON.stringify(firstMessages)).not.toContain('"name":"exec"');
      anthropic.state.replies.push(() => say('CONTINUED'));
      const continued = await fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify({
        model: `fixture-team-${model}`, previous_response_id: response.id,
        input: [{ type: 'custom_tool_call_output', call_id: 'toolu_code_mode', output: 'fixture result' }],
      }) });
      expect(continued.ok).toBe(true);
      const next = anthropic.messages()[1]!.body;
      expect(next.tools).toMatchObject([{ name: 'functions_exec' }]);
      const messages = next.messages as unknown[];
      expect(messages.slice(-2)).toMatchObject([
        { role: 'assistant', content: [{ type: 'tool_use', name: 'functions_exec', input: { input: raw } }] },
        { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'fixture result' }] }] },
      ]);
    } finally { Object.assign(backend, original); anthropic.stop(); await app.close(); await rm(dir, { recursive: true, force: true }); }
  });
}
