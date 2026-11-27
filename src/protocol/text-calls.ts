/**
 * The proxy serializes some history as transcript tags (`<assistant_tool_call>`, `<tool_result>`),
 * and a model sometimes imitates them: it writes a whole tool call as text instead of calling the tool,
 * so Codex shows the tag and ends the turn without running anything. At the start of a line outside a
 * code fence, a complete `<assistant_tool_call name="…">…</assistant_tool_call>` block is offered to
 * `call`; an accepted block becomes a real call and leaves the text. A stray `<assistant>` or
 * `</assistant>` line is dropped. Anything else, including a rejected block, streams through unchanged.
 * Only a line that could still become one of these is held back; ordinary prose is not delayed.
 */
const OPEN_PREFIX = '<assistant_tool_call ';
const CLOSE = '</assistant_tool_call>';
const OPEN = /^<assistant_tool_call name=("(?:[^"\\\r\n]|\\[^\r\n])*")(?: call_id=(?:"[^"\r\n]*"|[^\s>]+))?>/;
const STRAY = ['<assistant>', '</assistant>'];
const MAX_BLOCK = 256 * 1024;
const MAX_LINE = 4096;

const related = (held: string, marker: string) => marker.startsWith(held) || held.startsWith(marker);

export class TextToolCalls {
  private buffer = '';
  private lineStart = true;
  private line = '';
  private fence: { char: string; length: number } | undefined;

  constructor(private readonly text: (delta: string) => void, private readonly call: (name: string, body: string) => boolean) {}

  push(delta: string): void {
    this.buffer += delta;
    this.drain(false);
  }

  /** The text block ended (a tool call, thinking or the end of the turn follows): release what is held. */
  flush(): void {
    this.drain(true);
  }

  private drain(final: boolean): void {
    while (this.buffer) {
      if (this.lineStart && !this.fence) {
        const held = this.held(final);
        if (held === 'wait') return;
        if (held === 'consumed') continue;
      }
      const newline = this.buffer.indexOf('\n');
      const part = newline < 0 ? this.buffer : this.buffer.slice(0, newline + 1);
      this.buffer = this.buffer.slice(part.length);
      this.emit(part);
    }
  }

  /** At a line start: wait for a possible tag, consume a recognized one, or hand the line to plain text. */
  private held(final: boolean): 'wait' | 'consumed' | 'plain' {
    const buffer = this.buffer;
    if (buffer.startsWith(OPEN_PREFIX)) {
      const close = buffer.indexOf(CLOSE);
      if (close < 0) return final || buffer.length > MAX_BLOCK ? 'plain' : 'wait';
      const open = OPEN.exec(buffer);
      const block = buffer.slice(0, close + CLOSE.length);
      let name: unknown;
      try { name = open ? JSON.parse(open[1]!) : undefined; } catch {}
      if (open && typeof name === 'string') {
        const body = buffer.slice(open[0].length, close).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
        if (this.call(name, body)) {
          this.buffer = buffer.slice(block.length).replace(/^[ \t]*\r?\n/, '');
          return 'consumed';
        }
      }
      // Not a call this turn can run: show it as written, then carry on after it.
      this.buffer = buffer.slice(block.length);
      this.emit(block);
      return 'consumed';
    }
    if (OPEN_PREFIX.startsWith(buffer)) return final ? 'plain' : 'wait';
    const newline = buffer.indexOf('\n');
    const line = newline < 0 ? buffer : buffer.slice(0, newline + 1);
    const bare = line.replace(/[ \t]*\r?\n$/, '').trimEnd();
    if (STRAY.includes(bare) && (newline >= 0 || final)) {
      this.buffer = buffer.slice(line.length);
      return 'consumed';
    }
    if (newline < 0 && !final && STRAY.some(marker => related(line, marker))) return 'wait';
    return 'plain';
  }

  private emit(part: string): void {
    if (!part) return;
    this.text(part);
    this.line += part.slice(0, Math.max(0, MAX_LINE - this.line.length));
    this.lineStart = part.endsWith('\n');
    if (this.lineStart) this.endLine();
  }

  private endLine(): void {
    const run = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(this.line);
    if (run) {
      const ticks = run[1]!;
      if (!this.fence) {
        if (ticks[0] !== '`' || !run[2]!.includes('`')) this.fence = { char: ticks[0]!, length: ticks.length };
      } else if (ticks[0] === this.fence.char && ticks.length >= this.fence.length && !run[2]!.trim()) this.fence = undefined;
    }
    this.line = '';
  }
}
