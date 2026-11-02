// `bun run update`: pull the latest code, install dependencies, rebuild the model catalog with the
// running service's own settings, restart the router and confirm it answers. Safe to run again.
import { $ } from 'bun';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { isRecord } from '../src/json';

const root = resolve(import.meta.dir, '..');
const entry = join(root, 'src', 'main.ts');
$.cwd(root);
$.throws(false);

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/** The launchd agent that runs this checkout, with the environment it gives the router. */
type Service = { label: string; env: Record<string, string> };
async function findService(): Promise<Service | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.plist'))) {
    const converted = await $`plutil -convert json -o - ${join(dir, name)}`.quiet();
    if (converted.exitCode !== 0) continue;
    let plist: unknown;
    try { plist = JSON.parse(converted.stdout.toString()); } catch { continue; }
    if (!isRecord(plist) || typeof plist.Label !== 'string' || !Array.isArray(plist.ProgramArguments)) continue;
    if (!plist.ProgramArguments.some((arg) => typeof arg === 'string' && resolve(arg) === entry)) continue;
    const env: Record<string, string> = {};
    if (isRecord(plist.EnvironmentVariables)) {
      for (const [key, value] of Object.entries(plist.EnvironmentVariables)) if (typeof value === 'string') env[key] = value;
    }
    return { label: plist.Label, env };
  }
  return undefined;
}

const before = (await $`git rev-parse --short HEAD`.quiet()).stdout.toString().trim();
console.log('→ Pulling the latest code');
const pulled = await $`git pull --ff-only`;
if (pulled.exitCode !== 0) {
  fail('git pull failed. If you changed files here, run `git stash` (or commit them) and run `bun run update` again.');
}
const after = (await $`git rev-parse --short HEAD`.quiet()).stdout.toString().trim();
console.log(before === after ? `  already up to date (${after})` : `  ${before} → ${after}`);

console.log('→ Installing dependencies');
if ((await $`bun install --frozen-lockfile`).exitCode !== 0) fail('bun install failed; see the output above.');

const service = await findService();
const env = { ...process.env, ...service?.env };
const port = Number(env.PORT ?? 3468);

console.log('→ Rebuilding the model catalog');
const catalogFile = env.CATALOG_FILE ?? join(env.PROXY_STATE_DIR ?? join(homedir(), '.codex-subscription-proxy'), 'models.json');
const oldCatalog = existsSync(catalogFile) ? await Bun.file(catalogFile).text() : '';
if ((await $`bun run catalog`.env(env)).exitCode !== 0) fail('Building the model catalog failed; see the output above.');
const catalogChanged = oldCatalog !== (existsSync(catalogFile) ? await Bun.file(catalogFile).text() : '');

if (service) {
  console.log(`→ Restarting ${service.label}`);
  const uid = userInfo().uid;
  if ((await $`launchctl kickstart -k gui/${uid}/${service.label}`).exitCode !== 0) {
    fail(`Could not restart ${service.label}. Try: launchctl kickstart -k gui/${uid}/${service.label}`);
  }
  let healthy = false;
  for (let i = 0; i < 40 && !healthy; i++) {
    await Bun.sleep(500);
    healthy = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);
  }
  if (!healthy) fail(`The router did not come back on port ${port}. Check its log (the StandardErrorPath in its plist).`);
  console.log(`\n✓ Updated to ${after} and running on port ${port}.`);
} else {
  console.log(`\n✓ Updated to ${after}. No launchd service runs ${entry}, so restart the router yourself`);
  console.log('  (stop `bun start` and run it again). New code only takes effect after a restart.');
}
if (catalogChanged) console.log('  The model list changed: quit and reopen Codex to see it.');
console.log('  Existing chats keep working; nothing in Codex needs to change.');
