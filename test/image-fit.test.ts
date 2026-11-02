import { expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { claudeMessages } from '../src/backends/claude';
import { fitImage, imageDimensions, IMAGE_FIT_BASE64_LIMIT, IMAGE_FIT_MAX_EDGE } from '../src/protocol/image-fit';
import type { ResponsesRequest } from '../src/protocol/types';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4);
  return out;
}
/** A width×height RGB gradient PNG. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([x % 256, y % 256, (x * y) % 256], y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('an image within the limit passes through untouched', async () => {
  expect(await fitImage('image/png', 'AAAA')).toEqual({ mediaType: 'image/png', data: 'AAAA' });
});

test('dimensions cover PNG, GIF, JPEG metadata/progressive frames and every WebP encoding', async () => {
  const gif = Buffer.alloc(10); gif.write('GIF89a'); gif.writeUInt16LE(3200, 6); gif.writeUInt16LE(24, 8);
  const webp = (kind: string) => { const b = Buffer.alloc(30); b.write('RIFF'); b.write('WEBP', 8); b.write(kind, 12); return b; };
  const extended = webp('VP8X'); extended.writeUIntLE(3199, 24, 3); extended.writeUIntLE(23, 27, 3);
  const lossless = webp('VP8L'); lossless[20] = 0x2f; lossless.writeUInt32LE(3199 | (23 << 14), 21);
  const lossy = webp('VP8 '); lossy.set([0x9d, 1, 0x2a], 23); lossy.writeUInt16LE(3200, 26); lossy.writeUInt16LE(24, 28);
  // Metadata longer than the fixed prefix, a fill byte and a standalone marker before SOF.
  const metadata = Buffer.alloc(100); metadata.set([0xff, 0xe1, 0, 98]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), metadata, Buffer.from([0xff, 0x01, 0xff, 0xff, 0xc2, 0, 7, 8, 0, 24, 0x0c, 0x80])]);
  for (const bytes of [png(3200, 24), gif, extended, lossless, lossy, jpeg]) {
    expect(imageDimensions(bytes)).toEqual({ width: 3200, height: 24 });
    let calls = 0;
    await fitImage('image/fixture', bytes.toString('base64'), undefined, () => { calls++; return png(24, 1); });
    expect(calls).toBe(1);
    for (let end = 0; end < Math.min(bytes.length, 32); end++) expect(() => imageDimensions(bytes.subarray(0, end))).not.toThrow();
  }
});

test('small compressed images above 3000 pixels still need fitting on either axis', async () => {
  for (const [width, height] of [[3001, 1], [1, 3001]]) {
    const data = png(width!, height!).toString('base64');
    expect(data.length).toBeLessThan(IMAGE_FIT_BASE64_LIMIT);
    const edges: number[] = [];
    const fitted = await fitImage('image/png', data, undefined, (_bytes, edge) => {
      edges.push(edge);
      return png(100, 1);
    });
    expect(edges).toEqual([2576]);
    expect(fitted).toMatchObject({ mediaType: 'image/jpeg' });
    expect(await fitImage('image/png', data, undefined, () => undefined)).toMatchObject({ omitted: expect.stringContaining('3000') });
  }
  const boundary = png(3000, 1).toString('base64');
  expect(await fitImage('image/png', boundary)).toEqual({ mediaType: 'image/png', data: boundary });
});

test.if(process.platform === 'darwin')('many-image history fits wide user images and tall tool screenshots below the byte cap', async () => {
  const wide = png(3200, 24).toString('base64'), tall = png(24, 3200).toString('base64');
  expect(Math.max(wide.length, tall.length)).toBeLessThan(IMAGE_FIT_BASE64_LIMIT);
  const turns = await claudeMessages({ model: 'claude-opus-5-5', input: [
    { role: 'user', content: Array.from({ length: 20 }, () => ({ type: 'input_image', image_url: `data:image/png;base64,${wide}` })) },
    { type: 'function_call', call_id: 'screenshot', name: 'view_image', arguments: '{}' },
    { type: 'function_call_output', call_id: 'screenshot', output: [{ type: 'image', image_url: `data:image/png;base64,${tall}` }] },
  ] } as ResponsesRequest, name => name);
  const images = turns[0]!.content;
  expect(images).toHaveLength(20);
  const result = turns[2]!.content[0]!.content as { type: string; source: { media_type: string; data: string } }[];
  expect(result).toHaveLength(1);
  for (const block of [...images, ...result]) {
    expect(block).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg' } });
    const source = block.source as { data: string };
    expect([wide, tall]).not.toContain(source.data);
    const size = imageDimensions(Buffer.from(source.data, 'base64'))!;
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(IMAGE_FIT_MAX_EDGE);
  }
});

test('a codec result must satisfy both byte and dimension limits, and fitted conversions are cached', async () => {
  const data = png(3200, 1).toString('base64');
  const edges: number[] = [];
  const shrink = (_bytes: Uint8Array, edge: number) => { edges.push(edge); return png(edge === 2576 ? 3001 : 1568, 1); };
  const fitted = await fitImage('image/png', data, undefined, shrink);
  expect(edges).toEqual([2576, 1568]);
  expect(await fitImage('image/png', data, undefined, shrink)).toEqual(fitted);
  expect(edges).toEqual([2576, 1568]);
});

test('an oversized image is shrunk to the first size that fits, or left out with a note', async () => {
  const data = 'A'.repeat(400);
  const edges: number[] = [];
  const fitted = await fitImage('image/png', data, 100, (_bytes, edge) => { edges.push(edge); return new Uint8Array(edge === 1568 ? 60 : 300); });
  expect(edges).toEqual([2576, 1568]);
  expect(fitted).toMatchObject({ mediaType: 'image/jpeg' });
  expect('data' in fitted && fitted.data.length <= 100).toBe(true);
  expect(await fitImage('image/png', 'B'.repeat(400), 100, () => undefined)).toMatchObject({ omitted: expect.stringContaining('image omitted') });
});

test.if(process.platform === 'darwin')('sips really shrinks a large PNG to a JPEG Claude accepts', async () => {
  const data = png(3200, 2400).toString('base64');
  const fitted = await fitImage('image/png', data, data.length - 1);
  expect(fitted).toMatchObject({ mediaType: 'image/jpeg' });
  const bytes = Buffer.from('data' in fitted ? fitted.data : '', 'base64');
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  expect(bytes.length).toBeLessThan(Buffer.from(data, 'base64').length);
});

test('Claude history carries a fitted image instead of an oversized one', async () => {
  const huge = 'A'.repeat(IMAGE_FIT_BASE64_LIMIT + 4);
  const turns = await claudeMessages({ model: 'claude-opus-5-5', input: [
    { role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${huge}` }] },
  ] } as ResponsesRequest, name => name);
  const block = turns[0]!.content[0]!;
  // Not decodable as an image, so it cannot shrink: it becomes a note rather than a request Anthropic refuses.
  expect(block).toMatchObject({ type: 'text', text: expect.stringContaining('image omitted') });
});
