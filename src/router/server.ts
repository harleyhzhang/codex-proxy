// The router Codex talks to. GPT requests go to ChatGPT unchanged; subscription models run
// locally. Both share one conversation, so chats can switch model mid-thread.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { onClaudeRateLimit } from '../backends/claude';
import { claudeLimits, claudeUsageSnapshot, type ClaudeUsage } from '../backends/claude-limits';
import { BackendError, terminalEvent } from '../backends/contract';
import { assertRoutable, backendFor, isLocalModel } from '../backends/registry';
import { isRecord, randomId, sha256, type JsonRecord } from '../json';
import { log, logSafe } from '../log';
import { responseObject, streamResponse } from '../protocol/output';
import { pendingResponse, pendingStream } from '../protocol/pending';
import { decodeBody, MAX_BODY_BYTES, sseEvents } from '../protocol/stream';
import { EMPTY_OUTPUT, type OutputItem, type ResponseObject, type ResponsesBody, type StreamEvent } from '../protocol/types';
import { failureStream, transportError, transportFailureEvent } from '../transport';
import { NativeAuth } from './auth';
import { AccountUpstream, accountModel, standardPrimaryFetch, type AccountOptions } from './account-upstream';
import { CompactionBridge, DEFAULT_BRIDGE_MODELS, normalizeAgentPayloads, restoreAgentMessages } from './bridge';
import { compactRequest, portableSummary, SummaryCodec } from './capsule';
import { HistoryCache, HistoryMiss } from './history';
import { localResponse } from './local';
import { jsonHeaders, postJson, relay, UPSTREAM_URL, type UpstreamFetch, upstreamErrorDetail, upstreamHeaders } from './upstream';

export type RouterOptions = {
  port: number;
  /** Codex's auth.json; requests must present the token stored there. */
  authFile: string;
  /** The model catalog served at /v1/models. */
  catalog: string;
  /** 32-byte key for compaction capsules. Without it, compaction for subscription models is off. */
  summaryKeyFile?: string;
  upstreamFetch?: UpstreamFetch;
  /** Whole-request cap for GPT calls; long compactions can exceed several minutes. */
  upstreamTimeoutMs?: number;
  /** Progress cadence for buffered subscription responses. */
  heartbeatMs?: number;
  bridgeModels?: readonly string[];
  secondaryAccount?: AccountOptions;
  primaryStandard?: boolean;
};

const RESPONSE_PATHS = new Set(['/v1/responses', '/v1/responses/compact', '/v1/responses/lite']);
/** Native Codex tools that share the provider base URL. Bodies (including multipart) pass through. */
const PASSTHROUGH_PATHS = new Set(['/v1/alpha/search', '/v1/images/generations', '/v1/images/edits']);
const BRIDGE_TIMEOUT_MS = 300_000;

/** Error messages written by the router itself, safe to show the user verbatim. */
const HTTP_VISIBLE = /^(Request too large|Unsupported|Previous|Missing request|OpenAI-encrypted history|OpenAI compaction|Compaction produced)/;
const WS_VISIBLE = /^(OpenAI-encrypted history|OpenAI compaction|Compaction produced|Unsupported|Previous)/;
const WS_LOGGED = /^(Unsupported|Previous|OpenAI-encrypted history|OpenAI compaction|Compaction produced|model is required|Request|tools must)/;
const GENERIC_FAILURE = 'Model request failed; retry or check subscription access';

type SocketData = { headers: Headers; busy: boolean; abort?: AbortController };

const isCompaction = (body: ResponsesBody) =>
  Array.isArray(body.input) && body.input.some((item) => item.type === 'compaction_trigger');

function invalidRequest(message: string, status = 400): Response {
  return Response.json({ error: { type: 'invalid_request_error', message } }, { status });
}

function errorPrefix(error: unknown, pattern: RegExp): string | undefined {
  return error instanceof Error && pattern.test(error.message) ? error.message : undefined;
}

function messageText(items: OutputItem[]): string {
  return items
    .filter((item) => item.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part): part is { type: string; text: string } => isRecord(part) && part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** Persists the Claude plan snapshot so a restart still refuses an exhausted model up front. */
function trackClaudeUsage(file: string): void {
  try {
    claudeLimits.restore(JSON.parse(readFileSync(file, 'utf8')) as ClaudeUsage);
  } catch {}
  onClaudeRateLimit((info) => {
    void Bun.write(file, JSON.stringify(claudeUsageSnapshot(info), null, 2)).catch(() => {});
  });
}

export function startRouter(options: RouterOptions) {
  const auth = new NativeAuth(options.authFile);
  const history = new HistoryCache();
  const base: UpstreamFetch = options.upstreamFetch ?? ((url, init) => fetch(url, init));
  const routed = options.secondaryAccount ? new AccountUpstream(options.secondaryAccount, base).fetch : base;
  const upstreamFetch = options.primaryStandard ? standardPrimaryFetch(routed) : routed;
  const timeoutMs = options.upstreamTimeoutMs ?? 900_000;
  const deadline = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

  const stateDir = options.summaryKeyFile ? dirname(options.summaryKeyFile) : undefined;
  const codec = options.summaryKeyFile ? new SummaryCodec(readFileSync(options.summaryKeyFile)) : undefined;
  if (stateDir) trackClaudeUsage(join(stateDir, 'claude-usage.json'));

  const bridgeFlights = new Map<string, Promise<string>>();

  /** A bridge that reads OpenAI ciphertext with the caller's own credentials. */
  const bridgeFor = (headers: Headers): CompactionBridge | undefined => {
    if (!codec || !stateDir) return undefined;
    const forwarded = jsonHeaders(headers, { stripCodexMetadata: true });
    // Only identical effective request contexts share a flight; keep credentials out of its key.
    const scope = sha256(JSON.stringify(Array.from(forwarded.entries()).sort(([a], [b]) => a.localeCompare(b))));
    const call = (body: ResponsesBody) =>
      postJson(upstreamFetch, '/responses', forwarded, body, AbortSignal.timeout(BRIDGE_TIMEOUT_MS));
    return new CompactionBridge(codec, join(stateDir, 'bridged'), call, options.bridgeModels ?? DEFAULT_BRIDGE_MODELS, { scope, jobs: bridgeFlights });
  };

  /** Validates routing, expands history and makes GPT-only content readable for the target model. */
  async function normalize(raw: JsonRecord, headers: Headers): Promise<ResponsesBody> {
    const body = raw as ResponsesBody;
    assertRoutable(body.model);
    if (options.secondaryAccount) accountModel(body.model, options.secondaryAccount.prefix, options.secondaryAccount.models);
    const backend = backendFor(body.model);
    if (body.generate !== false && backend && typeof body.model === 'string') {
      backend.assertAvailable?.(backend.models[body.model] as string);
    }
    const withList = typeof body.input === 'string' ? { ...body, input: [{ role: 'user', content: body.input }] } : body;
    let expanded = normalizeAgentPayloads(history.expand(withList));
    if (!codec || body.generate === false) return expanded;

    const local = isLocalModel(body.model);
    const bridge = bridgeFor(headers);
    if (local && Array.isArray(expanded.input)) {
      expanded = { ...expanded, input: await restoreAgentMessages(expanded.input, bridge) };
    }
    return codec.unwrap(expanded, local, bridge && ((encrypted) => bridge.summary(encrypted)));
  }

  /** Produces a compaction item: a sealed capsule holding the summary and verbatim requests. */
  async function compact(body: ResponsesBody, headers: Headers, signal: AbortSignal): Promise<ResponseObject> {
    if (!codec) throw new Error('Local compaction key unavailable');
    const input = Array.isArray(body.input) ? body.input : [];
    portableSummary('', input); // Fail before spending a generation if the requests cannot fit.
    const request = compactRequest(body);

    let response: ResponseObject | undefined;
    const streamedItems: OutputItem[] = [];
    let streamedText = '';
    if (isLocalModel(body.model)) {
      response = await localResponse(request, signal);
    } else {
      const { type: _type, previous_response_id: _previous, ...clean } = request;
      const upstream = await postJson(upstreamFetch, '/responses', jsonHeaders(headers, { stripCodexMetadata: true }), clean, deadline(signal));
      if (!upstream.ok) {
        const detail = await upstreamErrorDetail(upstream);
        log.warn('compact-upstream', { status: upstream.status, detail });
        throw new Error(`OpenAI compaction request failed HTTP ${upstream.status}${detail ? `: ${detail}` : ''}`);
      }
      await sseEvents(upstream, (event) => {
        if (event.type === 'response.output_item.done' && isRecord(event.item)) streamedItems.push(event.item as OutputItem);
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') streamedText += event.delta;
        if (event.type === 'response.completed' && isRecord(event.response)) response = event.response as ResponseObject;
      });
    }

    const items = response?.output?.length ? response.output : streamedItems;
    const summary = messageText(items) || streamedText;
    if (!response || !summary) {
      log.warn('compact-output', { types: items.map((item) => item.type) });
      throw new Error('Compaction produced no continuation summary');
    }
    const compacted: ResponseObject = {
      ...response,
      output: [{ id: randomId('cmp'), type: 'compaction', encrypted_content: codec.seal(portableSummary(summary, input)) }],
    };
    history.remember(body, compacted);
    return compacted;
  }

  const pendingFailure = (error: unknown): Record<string, unknown> => {
    const network = transportError(error);
    return network ? transportFailureEvent(network) : terminalEvent(error instanceof BackendError ? error : new BackendError(GENERIC_FAILURE));
  };

  async function handleHttp(req: Request, path: string): Promise<Response> {
    if (req.method !== 'POST') return invalidRequest('Unsupported method', 405);
    let streaming = false;
    try {
      const raw = await decodeBody(req);
      streaming = raw.stream === true;
      const body = await normalize(raw, req.headers);
      if (isCompaction(body)) {
        if (body.stream && isLocalModel(body.model)) return pendingStream(body, signal => compact(body, req.headers, signal), req.signal, pendingFailure, response => history.remember(body, response), options.heartbeatMs);
        const response = await compact(body, req.headers, req.signal);
        return body.stream ? streamResponse(response) : Response.json(response);
      }
      if (isLocalModel(body.model)) {
        if (path !== '/v1/responses') return invalidRequest('Use Codex local compaction for subscription models');
        if (body.stream) return pendingStream(body, signal => localResponse(body, signal), req.signal, pendingFailure, response => { if (body.generate !== false) history.remember(body, response); }, options.heartbeatMs);
        const response = await localResponse(body, req.signal);
        if (body.generate !== false) history.remember(body, response);
        return body.stream ? streamResponse(response) : Response.json(response);
      }
      const headers = jsonHeaders(req.headers, { eventStream: false });
      return relay(await postJson(upstreamFetch, path.slice(3), headers, body, deadline(req.signal)));
    } catch (error) {
      const network = transportError(error);
      if (network && !req.signal.aborted) {
        return streaming
          ? failureStream(transportFailureEvent(network))
          : Response.json({ error: { type: 'server_error', code: 'server_error', message: network.message } }, { status: 503 });
      }
      if (error instanceof BackendError) {
        return streaming
          ? failureStream(terminalEvent(error))
          : Response.json({ error: { type: 'invalid_request_error', code: error.code, message: error.message } }, { status: 400 });
      }
      if (error instanceof HistoryMiss) return invalidRequest(error.message);
      logSafe('http-failed', {
        path,
        compaction: path.includes('compact'),
        cancelled: req.signal.aborted,
        name: error instanceof Error ? error.name : typeof error,
        hint: error instanceof Error ? error.message.slice(0, 60) : '',
      });
      return invalidRequest(errorPrefix(error, HTTP_VISIBLE) ?? GENERIC_FAILURE, 502);
    }
  }

  async function passthrough(req: Request, url: URL): Promise<Response> {
    if (req.method !== 'POST') return invalidRequest('Unsupported method', 405);
    try {
      const response = await upstreamFetch(UPSTREAM_URL + url.pathname.slice(3) + url.search, {
        method: 'POST',
        headers: upstreamHeaders(req.headers),
        body: req.body,
        signal: deadline(req.signal),
        redirect: 'error',
      });
      return relay(response);
    } catch {
      return invalidRequest('OpenAI tool request failed; retry', 503);
    }
  }

  async function handleSocketMessage(ws: ServerWebSocket<SocketData>, data: string | Buffer): Promise<void> {
    const send = (event: unknown) => ws.send(JSON.stringify(event));
    if (ws.data.busy) {
      send({ type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'invalid_request_error', message: 'A response is already in progress' } });
      return;
    }
    const controller = new AbortController();
    ws.data.abort = controller;
    ws.data.busy = true;
    const live = () => !controller.signal.aborted;

    try {
      if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_BODY_BYTES) throw new Error('Invalid message size');
      const message: unknown = JSON.parse(data);
      if (!isRecord(message)) throw new Error('Unsupported WebSocket command');
      if (message.type && message.type !== 'response.create') throw new Error('Unsupported WebSocket command');
      const body = await normalize(isRecord(message.response) ? message.response : message, ws.data.headers);
      log.info('request', { model: body.model, warmup: body.generate === false, compaction: isCompaction(body) });

      if (body.generate === false) {
        // Codex continues from a warmup's response id, so warmups are remembered too.
        const warm = responseObject(body, EMPTY_OUTPUT);
        history.remember(body, warm);
        await sseEvents(streamResponse(warm), send);
      } else if (isCompaction(body)) {
        if (isLocalModel(body.model)) await pendingResponse(body, signal => compact(body, ws.data.headers, signal), controller.signal, send, response => history.remember(body, response), options.heartbeatMs);
        else await sseEvents(streamResponse(await compact(body, ws.data.headers, controller.signal)), send);
      } else if (isLocalModel(body.model)) {
        await pendingResponse(body, signal => localResponse(body, signal), controller.signal, send, response => history.remember(body, response), options.heartbeatMs);
      } else {
        await relayUpstreamStream(body, ws.data.headers, controller.signal, (event) => live() && send(event), send);
      }
    } catch (error) {
      const network = transportError(error);
      if (network) {
        log.warn('transport-interrupted', { cancelled: !live() });
        if (live()) send(transportFailureEvent(network));
      } else if (error instanceof BackendError) {
        if (error.logEvent) log.warn(String(error.logEvent.event ?? 'backend-refusal'), error.logEvent);
        if (live()) send(terminalEvent(error));
      } else if (error instanceof HistoryMiss) {
        // Dropping the socket makes Codex reconnect and resend the full history.
        log.warn('history-miss');
        ws.close(1011, 'history unavailable');
      } else {
        log.warn('failed', { cancelled: !live(), category: errorPrefix(error, WS_LOGGED) ?? 'upstream-or-transport' });
        if (live()) {
          send({
            type: 'error',
            status: 400,
            error: { type: 'invalid_request_error', code: 'invalid_request_error', message: errorPrefix(error, WS_VISIBLE) ?? GENERIC_FAILURE },
          });
        }
      }
    } finally {
      log.info('request-finished', { cancelled: !live() });
      ws.data.busy = false;
      ws.data.abort = undefined;
    }
  }

  /** Streams a GPT turn back over the socket and records it for `previous_response_id`. */
  async function relayUpstreamStream(
    body: ResponsesBody,
    headers: Headers,
    signal: AbortSignal,
    forward: (event: StreamEvent) => void,
    send: (event: unknown) => void,
  ): Promise<void> {
    const { type: _type, previous_response_id: _previous, ...request } = body;
    const response = await postJson(upstreamFetch, '/responses', jsonHeaders(headers), { ...request, stream: true }, deadline(signal));
    if (!response.ok) {
      const detail = await upstreamErrorDetail(response);
      log.warn('upstream', { status: response.status, detail });
      send({
        type: 'error',
        status: response.status,
        error: { type: 'server_error', message: `OpenAI returned HTTP ${response.status}${detail ? `: ${detail}` : ''}` },
      });
      return;
    }
    const items: OutputItem[] = [];
    await sseEvents(response, (event) => {
      if (event.type === 'response.output_item.done' && isRecord(event.item)) items.push(event.item as OutputItem);
      if (event.type === 'response.completed' && isRecord(event.response)) {
        const completed = event.response as ResponseObject;
        history.remember(body, { ...completed, output: completed.output?.length ? completed.output : items });
      }
      forward(event);
    });
  }

  return Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port: options.port,
    idleTimeout: 255,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/health' && req.method === 'GET') return Response.json({ status: 'ok', mode: 'mixed', version: 1 });
      if (!(await auth.accepts(req.headers))) return invalidRequest('Native ChatGPT authentication required', 401);
      if (url.pathname === '/v1/models' && req.method === 'GET') return Response.json(await Bun.file(options.catalog).json());
      if (PASSTHROUGH_PATHS.has(url.pathname)) return passthrough(req, url);
      if (!RESPONSE_PATHS.has(url.pathname)) {
        log.warn('unsupported-endpoint', { method: req.method, path: url.pathname.slice(0, 160) });
        return invalidRequest('Not found', 404);
      }
      if (url.pathname === '/v1/responses' && server.upgrade(req, { data: { headers: new Headers(req.headers), busy: false } })) {
        return undefined;
      }
      return handleHttp(req, url.pathname);
    },
    websocket: {
      message: handleSocketMessage,
      close(ws) {
        ws.data.abort?.abort();
      },
    },
  });
}
