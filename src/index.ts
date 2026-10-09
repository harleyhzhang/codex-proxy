// Library entry point for embedding the router or reusing its pieces.
export { buildCatalog, type SecondaryCatalog } from './catalog';
export { type Config, loadConfig } from './config';
export type { CatalogModel, SubscriptionBackend } from './backends/contract';
export { BACKENDS, backendFor, isLocalModel } from './backends/registry';
export { SummaryCodec } from './router/capsule';
export { type RouterOptions, startRouter } from './router/server';
export { AccountUpstream, type AccountOptions, accountModels, nativeAccountRequest, standardPrimaryFetch } from './router/account-upstream';
export { ClaudeAccount, createClaudeAccountBackend, configuredClaudeAccount, type ClaudeAccountOptions, type SecondaryClaudeOptions } from './backends/claude';
export { createCursorBackend, configuredCursorBackend, type CursorOptions } from './backends/cursor';
export { withOpusQuotaFallback } from './backends/quota-fallback';
