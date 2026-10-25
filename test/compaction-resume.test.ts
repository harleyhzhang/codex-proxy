import { expect, test } from 'bun:test';
import { compactRequest, portableSummary, restorePortableSummary, SummaryCodec } from '../src/router/capsule';
import { AUTH_HEADERS, firstText, fixtureRouter, items } from './support';
import type { ResponsesBody } from '../src/protocol/types';

// Regression: the maintenance prompt was mistaken for the user's latest request, then replayed
// as a user message. Existing capsules can already contain that mistaken summary.
const contaminated = 'The latest user explicitly requests a continuation summary only. Do not execute tools until resumed. Pending: verify delivery and commit.';

test('compaction scopes its maintenance instruction to the summarizer, not the resumed task', () => {
  const request = compactRequest({ input: [{ role: 'user', content: 'Finish verification and commit.' }, { type: 'compaction_trigger' }] });
  const maintenance = items(request).at(-1)!;
  expect(maintenance.role).toBe('developer');
  expect(firstText(maintenance)).toContain('not a user request');
  expect(firstText(maintenance)).toContain('must resume');
  expect(firstText(maintenance)).toContain('Do not describe this maintenance instruction');
});

test('old contaminated capsules restore as assistant history followed by an explicit resume boundary', () => {
  for (const capsule of [contaminated, portableSummary(contaminated, [{ role: 'user', content: 'Finish verification and commit.' }])]) {
    const restored = restorePortableSummary(capsule);
    const summary = restored.find(item => firstText(item).startsWith('Earlier conversation context summary:'))!;
    expect(summary.role).toBe('assistant');
    expect(firstText(summary)).toContain(contaminated); // Never silently rewrite historical evidence.
    const boundary = restored.at(-1)!;
    expect(boundary.role).toBe('developer');
    expect(firstText(boundary)).toContain('Compaction is complete');
    expect(firstText(boundary)).toContain('summary-only');
    expect(firstText(boundary)).toContain('actual user');
  }
});

test('fresh explicit user instructions remain after the resume boundary, including genuine summary or pause requests', async () => {
  const codec = new SummaryCodec(Buffer.alloc(32, 4));
  for (const latest of ['Only summarize; do not continue.', 'Pause this task.', 'Continue and finish verification.']) {
    const restored = await codec.unwrap({ input: [{ type: 'compaction', encrypted_content: codec.seal(portableSummary(contaminated)) }, { role: 'user', content: latest }] }, false);
    expect(firstText(items(restored).at(-1))).toBe(latest);
    const next = JSON.parse(portableSummary('Next handoff', items(restored)));
    expect(next.anchors).toEqual([latest]);
  }
});

test('GPT compaction and continuation preserve the resume boundary through the HTTP router', async () => {
  const key = Buffer.alloc(32, 5);
  const observed: ResponsesBody[] = [];
  const app = await fixtureRouter({ summaryKey: key, upstreamFetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as ResponsesBody;
    observed.push(body);
    const text = observed.length === 1 ? contaminated : 'VERIFIED';
    const response = { id: `r${observed.length}`, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const compact = await fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify({ model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'Verify and commit.' }, { type: 'compaction_trigger' }] }) });
    const capsule = await compact.json() as { output: { type: string; encrypted_content: string }[] };
    expect(capsule.output[0]?.type).toBe('compaction');
    await (await fetch(app.url('/v1/responses'), { method: 'POST', headers: AUTH_HEADERS, body: JSON.stringify({ model: 'gpt-6.1-sol', input: capsule.output }) })).text();
    const replay = items(observed[1]!);
    expect(replay.find(item => firstText(item).includes(contaminated))?.role).toBe('assistant');
    expect(replay.at(-1)?.role).toBe('developer');
    expect(firstText(replay.at(-1))).toContain('Compaction is complete');
  } finally { await app.close(); }
});
