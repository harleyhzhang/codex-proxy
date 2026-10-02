// Library entry point for embedding the router or reusing its pieces.
export { buildCatalog } from './catalog';
export { type Config, loadConfig } from './config';
export type { CatalogModel, SubscriptionBackend } from './backends/contract';
export { BACKENDS, backendFor, isLocalModel } from './backends/registry';
export { SummaryCodec } from './router/capsule';
export { type RouterOptions, startRouter } from './router/server';
