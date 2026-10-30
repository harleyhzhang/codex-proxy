import { adaptRequest, BackendError } from '../backends/contract';
import { backendFor } from '../backends/registry';
import { logSafe } from '../log';
import { responseObject } from '../protocol/output';
import { validateRequest } from '../protocol/prompt';
import { EMPTY_OUTPUT, type ResponseObject, type ResponsesBody } from '../protocol/types';
import { reconnectTransport } from '../transport';

/**
 * Runs one turn on a subscription backend. Warmups (`generate: false`) are answered locally and
 * never start a billable generation.
 *
 * The offline policy lives here, once, for every backend: a subscription CLI or bridge that cannot
 * reach its provider reports a transport error, and because nothing has reached Codex yet the same
 * request is retried with 1-30 s backoff until the network returns or Codex cancels. Callers that
 * stream progress keep the client alive meanwhile (`pendingResponse`); the plain JSON path has no
 * channel for that, so it passes `reconnect: false` and fails like a native request would.
 */
export async function localResponse(body: ResponsesBody, signal?: AbortSignal, options: { reconnect?: boolean } = {}): Promise<ResponseObject> {
  const backend = backendFor(body.model);
  if (!backend) throw new BackendError('Unsupported model');
  if (body.generate === false) {
    prewarmLocal(body);
    return responseObject(body, EMPTY_OUTPUT);
  }
  const request = validateRequest(adaptRequest(body, backend));
  const attempt = () => backend.run(request, signal);
  const output = options.reconnect === false
    ? await attempt()
    : await reconnectTransport(attempt, signal, { onRetry: (attempts, delayMs) => logSafe('backend-offline-retry', { backend: backend.name, attempt: attempts, delay_ms: delayMs }) });
  return responseObject(body, output);
}

/** Lets the backend ready itself for the turn a warmup announces. Never generates and never fails the warmup. */
export function prewarmLocal(body: ResponsesBody): void {
  const backend = backendFor(body.model);
  if (!backend?.prewarm) return;
  try { backend.prewarm(validateRequest(adaptRequest(body, backend))); }
  catch { logSafe('prewarm-skipped', { backend: backend.name }); }
}
