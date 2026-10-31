// Runs before every test file. Backends read their login locations when the registry loads, so the
// default Grok backend must never see a real login on the developer's machine.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.GROK_HOME = mkdtempSync(join(tmpdir(), 'grok-home-'));
