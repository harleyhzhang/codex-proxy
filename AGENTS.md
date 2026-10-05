# AGENTS.md

Bun + TypeScript, strict mode, no runtime dependencies.

```
src/
  main.ts        entry point: config, key, startRouter
  config.ts      env → Config (env.ts holds the shared integer parser)
  catalog.ts     builds models.json from Codex's model cache + backend catalogs
  protocol/      Responses API types, prompt building, output and SSE
  backends/      contract.ts (SubscriptionBackend), claude.ts, grok.ts, registry.ts
  router/        server.ts (HTTP + WebSocket), auth, account-upstream, history, capsule, bridge, upstream
test/            bun test; support.ts has shared fixtures
scripts/         account-cache.ts (native secondary catalog), grok-deny-native.py (Grok PreToolUse hook)
```

Rules:

- Run `bun run check` before committing. It must pass with zero type errors.
- No `any`. Parse unknown input with `isRecord` and narrow.
- Never log prompt or response content; use `logSafe` with counts and sizes.
- A new backend implements `SubscriptionBackend` and is added to `BACKENDS` in `registry.ts`.
- CI is manual (`workflow_dispatch`) to save Actions minutes.
