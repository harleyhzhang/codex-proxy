# codex-subscription-proxy

Use Claude and Grok inside [OpenAI Codex](https://github.com/openai/codex), next to GPT, in the same chat.

The proxy sits between Codex and `chatgpt.com`. GPT requests pass straight through. Requests for a
Claude or Grok model are answered by the official `claude` or `grok` CLI, signed in with your own
subscription. Codex keeps running every tool, so approvals, sandboxing and history work as usual,
and you can switch models mid-chat.

```
Codex ──► 127.0.0.1:3468 ──┬──► chatgpt.com          (GPT models)
                           ├──► claude CLI           (claude-*)
                           └──► grok CLI             (grok-*)
```

## Requirements

- [Bun](https://bun.sh) 1.2+
- Codex (desktop app or CLI), signed in with ChatGPT
- For Claude: the [Claude Code](https://docs.anthropic.com/claude-code) CLI, signed in (`claude login`)
- For Grok (optional): the Grok Build CLI, signed in

## Quick start

```sh
git clone https://github.com/harleyhzhang/codex-subscription-proxy
cd codex-subscription-proxy
bun install
bun run catalog   # writes ~/.codex-subscription-proxy/models.json
bun start         # listens on http://127.0.0.1:3468
```

Then point Codex at it in `~/.codex/config.toml`:

```toml
openai_base_url = "http://127.0.0.1:3468/v1"
model_catalog_json = "/Users/you/.codex-subscription-proxy/models.json"  # absolute path
```

Restart Codex. Claude and Grok now appear in the model picker. Re-run `bun run catalog` after
Codex updates its own model list.

## Configuration

Everything has a default; set only what you need.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3468` | Loopback port |
| `CODEX_HOME` | `~/.codex` | Where Codex keeps `auth.json` and `models_cache.json` |
| `PROXY_STATE_DIR` | `~/.codex-subscription-proxy` | Catalog and summary key |
| `CATALOG_FILE` | `$PROXY_STATE_DIR/models.json` | Model catalog served to Codex |
| `SUMMARY_KEY_FILE` | `$PROXY_STATE_DIR/summary.key` | 32-byte key for compaction capsules, created on first start |
| `UPSTREAM_TIMEOUT_MS` | `900000` | Timeout for requests to `chatgpt.com` |
| `BRIDGE_MODELS` | `gpt-6.1-sol,gpt-6-sol,gpt-6-astra` | GPT models allowed to summarise Claude/Grok history |
| `CLAUDE_BIN` | `claude` | Claude CLI path |
| `CLAUDE_CWD` | current directory | Working directory for the Claude CLI |
| `CLAUDE_TIMEOUT_MS` | `900000` | Per-turn Claude timeout |
| `CLAUDE_SESSION_IDLE_MS` | `900000` | How long an idle Claude session stays warm |
| `GROK_BIN` | unset | Grok CLI path; Grok is disabled until set |
| `GROK_CWD` | unset | Empty working directory for Grok |
| `GROK_HOME` | `~/.grok` | Grok profile directory (use a dedicated one) |
| `GROK_TIMEOUT_MS` | `900000` | Per-turn Grok timeout |
| `GROK_BIN_SHA256` | unset | Pause Grok if the binary changes |
| `GROK_PROFILE_SHA256` | unset | Pause Grok if its config, hooks or plugins change |

### Grok

Grok Build has its own tools. The proxy hides them and tells Grok that Codex owns execution, but
the real boundary is a `PreToolUse` hook that denies every native call. Give Grok a dedicated
`GROK_HOME`, register [`scripts/grok-deny-native.py`](scripts/grok-deny-native.py) as its
`PreToolUse` hook, and pin `GROK_BIN_SHA256` and `GROK_PROFILE_SHA256` so any later change pauses
the backend instead of running unreviewed.

### Run at login (macOS)

Create `~/Library/LaunchAgents/codex-subscription-proxy.plist` with `ProgramArguments` set to
`bun /path/to/codex-subscription-proxy/src/main.ts`, `RunAtLoad` and `KeepAlive` set to true, then
`launchctl load` it. The process exits on unexpected errors so launchd restarts it cleanly.

## Security

- Listens on `127.0.0.1` only.
- Every request must carry the exact ChatGPT token Codex stored in `auth.json`. Requests with an
  `Origin` header (browsers) are rejected.
- Claude and Grok run with their own tools, MCP servers, hooks and plugins disabled, and with API
  keys stripped from their environment, so they can only answer through Codex.
- Logs record event names, sizes and counts, never prompt or response content.
- Compaction capsules for Claude/Grok chats are sealed with AES-256-GCM using a local key.

## Development

```sh
bun run check     # typecheck + tests
```

See [AGENTS.md](AGENTS.md) for the layout.

## Disclaimer

Unofficial and not affiliated with OpenAI, Anthropic or xAI. It only drives the official CLIs
with your own accounts; you are responsible for following each provider's terms.

## License

[MIT](LICENSE)
