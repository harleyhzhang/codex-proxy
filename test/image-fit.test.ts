import { expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { claudeMessages } from '../src/backends/claude';
import { fitImage, IMAGE_FIT_BASE64_LIMIT } from '../src/protocol/image-fit';
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

test('an image within the limit passes through untouched', () => {
  expect(fitImage('image/png', 'AAAA')).toEqual({ mediaType: 'image/png', data: 'AAAA' });
});

test('an oversized image is shrunk to the first size that fits, or left out with a note', () => {
  const data = 'A'.repeat(400);
  const edges: number[] = [];
  const fitted = fitImage('image/png', data, 100, (_bytes, edge) => { edges.push(edge); return new Uint8Array(edge === 1568 ? 60 : 300); });
  expect(edges).toEqual([2576, 1568]);
  expect(fitted).toMatchObject({ mediaType: 'image/jpeg' });
  expect('data' in fitted && fitted.data.length <= 100).toBe(true);
  expect(fitImage('image/png', 'B'.repeat(400), 100, () => undefined)).toMatchObject({ omitted: expect.stringContaining('image omitted') });
});

test.if(process.platform === 'darwin')('sips really shrinks a large PNG to a JPEG Claude accepts', () => {
  const data = png(3200, 2400).toString('base64');
  const fitted = fitImage('image/png', data, data.length - 1);
  expect(fitted).toMatchObject({ mediaType: 'image/jpeg' });
  const bytes = Buffer.from('data' in fitted ? fitted.data : '', 'base64');
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  expect(bytes.length).toBeLessThan(Buffer.from(data, 'base64').length);
});

test('Claude history carries a fitted image instead of an oversized one', () => {
  const huge = 'A'.repeat(IMAGE_FIT_BASE64_LIMIT + 4);
  const turns = claudeMessages({ model: 'claude-opus-5-5', input: [
    { role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${huge}` }] },
  ] } as ResponsesRequest, name => name);
  const block = turns[0]!.content[0]!;
  // Not decodable as an image, so it cannot shrink: it becomes a note rather than a request Anthropic refuses.
  expect(block).toMatchObject({ type: 'text', text: expect.stringContaining('image omitted') });
});
