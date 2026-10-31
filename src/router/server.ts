// The router Codex talks to. GPT requests go to ChatGPT unchanged; subscription models run
// locally. Both share one conversation, so chats can switch model mid-thread.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { onClaudeRateLimit } from '../backends/claude';
import { claudeLimits, claudeUsageSnapshot, type ClaudeUsage } from '../backends/claude-limits';
import { BackendError, terminalEvent } from '../backends/contract';
import { assertRoutable, backendFor, isLocalModel, secondaryClaude } from '../backends/registry';
import { isRecord, randomId, sha256, type JsonRecord } from '../json';
import { log, logSafe } from '../log';
import { responseObject, streamResponse } from '../protocol/output';
import { pendingEnvelope, pendingRelay, pendingResponse, pendingStream, startHeartbeat } from '../protocol/pending';
import { decodeBody, MAX_BODY_BYTES, sseEvents } from '../protocol/stream';
import { EMPTY_OUTPUT, type OutputItem, type ResponseObject, type ResponsesBody, type StreamEvent } from '../protocol/types';
import { failureStream, transportError, transportFailureEvent } from '../transport';
import { NativeAuth } from './auth';
import { AccountUpstream, accountModel, standardPrimaryFetch, type AccountOptions } from './account-upstream';
import { CompactionBridge, DEFAULT_BRIDGE_MODELS, normalizeAgentPayloads, normalizeToolSearchIds, restoreAgentMessages } from './bridge';
import { compactRequest, portableSummary, SummaryCodec } from './capsule';
import { HistoryCache, HistoryMiss } from './history';
import { localResponse, prewarmLocal } from './local';
import { connectUpstream, idleDeadline, jsonHeaders, postJson, relay, UPSTREAM_URL, type UpstreamErrorFields, type UpstreamFetch, upstreamFailure, upstreamHeaders, UpstreamStatusError, watchBody } from './upstream';
import { UpstreamSession, type UpstreamSessionOptions } from './upstream-session';

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
  /** Keep native GPT continuations on their client's own upstream WebSocket. */
  upstreamWebSocket?: boolean;
  /** Transport injection for tests; production always connects to the native Codex backend. */
  upstreamSocket?: UpstreamSessionOptions['socket'];
};

const RESPONSE_PATHS = new Set(['/v1/responses', '/v1/responses/compact', '/v1/responses/lite']);
/** Native Codex tools that share the provider base URL. Bodies (including multipart) pass through. */
const PASSTHROUGH_PATHS = new Set(['/v1/alpha/search', '/v1/images/generations', '/v1/images/edits']);
const BRIDGE_TIMEOUT_MS = 300_000;

/** Error messages written by the router itself, safe to show the user verbatim. */
const HTTP_VISIBLE = /^(Request too large|Request body|Unsupported|Previous|Missing request|OpenAI-encrypted history|OpenAI compaction|Compaction produced)/;
// Faults in the request itself are 400 (never retried); faults bridging to OpenAI stay 502 so Codex retries.
const CLIENT_FAULT = /^(Request |Missing request|Unsupported)/;
const WS_VISIBLE = /^(OpenAI-encrypted history|OpenAI compaction|Compaction produced|Unsupported|Previous)/;
const WS_LOGGED = /^(Unsupported|Previous|OpenAI-encrypted history|OpenAI compaction|Compaction produced|model is required|Request|tools must)/;
/** Native Codex treats its own internal errors as retryable; so does the router (a 500 is retried, a 400 is not). */
const INTERNAL_FAILURE = 'Internal router error; Codex will retry.';

/** `interrupt` is aborted by `response.interrupt` for `responseId`, the turn Codex last saw created. */
type SocketData = { headers: Headers; busy: boolean; abort?: AbortController; interrupt?: AbortController; responseId?: string; upstream?: UpstreamSession };
/** A `response.interrupt` frame is tiny; larger frames are never parsed twice. */
const INTERRUPT_MAX_BYTES = 4096;

/** The `response_id` of a `response.interrupt` frame, or undefined for any other message. */
function interruptTarget(data: string | Buffer): string | undefined {
  if (typeof data !== 'string' || data.length > INTERRUPT_MAX_BYTES || !data.includes('response.interrupt')) return undefined;
  try {
    const message: unknown = JSON.parse(data);
    if (!isRecord(message) || message.type !== 'response.interrupt') return undefined;
    return typeof message.response_id === 'string' ? message.response_id : '';
  } catch { return undefined; }
}

/** What a turn stopped by `response.interrupt` finishes as; Codex continues from its id. */
function interruptedResponse(response: ResponseObject, output: OutputItem[]): ResponseObject {
  return { ...response, output, status: 'incomplete', incomplete_details: { reason: 'interrupted' } };
}

const isCompaction = (body: ResponsesBody) =>
  Array.isArray(body.input) && body.input.some((item) => item.type === 'compaction_trigger');

function invalidRequest(message: string, status = 400): Response {
  return Response.json({ error: { type: 'invalid_request_error', message } }, { status });
}

// Subscription quota refusals deliberately stay terminal `invalid_prompt` failures with our own message
// rather than a ChatGPT-shaped 429 `usage_limit_reached`: native Codex discards the body message for
// that shape and renders its generic ChatGPT usage-limit copy, which would hide which model is capped.

/**
 * The error body for an upstream failure, typed so Codex retries 5xx and not 4xx. OpenAI's own
 * classifying fields win, so native still recognises a usage limit, cyber-policy flag or overload.
 */
function upstreamFailureBody(status: number, message: string, fields: UpstreamErrorFields = {}) {
  const type = status >= 500 ? 'server_error' : 'invalid_request_error';
  return { type, code: type, ...fields, message };
}

/**
 * An upstream refusal delivered inside an already-open stream (the status line is gone). 5xx keeps
 * `server_error` so Codex retries; a 4xx without a native classifying code is `invalid_prompt`, the
 * terminal code that shows OpenAI's message verbatim instead of retrying.
 */
function upstreamFailedEvent(status: number, message: string, fields: UpstreamErrorFields = {}) {
  const body = upstreamFailureBody(status, message, fields);
  const code = status >= 500 ? 'server_error' : typeof fields.code === 'string' ? fields.code : 'invalid_prompt';
  return { type: 'response.failed', sequence_number: 0, response: { id: randomId('resp'), status: 'failed', error: { ...body, code } } };
}

function errorPrefix(error: unknown, pattern: RegExp): string | undefined {
  return error instanceof Error && pattern.test(error.message) ? error.message : undefined;
}

const COMPACTION_ERROR_FIELDS = ['type', 'code', 'plan_type', 'resets_at', 'resets_in_seconds'] as const;
const QUOTA_CODES = new Set(['usage_limit_reached', 'rate_limit_exceeded', 'insufficient_quota']);
const REQUEST_FAULT_CODES = new Set(['context_length_exceeded', 'invalid_prompt', 'cyber_policy', 'invalid_request_error']);

/**
 * A compaction stream that OpenAI ended with `response.failed` or `error`. Its reason and
 * classifying fields reach Codex, which retries it unless OpenAI called it a quota or request fault.
 */
function compactionStreamFailure(event: StreamEvent): UpstreamStatusError {
  const response = isRecord(event.response) ? event.response : {};
  const error = isRecord(event.error) ? event.error : isRecord(response.error) ? response.error : {};
  const fields: UpstreamErrorFields = {};
  for (const key of COMPACTION_ERROR_FIELDS) {
    const value = error[key];
    if (typeof value === 'string' || typeof value === 'number') fields[key] = value;
  }
  const code = String(fields.code ?? fields.type ?? '');
  const status = typeof event.status === 'number' ? event.status : QUOTA_CODES.has(code) ? 429 : REQUEST_FAULT_CODES.has(code) ? 400 : 502;
  const detail = typeof error.message === 'string' ? error.message.slice(0, 300) : '';
  return new UpstreamStatusError(`OpenAI compaction failed${detail ? `: ${detail}` : ''}`, status, fields);
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
  const account = options.secondaryAccount ? new AccountUpstream(options.secondaryAccount, base) : undefined;
  const withPolicy = (transport: UpstreamFetch): UpstreamFetch => {
    const routed = account ? account.withTransport(transport) : transport;
    return options.primaryStandard ? standardPrimaryFetch(routed) : routed;
  };
  const upstreamFetch = withPolicy(base);
  const timeoutMs = options.upstreamTimeoutMs ?? 900_000;

  const stateDir = options.summaryKeyFile ? dirname(options.summaryKeyFile) : undefined;
  const codec = options.summaryKeyFile ? new SummaryCodec(readFileSync(options.summaryKeyFile)) : undefined;
  if (stateDir) {
    trackClaudeUsage(join(stateDir, 'claude-usage.json'));
    if (secondaryClaude) {
      const file = join(stateDir, `claude-${process.env.CLAUDE_ACCOUNT_MODEL_PREFIX || 'secondary'}-usage.json`);
      try { secondaryClaude.account.limits.restore(JSON.parse(readFileSync(file, 'utf8')) as ClaudeUsage); } catch {}
      secondaryClaude.account.onRateLimit(info => { void Bun.write(file, JSON.stringify(claudeUsageSnapshot(info), null, 2)).catch(() => {}); });
    }
  }

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
    if (options.secondaryAccount && !isLocalModel(body.model)) accountModel(body.model, options.secondaryAccount.prefix, options.secondaryAccount.models);
    const backend = backendFor(body.model);
    if (body.generate !== false && backend && typeof body.model === 'string') {
      backend.assertAvailable?.(backend.models[body.model] as string);
    }
    const withList = typeof body.input === 'string' ? { ...body, input: [{ role: 'user', content: body.input }] } : body;
    let expanded = normalizeToolSearchIds(normalizeAgentPayloads(history.expand(withList)));
    if (!codec || body.generate === false) return expanded;

    const local = isLocalModel(body.model);
    const bridge = bridgeFor(headers);
    if (local && Array.isArray(expanded.input)) {
      expanded = { ...expanded, input: await restoreAgentMessages(expanded.input, bridge) };
    }
    return codec.unwrap(expanded, local, bridge && ((encrypted) => bridge.summary(encrypted)));
  }

  /** Produces a compaction item: a sealed capsule holding the summary and verbatim requests. */
  /**
   * `offline` enables the shared outage policy: the OpenAI connect phase (or the local backend) is
   * retried until it answers, and `offline()` is invoked on the first failed attempt so the caller
   * can start progress frames. Without it, one attempt: the caller keeps HTTP status semantics and
   * decides itself whether to go pending.
   */
  async function compact(body: ResponsesBody, headers: Headers, signal: AbortSignal, offline?: () => void): Promise<ResponseObject> {
    if (!codec) throw new Error('Local compaction key unavailable');
    const input = Array.isArray(body.input) ? body.input : [];
    portableSummary('', input); // Fail before spending a generation if the requests cannot fit.
    const request = compactRequest(body);

    let response: ResponseObject | undefined;
    const streamedItems: OutputItem[] = [];
    let streamedText = '';
    let terminal: StreamEvent | undefined;
    if (isLocalModel(body.model)) {
      response = await localResponse(request, signal, { reconnect: offline !== undefined });
    } else {
      const { type: _type, previous_response_id: _previous, ...clean } = request;
      // Streamed like other turns, so bound silence rather than total time; native allows long compactions.
      const idle = idleDeadline(signal, timeoutMs);
      const forwarded = jsonHeaders(headers, { stripCodexMetadata: true });
      const upstream = watchBody(offline
        ? await connectUpstream(upstreamFetch, '/responses', forwarded, clean, idle, signal, offline)
        : await postJson(upstreamFetch, '/responses', forwarded, clean, idle.signal), idle);
      if (!upstream.ok) {
        const { detail, fields } = await upstreamFailure(upstream);
        log.warn('compact-upstream', { status: upstream.status, detail });
        throw new UpstreamStatusError(`OpenAI compaction request failed HTTP ${upstream.status}${detail ? `: ${detail}` : ''}`, upstream.status, fields);
      }
      await sseEvents(upstream, (event) => {
        if (event.type === 'response.output_item.done' && isRecord(event.item)) streamedItems.push(event.item as OutputItem);
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') streamedText += event.delta;
        if (event.type === 'response.completed' && isRecord(event.response)) response = event.response as ResponseObject;
        if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') terminal = event;
      });
      if (terminal && terminal.type !== 'response.incomplete') {
        const failure = compactionStreamFailure(terminal);
        log.warn('compact-failed', { terminal: terminal.type, status: failure.status, code: failure.fields.code ?? null });
        throw failure;
      }
      // An incomplete summary (e.g. the output cap) still carries the work so far, and the capsule keeps
      // the verbatim requests beside it, so it is used rather than failing the whole compaction.
      if (terminal && isRecord(terminal.response)) response = terminal.response as ResponseObject;
    }

    const items = response?.output?.length ? response.output : streamedItems;
    const summary = messageText(items) || streamedText;
    if (!response || !summary) {
      log.warn('compact-output', { types: items.map((item) => item.type), terminal: terminal?.type ?? 'response.completed' });
      // An empty reply is a model hiccup, not a fault in the request: 502 so Codex retries it.
      throw new UpstreamStatusError('Compaction produced no continuation summary; Codex will retry', 502);
    }
    if (terminal) {
      const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
      log.warn('compact-incomplete', { reason: typeof details.reason === 'string' ? details.reason.slice(0, 40) : null, chars: summary.length });
    }
    const compacted: ResponseObject = {
      ...response,
      status: 'completed',
      output: [{ id: randomId('cmp'), type: 'compaction', encrypted_content: codec.seal(portableSummary(summary, input)) }],
    };
    history.remember(body, compacted);
    return compacted;
  }

  const pendingFailure = (error: unknown): Record<string, unknown> => {
    const network = transportError(error);
    if (network) return transportFailureEvent(network);
    if (error instanceof BackendError) return terminalEvent(error);
    if (error instanceof UpstreamStatusError) return upstreamFailedEvent(error.status, error.message, error.fields);
    // An unexpected router/backend exception mid-stream: retryable, like native Codex's own internal errors.
    logSafe('pending-internal-error', { name: error instanceof Error ? error.name : typeof error });
    return { type: 'response.failed', sequence_number: 0, response: { id: randomId('resp'), status: 'failed', error: { code: 'server_error', message: INTERNAL_FAILURE } } };
  };

  async function handleHttp(req: Request, path: string): Promise<Response> {
    if (req.method !== 'POST') return invalidRequest('Unsupported method', 405);
    let streaming = false;
    try {
      const raw = await decodeBody(req);
      streaming = raw.stream === true;
      const body = await normalize(raw, req.headers);
      if (isCompaction(body)) {
        const pendingCompaction = () => pendingStream(body, signal => compact(body, req.headers, signal, () => {}), req.signal, pendingFailure, response => history.remember(body, response), options.heartbeatMs);
        if (body.stream && isLocalModel(body.model)) return pendingCompaction();
        if (body.stream) {
          // GPT compaction keeps OpenAI's real status on the first attempt; only an outage before any
          // answer switches the same request to the pending stream, where it waits for the network.
          try { return streamResponse(await compact(body, req.headers, req.signal)); }
          catch (error) {
            if (!transportError(error)?.reconnectable || req.signal.aborted) throw error;
            log.warn('upstream-offline', { path: 'compact' });
            return pendingCompaction();
          }
        }
        const response = await compact(body, req.headers, req.signal);
        return Response.json(response);
      }
      if (isLocalModel(body.model)) {
        if (path !== '/v1/responses') return invalidRequest('Use Codex local compaction for subscription models');
        if (body.stream) return pendingStream(body, signal => localResponse(body, signal), req.signal, pendingFailure, response => { if (body.generate !== false) history.remember(body, response); }, options.heartbeatMs);
        // Plain JSON has no channel for progress frames, so it fails like a native request would.
        const response = await localResponse(body, req.signal, { reconnect: false });
        if (body.generate !== false) history.remember(body, response);
        return Response.json(response);
      }
      const headers = jsonHeaders(req.headers, { eventStream: false });
      const idle = idleDeadline(req.signal, timeoutMs);
      const upstreamPath = path.slice(3);
      try {
        return relay(watchBody(await postJson(upstreamFetch, upstreamPath, headers, body, idle.signal), idle));
      } catch (error) {
        // Offline before any upstream byte: keep this request pending with progress frames instead of
        // spending one of Codex's five stream reconnects on every outage retry. The first attempt
        // above still relays OpenAI's real HTTP status when the network is up.
        if (!streaming || !transportError(error)?.reconnectable || req.signal.aborted) throw error;
        idle.done();
        log.warn('upstream-offline', { path: upstreamPath });
        return pendingRelay(body, (signal) => {
          const pendingIdle = idleDeadline(signal, timeoutMs);
          return connectUpstream(upstreamFetch, upstreamPath, headers, body, pendingIdle, signal).then(response => watchBody(response, pendingIdle));
        }, req.signal, pendingFailure, async (response) => {
          const { detail, fields } = await upstreamFailure(response);
          log.warn('upstream', { status: response.status, detail });
          return upstreamFailedEvent(response.status, `OpenAI returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`, fields);
        }, options.heartbeatMs);
      }
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
      if (error instanceof UpstreamStatusError) return Response.json({ error: upstreamFailureBody(error.status, error.message, error.fields) }, { status: error.status });
      logSafe('http-failed', {
        path,
        compaction: path.includes('compact'),
        cancelled: req.signal.aborted,
        name: error instanceof Error ? error.name : typeof error,
        hint: error instanceof Error ? error.message.slice(0, 60) : '',
      });
      const visible = errorPrefix(error, HTTP_VISIBLE);
      if (visible) return invalidRequest(visible, CLIENT_FAULT.test(visible) ? 400 : 502);
      return streaming
        ? failureStream({ type: 'response.failed', sequence_number: 0, response: { id: randomId('resp'), status: 'failed', error: { code: 'server_error', message: INTERNAL_FAILURE } } })
        : Response.json({ error: { type: 'server_error', code: 'server_error', message: INTERNAL_FAILURE } }, { status: 500 });
    }
  }

  async function passthrough(req: Request, url: URL): Promise<Response> {
    if (req.method !== 'POST') return invalidRequest('Unsupported method', 405);
    try {
      const idle = idleDeadline(req.signal, timeoutMs);
      const response = await upstreamFetch(UPSTREAM_URL + url.pathname.slice(3) + url.search, {
        method: 'POST',
        headers: upstreamHeaders(req.headers),
        body: req.body,
        signal: idle.signal,
        redirect: 'error',
      });
      return relay(watchBody(response, idle));
    } catch {
      return invalidRequest('OpenAI tool request failed; retry', 503);
    }
  }

  async function handleSocketMessage(ws: ServerWebSocket<SocketData>, data: string | Buffer): Promise<void> {
    const send = (event: unknown) => {
      if (isRecord(event) && event.type === 'response.created' && isRecord(event.response) && typeof event.response.id === 'string') ws.data.responseId = event.response.id;
      ws.send(JSON.stringify(event));
    };
    // Codex steers a running turn with `response.interrupt` (InstantInterrupt): stop that turn,
    // finish it as `response.incomplete`, and acknowledge. A turn that already finished is still
    // acknowledged, since Codex may be waiting for one after reading the completion.
    const interrupted = interruptTarget(data);
    if (interrupted !== undefined) {
      const matched = ws.data.busy && interrupted === ws.data.responseId;
      log.info('interrupt', { active: ws.data.busy, matched });
      send({ type: 'response.interrupt.accepted', response_id: interrupted });
      if (matched) ws.data.interrupt?.abort();
      return;
    }
    if (ws.data.busy) {
      send({ type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'invalid_request_error', message: 'A response is already in progress' } });
      return;
    }
    const controller = new AbortController();
    const interrupt = new AbortController();
    ws.data.abort = controller;
    ws.data.interrupt = interrupt;
    ws.data.responseId = undefined;
    ws.data.busy = true;
    const live = () => !controller.signal.aborted;

    try {
      if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_BODY_BYTES) throw new Error('Invalid message size');
      const message: unknown = JSON.parse(data);
      if (!isRecord(message)) throw new Error('Unsupported WebSocket command');
      if (message.type && message.type !== 'response.create') throw new Error('Unsupported WebSocket command');
      const raw = isRecord(message.response) ? message.response : message;
      const previous = typeof raw.previous_response_id === 'string' ? raw.previous_response_id : undefined;
      const body = await normalize(raw, ws.data.headers);
      log.info('request', { model: body.model, warmup: body.generate === false, compaction: isCompaction(body) });

      if (options.upstreamWebSocket && !isLocalModel(body.model) && !isCompaction(body)) {
        ws.data.upstream ??= new UpstreamSession({
          enabled: true,
          socket: options.upstreamSocket,
          fallback: base,
        });
      }
      const fetchUpstream = ws.data.upstream && !isLocalModel(body.model) && !isCompaction(body)
        ? withPolicy(ws.data.upstream.transport(previous)) : upstreamFetch;

      if (body.generate === false && ws.data.upstream && !isLocalModel(body.model) && !isCompaction(body)) {
        // Preserve upstream's real warmup ID so the first turn can continue on this connection.
        await relayUpstreamStream(body, ws.data.headers, controller.signal, interrupt.signal, (event) => live() && send(event), send, fetchUpstream);
      } else if (body.generate === false) {
        if (isLocalModel(body.model)) prewarmLocal(body);
        // Codex continues from a warmup's response id, so warmups are remembered too.
        const warm = responseObject(body, EMPTY_OUTPUT);
        history.remember(body, warm);
        await sseEvents(streamResponse(warm), send);
      } else if (isCompaction(body)) {
        if (isLocalModel(body.model)) await pendingResponse(body, signal => compact(body, ws.data.headers, signal, () => {}), controller.signal, send, response => history.remember(body, response), options.heartbeatMs);
        else {
          // The socket can carry progress frames at any time, so an outage starts heartbeats in place.
          let stop: (() => void) | undefined;
          try {
            const compacted = await compact(body, ws.data.headers, controller.signal, () => { stop ??= startHeartbeat(send, pendingEnvelope(body), options.heartbeatMs); });
            stop?.(); stop = undefined;
            await sseEvents(streamResponse(compacted), send);
          } finally { stop?.(); }
        }
      } else if (isLocalModel(body.model)) {
        await pendingResponse(body, async (signal) => {
          // Output is buffered until the backend finishes, so an interrupt discards the turn whole.
          try { return await localResponse(body, AbortSignal.any([signal, interrupt.signal])); }
          catch (error) {
            if (!interrupt.signal.aborted || signal.aborted) throw error;
            return interruptedResponse(responseObject(body, EMPTY_OUTPUT), []);
          }
        }, controller.signal, send, response => history.remember(body, response), options.heartbeatMs);
      } else {
        await relayUpstreamStream(body, ws.data.headers, controller.signal, interrupt.signal, (event) => live() && send(event), send, fetchUpstream);
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
      } else if (error instanceof UpstreamStatusError) {
        log.warn('failed', { cancelled: !live(), category: error.message });
        if (live()) send({ type: 'error', status: error.status, error: upstreamFailureBody(error.status, error.message, error.fields) });
      } else {
        const visible = errorPrefix(error, WS_VISIBLE);
        log.warn('failed', { cancelled: !live(), category: errorPrefix(error, WS_LOGGED) ?? 'internal', name: error instanceof Error ? error.name : typeof error });
        if (!live()) return;
        // Router-visible refusals are terminal (400). Anything else is an internal fault: 500 so Codex retries.
        send(visible
          ? { type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'invalid_request_error', message: visible } }
          : { type: 'error', status: 500, error: { type: 'server_error', code: 'server_error', message: INTERNAL_FAILURE } });
      }
    } finally {
      log.info('request-finished', { cancelled: !live() });
      ws.data.busy = false;
      ws.data.abort = undefined;
      ws.data.interrupt = undefined;
    }
  }

  /**
   * Streams a GPT turn back over the socket and records it for `previous_response_id`. The
   * upstream is HTTP or a native WebSocket adapted to SSE. An interrupt stops reading that
   * transport and finishes with completed items, discarding partial ones as native does.
   */
  async function relayUpstreamStream(
    body: ResponsesBody,
    headers: Headers,
    signal: AbortSignal,
    interrupt: AbortSignal,
    forward: (event: StreamEvent) => void,
    send: (event: unknown) => void,
    fetchUpstream: UpstreamFetch = upstreamFetch,
  ): Promise<void> {
    const { type: _type, previous_response_id: _previous, ...request } = body;
    const upstreamSignal = AbortSignal.any([signal, interrupt]);
    const idle = idleDeadline(upstreamSignal, timeoutMs);
    // An outage before OpenAI answers keeps the turn pending with progress frames (the socket is
    // already open, so nothing about the status line is lost); a real HTTP status still arrives below.
    let stop: (() => void) | undefined;
    let response: Response;
    try {
      response = watchBody(await connectUpstream(fetchUpstream, '/responses', jsonHeaders(headers), { ...request, stream: true }, idle, upstreamSignal, () => { stop ??= startHeartbeat(send, pendingEnvelope(body), options.heartbeatMs); }), idle);
    } finally { stop?.(); }
    if (!response.ok) {
      const { detail, fields } = await upstreamFailure(response);
      log.warn('upstream', { status: response.status, detail });
      // Native reads `headers` on a wrapped socket error (responses_websocket.rs) for rate-limit
      // windows, promo copy and request ids; forward the ones it parses.
      const relayed: Record<string, string> = {};
      response.headers.forEach((value, name) => { if (/^(x-codex-|x-request-id$|x-oai-request-id$|cf-ray$|x-openai-authorization-error$|x-error-json$)/i.test(name)) relayed[name] = value; });
      send({ type: 'error', status: response.status, error: upstreamFailureBody(response.status, `OpenAI returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`, fields), ...(Object.keys(relayed).length ? { headers: relayed } : {}) });
      return;
    }
    const items: OutputItem[] = [];
    const open = new Map<unknown, unknown>();
    let created: ResponseObject | undefined;
    try {
      await sseEvents(response, (event) => {
        if (event.type === 'response.created' && isRecord(event.response)) created = event.response as ResponseObject;
        if (event.type === 'response.output_item.added' && isRecord(event.item)) open.set(event.item.id, event.output_index);
        if (event.type === 'response.output_item.done' && isRecord(event.item)) { items.push(event.item as OutputItem); open.delete(event.item.id); }
        if (event.type === 'response.completed' && isRecord(event.response)) {
          const completed = event.response as ResponseObject;
          history.remember(body, { ...completed, output: completed.output?.length ? completed.output : items });
        }
        forward(event);
      });
    } catch (error) {
      if (!interrupt.aborted || signal.aborted || !created) throw error;
      idle.done();
      for (const [item_id, output_index] of open) forward({ type: 'response.output_item.interrupted', response_id: created.id, item_id, output_index });
      const stopped = interruptedResponse(created, items);
      history.remember(body, stopped);
      forward({ type: 'response.incomplete', response: stopped });
    }
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
      // Bun otherwise closes full-history replays above its 16 MiB default before our handler.
      maxPayloadLength: MAX_BODY_BYTES,
      message: handleSocketMessage,
      close(ws) {
        ws.data.abort?.abort();
        ws.data.upstream?.close();
      },
    },
  });
}
