/** Browser completion is a client directive, recognized only as standalone commentary. Local
 * providers have one text stream, so recover that boundary before any text reaches the client.
 * Buffer only a possible directive (up to 4 KiB); ordinary prose keeps streaming immediately. */
export type AssistantTextPart = { text: string; phase?: 'commentary' };
const PREFIX = '::browser-complete{';
const MAX_LINE = 4096;

function isCompletion(line: string): boolean {
  const match = /^::browser-complete\{title=("(?:[^"\\\r\n]|\\[^\r\n])*")\}[ \t]*(?:\r?\n)?$/.exec(line);
  if (!match) return false;
  try { return Boolean((JSON.parse(match[1]!) as string).trim()); } catch { return false; }
}

export class AssistantText {
  private held = '';
  private prefix = '';
  private plain = false;
  private fence: { char: string; length: number } | undefined;

  constructor(private readonly emit: (part: AssistantTextPart) => void) {}

  push(delta: string): void {
    let offset = 0;
    while (offset < delta.length) {
      const newline = delta.indexOf('\n', offset);
      const end = newline < 0 ? delta.length : newline + 1;
      const part = delta.slice(offset, end);
      this.prefix += part.slice(0, Math.max(0, MAX_LINE - this.prefix.length));
      if (this.plain) this.emit({ text: part });
      else {
        this.held += part;
        const candidate = !this.fence && this.held.length <= MAX_LINE &&
          (PREFIX.startsWith(this.held) || this.held.startsWith(PREFIX));
        if (!candidate) {
          this.emit({ text: this.held });
          this.held = '';
          this.plain = true;
        } else if (newline >= 0) this.release();
      }
      if (newline >= 0) this.endLine();
      offset = end;
    }
  }

  /** A tool, reasoning block or end of response terminates the current text message. */
  flush(): void {
    this.release();
    this.endLine();
  }

  private release(): void {
    if (this.held) this.emit({ text: this.held, ...(isCompletion(this.held) ? { phase: 'commentary' as const } : {}) });
    this.held = '';
  }

  private endLine(): void {
    const run = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(this.prefix);
    if (run) {
      const ticks = run[1]!;
      if (!this.fence) {
        if (ticks[0] !== '`' || !run[2]!.includes('`')) this.fence = { char: ticks[0]!, length: ticks.length };
      } else if (ticks[0] === this.fence.char && ticks.length >= this.fence.length && !run[2]!.trim()) this.fence = undefined;
    }
    this.prefix = '';
    this.plain = false;
  }
}

export function assistantText(text: string): AssistantTextPart[] {
  const parts: AssistantTextPart[] = [];
  const parser = new AssistantText(part => {
    const last = parts.at(-1);
    if (last && !last.phase && !part.phase) last.text += part.text;
    else parts.push(part);
  });
  parser.push(text);
  parser.flush();
  return parts;
}
