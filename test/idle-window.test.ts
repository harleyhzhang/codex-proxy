// Claude runs are bounded by silence (native Codex's stream idle timeout), not by a total
// deadline: a slow but steady stream outlives the window, dead silence trips it. Both fail on the
// old total-deadline code because the stream here lasts several windows.
import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude } from '../src/backends/claude';

const withEnv = async (values: Record<string, string>, body: () => Promise<void>) => {
  const before: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    before[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test('Claude: a slow but steady stream outlives the idle window; silence trips it and is retryable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csp-claude-idle-'));
  const mock = join(dir, 'claude');
  await Bun.write(
    mock,
    // /bin/sh, not bun: a second bun cold start inside the test runner can exceed the idle window.
    // The window is 1 s because macOS scans a freshly written executable on first exec, which
    // alone can eat a few hundred milliseconds before the first byte.
    `#!/bin/sh
case "$*" in *--include-partial-messages*) ;; *) exit 9 ;; esac
IFS= read -r input
case "$input" in *SILENT*) sleep 100 ;; esac
for i in 1 2 3 4; do sleep 0.4; printf '%s\\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0}}'; done
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"structured_output":{"text":"steady","tool_calls":[]}}'
`,
  );
  await chmod(mock, 0o755);
  await withEnv({ CLAUDE_BIN: mock, CLAUDE_TIMEOUT_MS: '1000' }, async () => {
    const started = Date.now();
    const output = await runClaude({ model: 'sonnet', input: 'steady' });
    expect(output.text).toBe('steady');
    expect(Date.now() - started).toBeGreaterThan(1500);
    const failure = await runClaude({ model: 'sonnet', input: 'SILENT' }).catch((error: unknown) => error);
    // transport.ts rewraps the worker's idle timeout as a retryable ProxyTransportError.
    expect(String(failure)).toContain('timed out');
    expect((failure as { timedOut?: boolean }).timedOut).toBe(true);
  });
  await rm(dir, { recursive: true, force: true });
});
