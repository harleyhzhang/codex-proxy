// Bounded asynchronous image conversion; a large screenshot must not block other chats.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../json';
import { logSafe } from '../log';
import { positiveInt } from '../env';
import { abortable } from '../transport';
import { Admission } from '../backends/admission';

export type FittedImage = { mediaType: string; data: string } | { omitted: string };
export const IMAGE_FIT_BASE64_LIMIT = 5 * 1024 * 1024;
// Above 20 images Claude limits every image in the replay, including tool results, to 3000px.
// Apply that ceiling from the first turn so a growing chat cannot invalidate an earlier screenshot.
export const IMAGE_FIT_MAX_EDGE = 3000;
const EDGES = [2576, 1568, 1024];
const cache = new Map<string, { value: FittedImage; bytes: number }>();
let cacheBytes = 0;
const conversions = new Admission('Image conversion', 2, 64);
type Shrinker = (bytes: Uint8Array, edge: number, signal?: AbortSignal) => Uint8Array | undefined | Promise<Uint8Array | undefined>;
type Job = { promise: Promise<FittedImage>; controller: AbortController; users: number; done: boolean };
const jobs = new Map<string, Job>();
const codecIds = new WeakMap<Shrinker, number>();
let nextCodec = 0;

/** Read dimensions without a codec process. JPEG metadata can precede its frame header. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.toString('ascii', 12, 16) === 'IHDR') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X' && b.length >= 30) return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    if (kind === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset < b.length && b[offset] === 0xff) {
    while (offset < b.length && b[offset] === 0xff) offset++;
    const marker = b[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > b.length) break;
    const length = b.readUInt16BE(offset);
    if (length < 2 || offset + length > b.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 7) {
      return { width: b.readUInt16BE(offset + 5), height: b.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return undefined;
}

const sipsShrink: Shrinker = async (bytes, edge, signal) => {
  if (process.platform !== 'darwin') return undefined;
  signal?.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), 'image-fit-'));
  try {
    const input = join(dir, 'in'), output = join(dir, 'out.jpg');
    await writeFile(input, bytes, { signal });
    signal?.throwIfAborted();
    const child = Bun.spawn(['/usr/bin/sips', '-Z', String(edge), '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', input, '--out', output], { stdout: 'ignore', stderr: 'ignore' });
    const kill = () => { try { child.kill(); } catch {} };
    signal?.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, 20_000);
    try { const code = await child.exited; signal?.throwIfAborted(); return code === 0 ? await readFile(output) : undefined; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', kill); }
  } catch (error) { signal?.throwIfAborted(); return undefined; }
  finally { await rm(dir, { recursive: true, force: true }); }
};

/** Concurrent callers share a conversion; cancelling the last waiter also kills its codec process. */
export async function fitImage(mediaType: string, data: string, limit = IMAGE_FIT_BASE64_LIMIT, shrink: Shrinker = sipsShrink, signal?: AbortSignal): Promise<FittedImage> {
  signal?.throwIfAborted();
  // PNG/GIF/WebP dimensions fit in this tiny prefix; only JPEG may need a metadata scan.
  const header = Buffer.from(data.slice(0, 44), 'base64');
  const dimensions = imageDimensions(header[0] === 0xff && header[1] === 0xd8 ? Buffer.from(data, 'base64') : header);
  const tooWide = dimensions !== undefined && Math.max(dimensions.width, dimensions.height) > IMAGE_FIT_MAX_EDGE;
  if (data.length <= limit && !tooWide) return { mediaType, data };
  if (!codecIds.has(shrink)) codecIds.set(shrink, ++nextCodec);
  const key = `${codecIds.get(shrink)}:${mediaType}:${limit}:${sha256(data)}`;
  const known = cache.get(key);
  if (known) { cache.delete(key); cache.set(key, known); return known.value; }
  let job = jobs.get(key);
  if (job?.controller.signal.aborted) { jobs.delete(key); job = undefined; }
  if (!job) {
    const controller = new AbortController();
    const current: Job = { controller, users: 0, done: false, promise: Promise.resolve({ omitted: '' }) };
    current.promise = (async () => {
      const release = await conversions.acquire(controller.signal);
      try {
        const bytes = Buffer.from(data, 'base64');
        const reason = tooWide ? `${dimensions!.width}x${dimensions!.height} exceeds the model's ${IMAGE_FIT_MAX_EDGE}px image dimension limit` : `${(bytes.length / 1048576).toFixed(1)} MB is over the model's image size limit`;
        let fitted: FittedImage = { omitted: `[image omitted: ${reason} and could not be shrunk]` };
        for (const edge of EDGES) {
          controller.signal.throwIfAborted();
          const smaller = await shrink(bytes, edge, controller.signal);
          controller.signal.throwIfAborted();
          if (!smaller) break;
          const size = imageDimensions(smaller);
          if (size && Math.max(size.width, size.height) > IMAGE_FIT_MAX_EDGE) continue;
          const encoded = Buffer.from(smaller).toString('base64');
          if (encoded.length <= limit) { fitted = { mediaType: 'image/jpeg', data: encoded }; break; }
        }
        const size = ('data' in fitted ? fitted.data.length : fitted.omitted.length) + 256;
        const maxBytes = positiveInt('IMAGE_CACHE_BYTES', 64 * 1024 * 1024);
        if (size <= maxBytes) { cache.set(key, { value: fitted, bytes: size }); cacheBytes += size; }
        while (cache.size > 64 || cacheBytes > maxBytes) { const oldest = cache.keys().next().value!; cacheBytes -= cache.get(oldest)!.bytes; cache.delete(oldest); }
        logSafe('image_fit', { before: data.length, after: 'data' in fitted ? fitted.data.length : 0, cache_bytes: cacheBytes });
        return fitted;
      } finally { release(); }
    })().finally(() => { current.done = true; if (jobs.get(key) === current) jobs.delete(key); });
    jobs.set(key, current); job = current;
  }
  job.users++;
  try { return await abortable(job.promise, signal); }
  finally { if (--job.users === 0 && !job.done) job.controller.abort(); }
}
