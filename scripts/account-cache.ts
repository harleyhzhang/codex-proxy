// Refresh the isolated native model cache without generating model output or printing credentials.
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { accountModels, nativeAccountRequest } from '../src/router/account-upstream';

const config = loadConfig();
const account = config.secondaryAccount;
if (!account) throw new Error('Set ACCOUNT_CODEX_HOME to an isolated signed-in Codex profile');
await nativeAccountRequest(account, 'model/list', { includeHidden: true, limit: 200 });
const cache: unknown = await Bun.file(join(account.home, 'models_cache.json')).json();
const models = accountModels(cache, account.models);
if (!models.length) throw new Error('Native Codex did not cache any selected available GPT models');
console.log(`Secondary native model cache refreshed (${models.length} available models). Run bun run catalog next.`);
