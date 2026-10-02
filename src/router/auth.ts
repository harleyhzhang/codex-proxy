// Only the local Codex client may use the router. It must present the same ChatGPT token that
// Codex itself stores in auth.json; the router never stores, refreshes or logs that token.
import { timingSafeEqual } from 'node:crypto';
import { isRecord } from '../json';

/** After Codex refreshes its token, requests already in flight may still carry the old one. */
const ROTATION_GRACE_MS = 60_000;

type Identity = { token: string; account: string };

export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readIdentity(file: string): Promise<Identity | undefined> {
  const auth: unknown = await Bun.file(file).json();
  if (!isRecord(auth) || auth.auth_mode !== 'chatgpt' || !isRecord(auth.tokens)) return undefined;
  const { access_token: token, account_id: account } = auth.tokens;
  return typeof token === 'string' && typeof account === 'string' ? { token, account } : undefined;
}

export class NativeAuth {
  private current?: Identity;
  private previous?: Identity & { until: number };

  constructor(private readonly file: string) {}

  async accepts(headers: Headers): Promise<boolean> {
    // Native clients send no Origin header; anything that does is a browser page.
    if (headers.has('origin')) return false;
    let identity: Identity | undefined;
    try {
      identity = await readIdentity(this.file);
    } catch {
      return false;
    }
    if (!identity) return false;

    if (this.current && this.current.token !== identity.token) {
      this.previous = { ...this.current, until: Date.now() + ROTATION_GRACE_MS };
    }
    this.current = identity;

    const provided = headers.get('authorization') ?? '';
    const account = headers.get('chatgpt-account-id');
    const matches = (candidate: Identity) =>
      equalSecret(provided, `Bearer ${candidate.token}`) && (!account || equalSecret(account, candidate.account));
    if (matches(identity)) return true;
    return this.previous !== undefined && this.previous.until > Date.now() && matches(this.previous);
  }
}
