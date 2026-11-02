// Logs are one JSON object per line. They never contain prompts, model output or credentials.

type LogFields = Record<string, unknown>;

export const log = {
  info(event: string, fields: LogFields = {}): void {
    console.log(JSON.stringify({ event, ...fields }));
  },
  warn(event: string, fields: LogFields = {}): void {
    console.warn(JSON.stringify({ event, ...fields }));
  },
};

/**
 * Logs scalar metadata, reducing strings to short word-like hints and dropping nested values.
 * This formatting does not redact unquoted private text: callers must use counts or fixed
 * categories rather than prompt/response content or freeform diagnostics.
 */
export function logSafe(event: string, fields: LogFields = {}): void {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    } else if (typeof value === 'string') {
      safe[key] = value
        .replace(/"[^"]*"|'[^']*'/g, '')
        .replace(/[^A-Za-z0-9 _.:()-]/g, '')
        .trim()
        .slice(0, 120);
    }
  }
  log.warn(event, safe);
}
