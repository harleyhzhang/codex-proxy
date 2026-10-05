// A second native Codex login, isolated from the desktop login. Only explicitly namespaced
// GPT models use it. Codex itself owns refresh-token rotation; this router never logs tokens.
import { join } from 'node:path';
import { BackendError } from '../backends/contract';
import type { UpstreamFetch } from './upstream';
import { logSafe } from '../log';
import { isRecord, type JsonRecord } from '../json';

export type AccountOptions = {
  home: string;
  prefix: string;
  binary: string;
  expectedEmail?: string;
  expectedAccountId?: string;
  models?: readonly string[];
  fastest?: boolean;
  refresh?: () => Promise<void>;
};

const record = isRecord;
const MODEL_SLUG = /^gpt-[a-z0-9][a-z0-9.-]*$/;

export function validateAccountPrefix(prefix: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(prefix) || ['gpt', 'claude', 'grok', 'opus', 'sonnet', 'haiku'].includes(prefix)) {
    throw new Error('Secondary model prefix must be a distinct lowercase namespace');
  }
}

/** The secondary profile's available GPT rows, optionally restricted by operator choice. */
export function accountModels(cache: unknown, models?: readonly string[]): JsonRecord[] {
  if (!record(cache) || !Array.isArray(cache.models)) return [];
  return cache.models.filter(record).filter(row => typeof row.slug === 'string' && MODEL_SLUG.test(row.slug)
    && row.visibility === 'list' && (!models || models.includes(row.slug)));
}

function claims(token: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    return record(value) ? value : {};
  } catch { return {}; }
}

export function accountModel(model: unknown, prefix: string, models?: readonly string[]): string | undefined {
  if (typeof model !== 'string' || !model.startsWith(prefix + '-')) return undefined;
  const native = model.slice(prefix.length + 1);
  if (!MODEL_SLUG.test(native) || (models && !models.includes(native))) throw new BackendError('Unsupported secondary Codex model');
  return native;
}

/** Can be enabled independently of secondary-account routing. Native tool endpoints are untouched. */
export function standardPrimaryFetch(upstream: UpstreamFetch): UpstreamFetch {
  return async (url, init) => {
    const target = new URL(url);
    if (target.origin !== 'https://chatgpt.com' || !/^\/backend-api\/codex\/responses(?:\/|$)/.test(target.pathname) || typeof init.body !== 'string') return upstream(url, init);
    let body: unknown; try { body = JSON.parse(init.body); } catch { return upstream(url, init); }
    if (!record(body) || typeof body.model !== 'string' || !MODEL_SLUG.test(body.model)) return upstream(url, init);
    logSafe('account-speed', { account: 'primary', model: body.model, tier: 'default' });
    const headers = new Headers(init.headers); headers.delete('content-length');
    return upstream(url, { ...init, headers, body: JSON.stringify({ ...body, service_tier: 'default' }) });
  };
}

/** Perform an account-only native request; never starts a thread or a model generation. */
export async function nativeAccountRequest(options: AccountOptions, method: 'account/read' | 'model/list', params: JsonRecord): Promise<unknown> {
  const child = Bun.spawn([options.binary, 'app-server', '--stdio', '-c', 'cli_auth_credentials_store="file"'], {
    env: { ...process.env, CODEX_HOME: options.home }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const timer = setTimeout(() => child.kill(), 45_000);
  const send = (value: unknown) => { child.stdin.write(JSON.stringify(value) + '\n'); child.stdin.flush(); };
  let buffer = '', initialized = false;
  try {
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'secondary-codex-auth', version: '1' } } });
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        let result: unknown; try { result = JSON.parse(line); } catch { continue; }
        if (!record(result)) continue;
        if (result.id === 1) {
          if (result.error) throw new Error('Native initialization failed');
          initialized = true;
          send({ method: 'initialized' });
          send({ id: 2, method, params });
        }
        if (initialized && result.id === 2) {
          if (result.error) throw new Error('Native refresh failed');
          return result.result;
        }
      }
      if (buffer.length > 1_000_000) throw new Error('Native response exceeded limit');
    }
    throw new Error('Native refresh closed');
  } finally {
    clearTimeout(timer); child.stdin.end(); child.kill(); await child.exited; reader.releaseLock();
  }
}

/** Native Codex owns refresh-token rotation and its credential-file persistence. */
export async function refreshAccount(options: AccountOptions): Promise<void> {
  await nativeAccountRequest(options, 'account/read', { refreshToken: true });
}

type Identity = { token: string; account: string; expires: number };

export class AccountUpstream {
  private refreshing?: Promise<void>;
  constructor(private options: AccountOptions, private upstream: UpstreamFetch) {
    validateAccountPrefix(options.prefix);
  }
  private async identity(): Promise<Identity> {
    const auth: unknown = await Bun.file(join(this.options.home, 'auth.json')).json();
    if (!record(auth) || auth.auth_mode !== 'chatgpt' || !record(auth.tokens)) throw new Error('Missing secondary login');
    const { access_token: token, id_token: idToken, account_id: account } = auth.tokens;
    if (typeof token !== 'string' || typeof idToken !== 'string' || typeof account !== 'string') throw new Error('Invalid secondary login');
    if (this.options.expectedEmail && claims(idToken).email !== this.options.expectedEmail) throw new Error('Wrong secondary identity');
    if (this.options.expectedAccountId && account !== this.options.expectedAccountId) throw new Error('Wrong secondary workspace');
    const expires = claims(token).exp;
    if (typeof expires !== 'number') throw new Error('Invalid secondary token expiry');
    return { token, account, expires };
  }
  private async ready(): Promise<Identity> {
    let identity = await this.identity();
    if (identity.expires <= Date.now() / 1000 + 300) {
      this.refreshing ??= (this.options.refresh ?? (() => refreshAccount(this.options)))().finally(() => { this.refreshing = undefined; });
      await this.refreshing;
      identity = await this.identity();
      if (identity.expires <= Date.now() / 1000 + 30) throw new Error('Secondary refresh did not renew access');
    }
    return identity;
  }
  fetch: UpstreamFetch = async (url, init) => {
    let body: unknown;
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch {} }
    if (!record(body)) return this.upstream(url, init);
    const native = accountModel(body.model, this.options.prefix, this.options.models);
    if (!native) {
      return this.upstream(url, init);
    }
    // The credentials must never be forwarded to any destination other than Codex's backend.
    const target = new URL(url);
    if (target.origin !== 'https://chatgpt.com' || !target.pathname.startsWith('/backend-api/codex/')) {
      throw new BackendError('Secondary credentials require the native Codex backend');
    }
    let identity: Identity;
    try { identity = await this.ready(); }
    catch { throw new BackendError('Secondary Codex login unavailable; sign in again to its isolated profile. Primary account was not used.'); }
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${identity.token}`);
    headers.set('chatgpt-account-id', identity.account);
    headers.delete('content-length');
    let row: JsonRecord | undefined;
    try {
      const cache: unknown = await Bun.file(join(this.options.home, 'models_cache.json')).json();
      row = accountModels(cache, this.options.models).find(value => value.slug === native);
    } catch { throw new BackendError('Secondary model cache unavailable; refresh its native model catalog'); }
    if (!row) throw new BackendError('Unsupported secondary Codex model; refresh its native model catalog');
    let tier = body.service_tier;
    if (this.options.fastest) {
      const tiers = Array.isArray(row.service_tiers) ? row.service_tiers.filter(record).map(value => value.id) : [];
      tier = tiers.includes('ultrafast') ? 'ultrafast' : tiers.includes('priority') ? 'priority' : 'default';
    }
    logSafe('account-speed', { account: this.options.prefix, model: native, tier });
    return this.upstream(url, { ...init, headers, body: JSON.stringify({ ...body, model: native, ...(tier === undefined ? {} : { service_tier: tier }) }) });
  };
}
