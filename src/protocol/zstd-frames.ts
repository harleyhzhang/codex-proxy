/** Validate framing without decoding or buffering blocks. Besides catching truncation/trailing
 * data (some Bun zlib versions ignore it), reject oversized advertised windows before the
 * native decoder allocates one. Unknown-size and concatenated frames remain supported. */
export class ZstdFrames {
  private phase: 'magic' | 'descriptor' | 'header' | 'block' | 'checksum' | 'skip-size' = 'magic';
  private pending: number[] = [];
  private want = 4;
  private skip = 0;
  private descriptor = 0;
  private last = false;
  private skippingFrame = false;
  private frames = 0;
  constructor(private readonly limit: number) {}
  feed(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.skip) {
        const size = Math.min(this.skip, bytes.length - offset); offset += size; this.skip -= size;
        if (!this.skip) this.afterPayload();
        continue;
      }
      const size = Math.min(this.want - this.pending.length, bytes.length - offset);
      for (let i = 0; i < size; i++) this.pending.push(bytes[offset++]!);
      if (this.pending.length === this.want) { const data = Buffer.from(this.pending); this.pending = []; this.header(data); }
    }
  }
  finish(): void {
    if (!this.frames || this.skip || this.pending.length || this.phase !== 'magic') throw new Error('Invalid Zstd framing');
  }
  private next(phase: typeof this.phase, want: number): void { this.phase = phase; this.want = want; }
  private complete(): void { this.frames++; this.next('magic', 4); }
  private afterPayload(): void {
    if (this.skippingFrame) { this.skippingFrame = false; this.complete(); }
    else if (!this.last) this.next('block', 3);
    else if (this.descriptor & 4) this.next('checksum', 4);
    else this.complete();
  }
  private header(data: Buffer): void {
    switch (this.phase) {
      case 'magic': {
        const magic = data.readUInt32LE();
        if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) { this.next('skip-size', 4); return; }
        if (magic !== 0xfd2fb528) throw new Error('Invalid Zstd framing');
        this.next('descriptor', 1); return;
      }
      case 'descriptor': {
        this.descriptor = data[0]!;
        if (this.descriptor & 0x18) throw new Error('Invalid Zstd framing');
        const single = Boolean(this.descriptor & 32), sizeFlag = this.descriptor >> 6;
        const contentBytes = sizeFlag === 0 ? Number(single) : 1 << sizeFlag;
        const dictFlag = this.descriptor & 3, dictBytes = dictFlag === 3 ? 4 : dictFlag;
        this.next('header', Number(!single) + dictBytes + contentBytes); return;
      }
      case 'header': {
        const single = Boolean(this.descriptor & 32), sizeFlag = this.descriptor >> 6;
        if (!single) {
          const window = data[0]!, base = 2 ** (10 + (window >> 3));
          if (base + base / 8 * (window & 7) > 128 * 1024 * 1024) throw new Error('Zstd window too large');
        }
        const contentBytes = sizeFlag === 0 ? Number(single) : 1 << sizeFlag;
        if (contentBytes) {
          let size = 0n;
          for (const byte of data.subarray(data.length - contentBytes).reverse()) size = size * 256n + BigInt(byte);
          if (sizeFlag === 1) size += 256n;
          if (size > BigInt(this.limit)) throw new Error('Request too large');
        }
        this.next('block', 3); return;
      }
      case 'block': {
        const header = data.readUIntLE(0, 3), type = header >> 1 & 3, size = header >>> 3;
        if (type === 3 || size > 128 * 1024) throw new Error('Invalid Zstd framing');
        this.last = Boolean(header & 1); this.skip = type === 1 ? 1 : size;
        if (!this.skip) this.afterPayload();
        return;
      }
      case 'checksum': this.complete(); return;
      case 'skip-size':
        this.skip = data.readUInt32LE(); this.skippingFrame = true;
        if (!this.skip) this.afterPayload();
    }
  }
}
