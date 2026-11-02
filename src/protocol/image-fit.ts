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
const EDGES = [2576, 1568, 1024];
const cache = new Map<string, { value: FittedImage; bytes: number }>();
let cacheBytes = 0;
const conversions = new Admission('Image conversion', 2, 64);
type Shrinker = (bytes: Uint8Array, edge: number, signal?: AbortSignal) => Uint8Array | undefined | Promise<Uint8Array | undefined>;
type Job = { promise: Promise<FittedImage>; controller: AbortController; users: number; done: boolean };
const jobs = new Map<string, Job>();
const codecIds = new WeakMap<Shrinker, number>();
let nextCodec = 0;

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
  if (data.length <= limit) return { mediaType, data };
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
        let fitted: FittedImage = { omitted: `[image omitted: ${(bytes.length / 1048576).toFixed(1)} MB is over the model's image size limit and could not be shrunk]` };
        for (const edge of EDGES) {
          controller.signal.throwIfAborted();
          const smaller = await shrink(bytes, edge, controller.signal);
          controller.signal.throwIfAborted();
          if (!smaller) break;
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
