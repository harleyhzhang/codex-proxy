export type Env = Readonly<Record<string, string | undefined>>;

function integer(name: string, fallback: number, min: number, env: Env): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be a ${min > 0 ? 'positive' : 'non-negative'} integer`);
  return value;
}

/** A positive integer from the environment. Garbage fails loudly instead of becoming NaN. */
export function positiveInt(name: string, fallback: number, env: Env = process.env): number {
  return integer(name, fallback, 1, env);
}

/** Like `positiveInt`, for knobs where zero is meaningful (no retries, no delay). */
export function nonNegativeInt(name: string, fallback: number, env: Env = process.env): number {
  return integer(name, fallback, 0, env);
}
