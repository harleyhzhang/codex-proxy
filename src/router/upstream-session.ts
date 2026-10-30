// Opt-in native GPT WebSocket transport. Account/speed wrappers still own all request policy.
import { isRecord, type JsonRecord } from '../json';
import { logSafe } from '../log';
import { responseObject, streamResponse } from '../protocol/output';
import { EMPTY_OUTPUT } from '../protocol/types';
import { ProxyTransportError } from '../transport';
import { requestJson } from './json-request';
import { UpstreamStatusError, type UpstreamFetch } from './upstream';

type SocketFactory = (url: string, headers: Headers) => WebSocket;
export type UpstreamSessionOptions = {
  /** Raw HTTP transport, called only after account/speed policy has already been applied. */
  fallback: UpstreamFetch;
  enabled?: boolean;
  socket?: SocketFactory;
  connectTimeoutMs?: number;
  maxLifetimeMs?: number;
  maxProvisionalBytes?: number;
  maxProvisionalMs?: number;
  now?: () => number;
};
type Last = { id: string; prefix: unknown[] };
type Connection = { socket: WebSocket; scope: string; model: string; openedAt: number; ready: Promise<void> };
type Active = {
  id: number; started: number; connectedMs: number; reused: boolean;
  request: JsonRecord; continued: boolean; replayed: boolean; meaningful: boolean; firstOutputMs?: number;
  output: unknown[]; out: ReadableStreamDefaultController<Uint8Array>;
  signal?: AbortSignal; abort: () => void;
  provisional: Uint8Array[]; provisionalBytes: number; published: boolean; deferMetadata: boolean;
  provisionalTimer?: ReturnType<typeof setTimeout>;
  response?: Response; headersSettled: boolean; resolveHeaders: (response: Response) => void; rejectHeaders: (error: unknown) => void;
  terminal?: string;
  firstEventMs?: number; sentBytes: number; sentItems: number;
};
const UNSUPPORTED = new Set([404, 405, 426, 501]);
const TERMINAL = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);
// Only native error metadata survives rebuilding a WebSocket error as a JSON HTTP response.
// Encoding, framing, and hop-by-hop headers describe a different transport/body and must not.
const ERROR_HEADER = /^(?:retry-after|x-codex-[a-z0-9-]+|x-ratelimit-[a-z0-9-]+|x-request-id|x-oai-request-id|x-openai-authorization-error|x-error-json|cf-ray)$/i;
const encoder = new TextEncoder();
let nextRequest = 0;

/** JSON equality without serializing large image/tool strings again or depending on key order. */
function sameJson(left: unknown, right: unknown): boolean {
  const pending: [unknown, unknown][] = [[left, right]];
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (a === b) continue;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) pending.push([a[i], b[i]]);
    } else if (isRecord(a) && isRecord(b)) {
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      for (const key of keys) {
        if (!Object.hasOwn(b, key)) return false;
        pending.push([a[key], b[key]]);
      }
    } else return false;
  }
  return true;
}

function missingPrevious(event: JsonRecord): boolean {
  const error = isRecord(event.error) ? event.error : isRecord(event.response) && isRecord(event.response.error) ? event.response.error : undefined;
  return error?.code === 'previous_response_not_found';
}
function meaningful(event: JsonRecord): boolean {
  if (typeof event.delta === 'string' && event.delta.length > 0 && String(event.type).endsWith('.delta')) return true;
  if (event.type === 'response.output_item.done') return true;
  return event.type === 'response.output_item.added' && isRecord(event.item) && event.item.type !== 'message' && event.item.type !== 'reasoning';
}

/** One client socket owns one upstream connection; no auth, history, or response state is shared. */
export class UpstreamSession {
  readonly enabled: boolean;
  private connection?: Connection;
  private last?: Last;
  private active?: Active;
  private busy = false;
  private closed = false;
  private unsupportedScope?: string;
  private readonly now: () => number;
  constructor(private readonly options: UpstreamSessionOptions) {
    this.enabled = options.enabled === true;
    this.now = options.now ?? Date.now;
  }

  /** Supply the client's original previous id before router history expansion removes it. */
  transport(previousResponseId?: string): UpstreamFetch {
    return (url, init) => this.send(url, init, previousResponseId);
  }
  fetch: UpstreamFetch = (url, init) => this.send(url, init);

  /** Client teardown or interruption discards connection-local continuation state. */
  close(): void { this.closed = true; this.reset(new ProxyTransportError()); }

  private scope(init: RequestInit, model: string): string {
    return JSON.stringify([model, [...new Headers(init.headers).entries()].sort(([a], [b]) => a.localeCompare(b))]);
  }

  private fallback(url: string, init: RequestInit, request: JsonRecord): Promise<Response> {
    // HTTP has no connection-local warmup. Match the router's existing local warm response;
    // the next generated turn still supplies its complete normalized history.
    if (request.generate === false) return Promise.resolve(streamResponse(responseObject(request, EMPTY_OUTPUT)));
    return this.options.fallback(url, init);
  }

  private reset(error?: unknown): void {
    const connection = this.connection;
    this.connection = undefined;
    this.last = undefined;
    if (this.active) this.finish(error ?? new ProxyTransportError());
    try { connection?.socket.close(); } catch {}
  }

  private async connect(url: string, init: RequestInit, model: string): Promise<{ connection: Connection; reused: boolean }> {
    const headers = new Headers(init.headers);
    // Header changes include token/account rotation and per-request routing metadata. None are logged.
    const scope = this.scope(init, model);
    const existing = this.connection;
    const lifetime = Math.min(this.options.maxLifetimeMs ?? 55 * 60_000, 60 * 60_000);
    if (existing && existing.scope === scope && existing.model === model && existing.socket.readyState === 1 && this.now() - existing.openedAt < lifetime) {
      return { connection: existing, reused: true };
    }
    this.reset();
    const beta = headers.get('OpenAI-Beta');
    if (!beta?.includes('responses_websockets=')) headers.set('OpenAI-Beta', [beta, 'responses_websockets=2026-02-06'].filter(Boolean).join(','));
    const target = new URL(url); target.protocol = 'wss:';
    const create = this.options.socket ?? ((address, outgoing) => {
      const Socket = WebSocket as unknown as { new(url: string, options: { headers: Headers }): WebSocket };
      return new Socket(address, { headers: outgoing });
    });
    const socket = create(String(target), headers);
    let resolve!: () => void, reject!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const connection: Connection = { socket, scope, model, openedAt: 0, ready };
    this.connection = connection;
    const signal = init.signal ?? undefined;
    const abort = () => { reject(signal?.reason); if (this.connection === connection) this.reset(signal?.reason); };
    const timer = setTimeout(() => { reject(new ProxyTransportError(true)); if (this.connection === connection) this.reset(); }, this.options.connectTimeoutMs ?? 10_000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true });
    socket.onopen = () => { connection.openedAt = this.now(); cleanup(); resolve(); };
    socket.onmessage = event => { if (this.connection === connection) this.message(event.data); };
    socket.onerror = event => {
      cleanup();
      const detail = 'message' in event && typeof event.message === 'string' ? event.message : '';
      const status = /(?:response|status)[^\d]*(\d{3})/i.exec(detail)?.[1];
      const error = status ? new UpstreamStatusError('Upstream WebSocket handshake failed', Number(status)) : new ProxyTransportError();
      reject(error);
      if (this.connection === connection) this.reset(error);
    };
    socket.onclose = () => {
      cleanup(); reject(new ProxyTransportError());
      if (this.connection === connection) this.reset(new ProxyTransportError());
    };
    try { if (signal?.aborted) abort(); await ready; return { connection, reused: false }; }
    catch (error) { cleanup(); if (this.connection === connection) this.reset(error); throw error; }
  }

  private async send(url: string, init: RequestInit, previousResponseId?: string): Promise<Response> {
    if (this.closed) throw new ProxyTransportError();
    const target = new URL(url);
    if (!this.enabled || target.origin !== 'https://chatgpt.com' || target.pathname !== '/backend-api/codex/responses') return this.options.fallback(url, init);
    const request = requestJson(init);
    if (!request || typeof request.model !== 'string' || request.background === true) return this.options.fallback(url, init);
    const scope = this.scope(init, request.model);
    if (this.unsupportedScope === scope) return this.fallback(url, init, request);
    this.unsupportedScope = undefined;
    if (this.busy) throw new Error('Upstream WebSocket session already has an active response');
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    this.busy = true;
    const started = performance.now();
    let opened: { connection: Connection; reused: boolean };
    try { opened = await this.connect(url, init, request.model); }
    catch (error) {
      this.busy = false;
      if (signal?.aborted) throw signal.reason;
      if (error instanceof UpstreamStatusError) {
        if (UNSUPPORTED.has(error.status)) { this.unsupportedScope = scope; return this.fallback(url, init, request); }
        return Response.json({ error: { type: 'upstream_error', message: error.message } }, { status: error.status });
      }
      // Bun may hide a refused upgrade's HTTP status. Before sending response.create, HTTP can
      // obtain the authoritative status (including account refresh/quota handling) safely.
      if (error instanceof ProxyTransportError) return this.fallback(url, init, request);
      throw error;
    }
    if (signal?.aborted) { this.busy = false; this.reset(); throw signal.reason; }
    const previous = previousResponseId ?? (typeof request.previous_response_id === 'string' ? request.previous_response_id : undefined);
    const input = request.input;
    const continued = Boolean(previous && this.last?.id === previous && Array.isArray(input) && input.length >= this.last.prefix.length && this.last.prefix.every((item, i) => sameJson(item, input[i])));
    const session = this;
    let resolveHeaders!: (response: Response) => void, rejectHeaders!: (error: unknown) => void;
    const headers = new Promise<Response>((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
    const stream = new ReadableStream<Uint8Array>({
      start(out) {
        const abort = () => session.reset(signal?.reason ?? new ProxyTransportError());
        session.active = { id: ++nextRequest, started, connectedMs: performance.now() - started, reused: opened.reused,
          request, continued, replayed: false, meaningful: false, output: [], out, signal, abort,
          provisional: [], provisionalBytes: 0, published: false, deferMetadata: continued,
          headersSettled: false, resolveHeaders, rejectHeaders, sentBytes: 0, sentItems: 0 };
        signal?.addEventListener('abort', abort, { once: true });
        try { session.write(session.active); } catch (error) { session.reset(error); }
      },
      cancel(reason) { session.reset(reason ?? new ProxyTransportError()); },
    });
    const response = new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
    if (this.active) this.active.response = response;
    return headers;
  }

  private write(active: Active): void {
    const { stream: _stream, background: _background, type: _type, previous_response_id: _previous, ...request } = active.request;
    const continued = active.continued && this.last;
    const input = continued && Array.isArray(request.input) ? request.input.slice(continued.prefix.length) : request.input;
    const payload = JSON.stringify({ ...request, type: 'response.create', input,
      ...(continued ? { previous_response_id: continued.id } : {}) });
    active.sentBytes += Buffer.byteLength(payload);
    active.sentItems = Array.isArray(input) ? input.length : typeof input === 'string' ? 1 : 0;
    this.connection!.socket.send(payload);
  }

  private message(data: unknown): void {
    const active = this.active;
    if (!active) return;
    let event: unknown;
    const raw = typeof data === 'string' ? data : String(data);
    if (Buffer.byteLength(raw) > 32 * 1024 * 1024) { this.reset(new ProxyTransportError()); return; }
    try { event = JSON.parse(raw); } catch { this.reset(new ProxyTransportError()); return; }
    if (!isRecord(event) || typeof event.type !== 'string') { this.reset(new ProxyTransportError()); return; }
    active.firstEventMs ??= performance.now() - active.started;
    if (missingPrevious(event) && active.continued && !active.meaningful && !active.published && !active.replayed) {
      active.replayed = true; active.continued = false; active.output = []; this.last = undefined;
      clearTimeout(active.provisionalTimer); active.provisionalTimer = undefined;
      active.provisional = []; active.provisionalBytes = 0;
      try { this.write(active); } catch (error) { this.reset(error); }
      return;
    }
    if (!active.headersSettled && event.type === 'error' && typeof event.status === 'number' && event.status >= 400 && event.status <= 599) {
      active.headersSettled = true;
      active.terminal = 'error';
      const headers = new Headers();
      if (isRecord(event.headers)) {
        for (const [name, value] of Object.entries(event.headers)) {
          if (ERROR_HEADER.test(name) && typeof value === 'string') { try { headers.set(name, value); } catch {} }
        }
      }
      active.resolveHeaders(Response.json({ error: event.error }, { status: event.status, headers }));
      this.finish(); this.reset(); return;
    }
    if (meaningful(event)) {
      active.meaningful = true;
      active.firstOutputMs ??= performance.now() - active.started;
    }
    if (event.type === 'response.output_item.done' && isRecord(event.item)) active.output.push(event.item);
    if (event.type === 'response.completed' && isRecord(event.response) && event.response.status === 'completed' && typeof event.response.id === 'string') {
      const output = Array.isArray(event.response.output) && event.response.output.length ? event.response.output : active.output;
      const input = Array.isArray(active.request.input) ? active.request.input : typeof active.request.input === 'string' ? [{ role: 'user', content: active.request.input }] : [];
      this.last = { id: event.response.id, prefix: [...input, ...output] };
    } else if (TERMINAL.has(event.type)) this.last = undefined;
    const terminal = TERMINAL.has(event.type);
    if (terminal) active.terminal = event.type;
    try {
      const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
      const limit = Math.max(0, Math.min(this.options.maxProvisionalBytes ?? 1024 * 1024, 32 * 1024 * 1024));
      if (active.deferMetadata && !active.meaningful && !active.published && !terminal && active.provisionalBytes + frame.length <= limit) {
        active.provisional.push(frame); active.provisionalBytes += frame.length;
        if (active.provisionalTimer === undefined) {
          // Bound hidden progress by time as well as bytes, so long reasoning never silences
          // the client's idle watchdog. Publishing metadata commits this attempt's identity.
          active.provisionalTimer = setTimeout(() => {
            if (this.active !== active) return;
            try { this.publish(active); } catch (error) { this.reset(error); }
          }, Math.max(0, Math.min(this.options.maxProvisionalMs ?? 1000, 10_000)));
          active.provisionalTimer.unref?.();
        }
        return;
      }
      // Once metadata must be exposed (including a full buffer), do not replay a different
      // response beneath it. First meaningful output keeps its own timing, separate from this.
      this.publish(active, frame);
    }
    catch (error) { this.reset(error); return; }
    if (terminal) {
      this.finish();
      if (event.type === 'error' && event.status === 401) this.reset();
    }
  }

  private publish(active: Active, frame?: Uint8Array): void {
    clearTimeout(active.provisionalTimer); active.provisionalTimer = undefined;
    if (!active.headersSettled) { active.headersSettled = true; active.resolveHeaders(active.response!); }
    for (const pending of active.provisional) active.out.enqueue(pending);
    active.provisional = []; active.provisionalBytes = 0; active.published = true;
    if (frame) active.out.enqueue(frame);
  }

  private finish(error?: unknown): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined; this.busy = false;
    clearTimeout(active.provisionalTimer); active.provisionalTimer = undefined;
    active.signal?.removeEventListener('abort', active.abort);
    if (!active.headersSettled) { active.headersSettled = true; active.rejectHeaders(error ?? new ProxyTransportError()); }
    logSafe('upstream-ws-finished', { request: active.id, reused: active.reused, continued: active.continued,
      replayed: active.replayed, connectMs: active.connectedMs, firstOutputMs: active.firstOutputMs,
      firstEventMs: active.firstEventMs, sentBytes: active.sentBytes, sentItems: active.sentItems,
      elapsedMs: performance.now() - active.started, terminal: active.terminal,
      failed: error !== undefined || active.terminal === 'error' || active.terminal === 'response.failed' });
    try { if (error !== undefined) active.out.error(error); else active.out.close(); } catch {}
  }
}
