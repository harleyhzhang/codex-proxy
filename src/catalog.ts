// Builds the model catalog Codex shows in its picker: the native GPT rows from Codex's own
// models cache, followed by one row per subscription model. Run with `bun run catalog`.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CatalogModel } from './backends/contract';
import { BACKENDS } from './backends/registry';
import { loadConfig } from './config';
import { isRecord, type JsonRecord } from './json';

/** GPT-only fields that would mislead Codex about a subscription model. */
const GPT_ONLY_FIELDS = [
  'model_messages',
  'service_tiers',
  'additional_speed_tiers',
  'availability_nux',
  'available_access_programs',
  'upgrade',
] as const;

const EFFORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems',
};

function catalogRow(template: JsonRecord, model: CatalogModel, priority: number): JsonRecord {
  const row: JsonRecord = { ...template };
  for (const field of GPT_ONLY_FIELDS) delete row[field];
  return {
    ...row,
    slug: model.slug,
    display_name: model.displayName,
    description: model.description,
    default_reasoning_level: model.defaultEffort,
    supported_reasoning_levels: model.efforts.map((effort) => ({
      effort,
      description: EFFORT_DESCRIPTIONS[effort] ?? effort,
    })),
    input_modalities: [...model.inputModalities],
    context_window: 200_000,
    visibility: 'list',
    priority,
  };
}

/** Appends every subscription model to Codex's native catalog, replacing stale local rows. */
export function buildCatalog(nativeCache: unknown): { models: JsonRecord[] } {
  const native = isRecord(nativeCache) && Array.isArray(nativeCache.models) ? nativeCache.models.filter(isRecord) : [];
  const template = native.find((row) => row.visibility === 'list') ?? native[0];
  if (!template) throw new Error('Codex models cache has no models; open Codex once and retry');
  const local = BACKENDS.flatMap((backend) => backend.catalog);
  const localSlugs = new Set(local.map((model) => model.slug));
  const kept = native.filter((row) => typeof row.slug !== 'string' || !localSlugs.has(row.slug));
  const lastPriority = Math.max(0, ...kept.map((row) => (typeof row.priority === 'number' ? row.priority : 0)));
  return { models: [...kept, ...local.map((model, index) => catalogRow(template, model, lastPriority + index + 1))] };
}

if (import.meta.main) {
  const config = loadConfig();
  const cache = JSON.parse(readFileSync(join(config.codexHome, 'models_cache.json'), 'utf8')) as unknown;
  mkdirSync(dirname(config.catalogFile), { recursive: true, mode: 0o700 });
  writeFileSync(config.catalogFile, `${JSON.stringify(buildCatalog(cache), null, 2)}\n`, { mode: 0o600 });
  chmodSync(config.catalogFile, 0o600);
  console.log(`Wrote ${config.catalogFile}`);
}
