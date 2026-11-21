import { expect, test } from 'bun:test';
import { pendingResponse } from '../src/protocol/pending';
import { responseObject, streamResponse } from '../src/protocol/output';
import { EMPTY_OUTPUT, type OutputItem, type ResponseObject } from '../src/protocol/types';

const marker = '::browser-complete{title="Finished browser task"}';
const answer = 'The requested task is complete.';
const textOf = (item: OutputItem): string => (item.content as { text: string }[])[0]!.text;
const messages = (response: ResponseObject) => response.output.filter(item => item.type === 'message');
const request = { model: 'fixture', input: 'finish' };
const output = (text: string) => ({ ...EMPTY_OUTPUT, text });

function check(response: ResponseObject, original: string) {
  const items = messages(response);
  expect(items.map(item => item.phase)).toEqual(['commentary', undefined]);
  expect(textOf(items[0]!).trim()).toBe(marker);
  expect(textOf(items[1]!).trim()).toBe(answer);
  expect(items.map(textOf).join('')).toBe(original);
}

test('buffered JSON and SSE isolate browser completion as commentary, preserving the answer', async () => {
  const text = `${marker}\n\n${answer}`;
  const response = responseObject(request, output(text));
  check(response, text);
  const wire = await streamResponse(response).text();
  expect(wire).toContain('"phase":"commentary"');
});

test('streamed marker is standalone commentary for every possible chunk boundary', async () => {
  const text = `${marker}\r\n\r\n${answer}`;
  for (let cut = 0; cut <= text.length; cut++) {
    const events: Record<string, unknown>[] = [];
    let remembered: ResponseObject | undefined;
    const response = await pendingResponse(request, async (_signal, sink) => {
      sink.text(text.slice(0, cut));
      sink.text(text.slice(cut));
      return responseObject(request, output(text));
    }, new AbortController().signal, event => events.push(event), result => { remembered = result; });
    check(response, text);
    expect(remembered).toEqual(response);
    const completed = events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
    expect(completed).toEqual(response.output);
    const added = events.filter(event => event.type === 'response.output_item.added').map(event => event.item as OutputItem);
    expect(added.map(item => item.phase)).toEqual(['commentary', undefined]);
    for (const item of messages(response)) {
      const deltas = events.filter(event => event.type === 'response.output_text.delta' && event.item_id === item.id);
      expect(deltas.map(event => event.delta).join('')).toBe(textOf(item));
    }
  }
});

test('one-character chunks, unstreamed suffix and marker-only answers retain the completion phase', async () => {
  for (const text of [marker, `${marker}\n\n${answer}`]) {
    for (const prefix of [text, text.slice(0, 8)]) {
      const response = await pendingResponse(request, async (_signal, sink) => {
        for (const char of prefix) sink.text(char);
        return responseObject(request, output(text));
      }, new AbortController().signal, () => {});
      expect(messages(response).map(textOf).join('')).toBe(text);
      expect(messages(response)[0]!.phase).toBe('commentary');
      expect(textOf(messages(response)[0]!).trim()).toBe(marker);
    }
  }
});

test('quoted, inline, fenced, malformed and oversized markers remain literal text', async () => {
  for (const text of [
    `Example: ${marker}`, `\`${marker}\``, `> ${marker}`, ` ${marker}`,
    `\`\`\`text\n${marker}\n\`\`\``, `~~~\n${marker}\n~~~`,
    '::browser-complete{title=""}', '::browser-complete{title="unfinished',
    `${marker} trailing text`, '::browser-complete{title="' + 'x'.repeat(5000) + '"}',
  ]) {
    const response = await pendingResponse(request, async (_signal, sink) => {
      for (const char of text) sink.text(char);
      return responseObject(request, output(text));
    }, new AbortController().signal, () => {});
    expect(messages(response).map(textOf).join('')).toBe(text);
    expect(messages(response).every(item => item.phase === undefined)).toBe(true);
    expect(messages(responseObject(request, output(text))).map(textOf).join('')).toBe(text);
    expect(messages(responseObject(request, output(text))).every(item => item.phase === undefined)).toBe(true);
  }
});

test('completion after prose or a closed code fence is separate, including consecutive completions', () => {
  for (const prefix of ['Checking finished.\n', '```\nexample\n```\n', '~~~text\nexample\n~~~\n']) {
    const text = `${prefix}${marker}\n${marker}\n${answer}`;
    const items = messages(responseObject(request, output(text)));
    expect(items.map(item => item.phase)).toEqual([undefined, 'commentary', 'commentary', undefined]);
    expect(items.map(textOf).join('')).toBe(text);
  }
});

test('tools and snapshots flush a marker without a newline before the next item', async () => {
  const call = { name: 'echo', arguments: '{}', callId: 'call_after_browser' };
  const response = await pendingResponse(request, async (_signal, sink) => {
    sink.text(marker);
    sink.call?.(call);
    expect(sink.snapshot?.()[0]!.phase).toBe('commentary');
    sink.text(answer);
    return responseObject(request, { ...output(marker + answer), toolCalls: [call] });
  }, new AbortController().signal, () => {});
  expect(response.output.map(item => [item.type, item.phase])).toEqual([
    ['message', 'commentary'], ['function_call', undefined], ['message', undefined],
  ]);
  expect(messages(response).map(textOf)).toEqual([marker, answer]);
});
