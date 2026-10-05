// Builds the model catalog Codex shows in its picker: the native GPT rows from Codex's own
// models cache, followed by one row per subscription model. Run with `bun run catalog`.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CatalogModel } from './backends/contract';
import { BACKENDS } from './backends/registry';
import { loadConfig } from './config';
import { isRecord, type JsonRecord } from './json';
import { accountModels, validateAccountPrefix } from './router/account-upstream';

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
export type SecondaryCatalog = { cache: unknown; prefix: string; label: string; fastest?: boolean; models?: readonly string[] };
export function buildCatalog(nativeCache: unknown, secondary?: SecondaryCatalog, primaryStandard = false): { models: JsonRecord[] } {
  if (secondary) validateAccountPrefix(secondary.prefix);
  const native = isRecord(nativeCache) && Array.isArray(nativeCache.models) ? nativeCache.models.filter(isRecord) : [];
  const template = native.find((row) => row.visibility === 'list') ?? native[0];
  if (!template) throw new Error('Codex models cache has no models; open Codex once and retry');
  const local = BACKENDS.flatMap((backend) => backend.catalog);
  const localSlugs = new Set(local.map((model) => model.slug));
  const kept = native.filter((row) => typeof row.slug !== 'string' || (!localSlugs.has(row.slug) && (!secondary || !row.slug.startsWith(secondary.prefix + '-')))).map(row =>
    primaryStandard && typeof row.slug === 'string' && row.slug.startsWith('gpt-')
      ? { ...row, service_tiers: [], additional_speed_tiers: [], default_service_tier: 'default' } : row);
  const lastPriority = Math.max(0, ...kept.map((row) => (typeof row.priority === 'number' ? row.priority : 0)));
  const accountRows = secondary
    ? accountModels(secondary.cache, secondary.models).map((row, index) => ({
      ...row,
      slug: `${secondary.prefix}-${String(row.slug)}`,
      display_name: `${String(row.display_name)} (${secondary.label})`,
      description: `${String(row.description)} Through your ${secondary.label} Codex account.`,
      priority: lastPriority + local.length + index + 1,
      upgrade: null,
      availability_nux: null,
      ...(secondary.fastest ? { service_tiers: [], additional_speed_tiers: [] } : {}),
    })) : [];
  if (secondary && !accountRows.length) throw new Error('Secondary native model cache has no selected available GPT models; run bun run account-cache');
  return { models: [...kept, ...local.map((model, index) => catalogRow(template, model, lastPriority + index + 1)), ...accountRows] };
}

if (import.meta.main) {
  const config = loadConfig();
  const cache = JSON.parse(readFileSync(join(config.codexHome, 'models_cache.json'), 'utf8')) as unknown;
  mkdirSync(dirname(config.catalogFile), { recursive: true, mode: 0o700 });
  const secondary = config.secondaryAccount ? {
    cache: JSON.parse(readFileSync(join(config.secondaryAccount.home, 'models_cache.json'), 'utf8')) as unknown,
    prefix: config.secondaryAccount.prefix, label: config.secondaryLabel,
    fastest: config.secondaryAccount.fastest,
    models: config.secondaryAccount.models,
  } : undefined;
  writeFileSync(config.catalogFile, `${JSON.stringify(buildCatalog(cache, secondary, config.primaryStandard), null, 2)}\n`, { mode: 0o600 });
  chmodSync(config.catalogFile, 0o600);
  console.log(`Wrote ${config.catalogFile}`);
}
