export type Env = Readonly<Record<string, string | undefined>>;

/** A positive integer from the environment. Garbage fails loudly instead of becoming NaN. */
export function positiveInt(name: string, fallback: number, env: Env = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
