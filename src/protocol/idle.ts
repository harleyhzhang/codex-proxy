import { cancelReader } from './stream';

/**
 * Native Codex bounds a stream by idle time, never by total length (codex-api sse/responses.rs
 * "idle timeout waiting for SSE"), so a long reasoning turn that keeps streaming is never cut.
 * The returned signal aborts with a TimeoutError once `ms` pass without upstream bytes; `touch`
 * restarts the window and `done` disarms it.
 */
export function idleDeadline(signal: AbortSignal, ms: number, message = 'idle timeout waiting for upstream') {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => { clearTimeout(timer); timer = undefined; signal.removeEventListener('abort', done); };
  const touch = () => {
    if (!signal.aborted && !controller.signal.aborted) timer?.refresh();
  };
  if (!signal.aborted) {
    timer = setTimeout(() => { done(); controller.abort(new DOMException(message, 'TimeoutError')); }, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  }
  return { signal: AbortSignal.any([signal, controller.signal]), touch, done };
}

type IdleWatch = { touch(): void; done(): void };
/** Owns the deadline through connection, body consumption, errors and cancellation. */
export function watchBody(response: Response, idle: IdleWatch): Response;
export function watchBody(response: Promise<Response>, idle: IdleWatch): Promise<Response>;
export function watchBody(response: Response | Promise<Response>, idle: IdleWatch): Response | Promise<Response> {
  if (!(response instanceof Response)) return response.then(value => watchBody(value, idle), error => { idle.done(); throw error; });
  if (!response.body) { idle.done(); return response; }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(out) {
      try {
        const next = await reader.read();
        if (next.done) { idle.done(); reader.releaseLock(); out.close(); }
        else { idle.touch(); out.enqueue(next.value); }
      } catch (error) { idle.done(); reader.releaseLock(); out.error(error); }
    },
    cancel(reason) { idle.done(); cancelReader(reader, reason); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

