// Shrinks an inline image that is too large for a model's per-image limit. A screenshot over the limit
// would otherwise be refused with a 400 on every later turn, since Codex replays the whole history.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../json';
import { logSafe } from '../log';

export type FittedImage = { mediaType: string; data: string } | { omitted: string };

/** Base64 length past which an image is shrunk; Anthropic refuses images whose base64 exceeds 10 MiB. */
export const IMAGE_FIT_BASE64_LIMIT = 5 * 1024 * 1024;
const EDGES = [2576, 1568, 1024];
const cache = new Map<string, FittedImage>();

type Shrinker = (bytes: Uint8Array, edge: number) => Uint8Array | undefined;

/** macOS `sips`: long edge to `edge` pixels, re-encoded as JPEG. Undefined where unavailable. */
const sipsShrink: Shrinker = (bytes, edge) => {
  if (process.platform !== 'darwin') return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'image-fit-'));
  try {
    const input = join(dir, 'in');
    const output = join(dir, 'out.jpg');
    writeFileSync(input, bytes);
    const run = spawnSync('/usr/bin/sips', ['-Z', String(edge), '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', input, '--out', output], { stdio: 'ignore', timeout: 20_000 });
    return run.status === 0 ? readFileSync(output) : undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** The image unchanged when within `limit`, else a smaller JPEG, else a note saying it was left out. */
export function fitImage(mediaType: string, data: string, limit = IMAGE_FIT_BASE64_LIMIT, shrink: Shrinker = sipsShrink): FittedImage {
  if (data.length <= limit) return { mediaType, data };
  const key = `${limit}:${sha256(data)}`;
  const known = cache.get(key);
  if (known) return known;
  const bytes = Buffer.from(data, 'base64');
  let fitted: FittedImage = { omitted: `[image omitted: ${(bytes.length / 1048576).toFixed(1)} MB is over the model's image size limit and could not be shrunk]` };
  for (const edge of EDGES) {
    const smaller = shrink(bytes, edge);
    if (!smaller) break;
    const encoded = Buffer.from(smaller).toString('base64');
    if (encoded.length <= limit) { fitted = { mediaType: 'image/jpeg', data: encoded }; break; }
  }
  logSafe('image_fit', { before: data.length, after: 'data' in fitted ? fitted.data.length : 0 });
  cache.set(key, fitted);
  while (cache.size > 64) cache.delete(cache.keys().next().value!);
  return fitted;
}
