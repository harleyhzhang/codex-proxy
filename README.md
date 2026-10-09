# codex-subscription-proxy

Use Claude, Grok and optional Cursor models inside [OpenAI Codex](https://github.com/openai/codex), next to GPT, in the same chat.

The proxy sits between Codex and `chatgpt.com`. GPT requests pass straight through. Requests for a
Claude or Grok model are answered by the official `claude` or `grok` CLI, signed in with your own
subscription. Codex keeps running every tool, so approvals, sandboxing and history work as usual,
and you can switch models mid-chat. An optional pinned Cursor SDK bridge adds Kimi,
Grok and GPT models from a Cursor subscription without changing the Codex app.

```
Codex ──► 127.0.0.1:3468 ──┬──► chatgpt.com          (GPT models)
                           ├──► claude CLI           (claude-*)
                           ├──► grok CLI             (grok-*)
                           └──► Cursor SDK bridge    (cursor-*, optional)
```

## Requirements

- [Bun](https://bun.sh) 1.2+
- Codex (desktop app or CLI), signed in with ChatGPT
- For Claude: the [Claude Code](https://docs.anthropic.com/claude-code) CLI, signed in (`claude login`)
- For Grok (optional): the Grok Build CLI, signed in

## Quick start

```sh
git clone https://github.com/harleyhzhang/codex-proxy
cd codex-proxy
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

## Connection recovery

Claude requests stay pending through temporary connection failures. The proxy retries with
backoff from 1 to 30 seconds and sends progress events every 10 seconds, so an outage does not
consume Codex's stream reconnect budget. Recovery preserves the original request and tool
receipts. Stop/cancel also stops the pending request and retries.

Authentication, quota and validation errors still fail promptly. The per-turn model deadline
remains separate from connection timeouts. GPT stream failures continue through Codex's own
reconnect path; this change applies to buffered Claude requests. Reload a running proxy after
updating its source.

## Optional second Codex account

Add an isolated native Codex login alongside the primary account. The router
discovers available GPT models from that profile's native catalog; labels and
namespaces are configurable. Existing installations keep their current behavior
unless these options are enabled.

```sh
export ACCOUNT_CODEX_HOME="$HOME/.codex-secondary"
export ACCOUNT_CODEX_BINARY=codex
export ACCOUNT_MODEL_PREFIX=secondary
export ACCOUNT_LABEL=Secondary

CODEX_HOME="$ACCOUNT_CODEX_HOME" codex -c 'cli_auth_credentials_store="file"' login
bun run account-cache  # reads the native model list; starts no model generation
bun run catalog
bun start
```

Keep these variables set for both catalog generation and the router. Reopen Codex
to load the new picker rows. For example, `secondary-gpt-6-astra` appears with a
`(Secondary)` label. To expose only selected models, set `ACCOUNT_MODELS` to a
comma-separated list of native slugs. Optional `ACCOUNT_EXPECTED_EMAIL` and
`ACCOUNT_EXPECTED_WORKSPACE` pin the intended identity and workspace. The secondary
profile must differ from the primary `CODEX_HOME` and use file-based credentials.

Speed policies are independently opt-in:

- `ACCOUNT_SPEED_POLICY=fastest` selects Ultrafast, Fast, or Standard according to
  the secondary profile's cached model entitlements.
- `PRIMARY_SPEED_POLICY=standard` fixes primary GPT response requests to Standard,
  even when a prior model left a Fast/Ultrafast selection. It works without a second
  account, too.
- Omit either policy, or set it to `client`, to preserve the client's selected tier.

Fixed policies hide the corresponding speed controls during catalog generation;
reasoning settings remain available. Re-run `bun run account-cache` and
`bun run catalog` when secondary model availability changes. See
[.env.example](.env.example) for optional settings.

Only namespaced response-model calls use the secondary account. Native search/image
passthrough endpoints retain primary-account routing. Native Codex owns token refresh
in the isolated profile. Missing/mismatched auth or an unavailable secondary model
fails without falling back to primary usage. Neither profile's credentials belong
in this repository.

### A second Claude subscription

Keep the second Claude login in a separate configuration directory. The same CLI
binary can serve both accounts; a second desktop app is unnecessary.

```sh
export CLAUDE_ACCOUNT_CONFIG_DIR="$HOME/.claude-secondary"
export CLAUDE_ACCOUNT_MODEL_PREFIX=secondary
export CLAUDE_ACCOUNT_LABEL=Secondary
mkdir -p "$CLAUDE_ACCOUNT_CONFIG_DIR"
chmod 700 "$CLAUDE_ACCOUNT_CONFIG_DIR"
CLAUDE_CONFIG_DIR="$CLAUDE_ACCOUNT_CONFIG_DIR" claude auth login --claudeai
CLAUDE_CONFIG_DIR="$CLAUDE_ACCOUNT_CONFIG_DIR" claude auth status
bun run catalog
bun start
```

Keep these variables set for both catalog generation and the router, then reopen
Codex. The picker adds **Opus 5.5 (Secondary)** and **Fable 5.1 (Secondary)** while
preserving the primary entries. Each account has its own subprocess environment,
warm tool continuations and persisted quota snapshot. Switching accounts replays
the shared Codex history to the selected account. A failed login or exhausted
account never falls back to the other Claude subscription. The optional Cursor
quota policy below applies only to secondary Opus when explicitly enabled.

Only enable models that the second subscription can use. `CLAUDE_ACCOUNT_MODELS`
optionally selects a comma-separated subset of `claude-opus-5-5,claude-fable-5-1`.
`CLAUDE_ACCOUNT_EXPECTED_EMAIL` and `CLAUDE_ACCOUNT_EXPECTED_ORG` can pin the
identity returned by `auth status`; they are checked before starting each new
worker. The second profile must differ from the primary `CLAUDE_CONFIG_DIR`
(or `~/.claude`), including through symlinks. These options are independent of
the optional second native Codex account and disabled by default.

## Optional Cursor subscription

Use the official [SDK bridge](https://github.com/cursor/sdk-bridge), pinned to
**v1.0.37**. Verify the archive against that release's `SHA256SUMS.txt`, unpack it
outside this repository, and hash `bin/cursor-sdk-bridge`. The proxy itself keeps
zero runtime package dependencies. The ordinary Cursor CLI remains separate:
its print mode exposes native tools and is not used for this adapter.

Authenticate with the official [SDK browser login](https://cursor.com/docs/sdk/typescript#cursorauth).
For this one-time login, install `@cursor/sdk@1.0.37` in a separate setup directory
and run a script there:

```ts
import { Cursor, FileCredentialStore } from '@cursor/sdk';
const login = await Cursor.auth.login({
  apiKeyName: 'Codex model router',
  store: new FileCredentialStore('/absolute/private/path/cursor-auth.json'),
});
const user = await Cursor.me({apiKey: login.apiKey});
console.log({email: user.userEmail, userId: user.userId}); // never print login.apiKey
```

This mints an expiring user API key (90 days by default); it does not read or
extract the desktop/CLI OAuth token. Keep the credential JSON owner-only and
outside Git. The SDK login is independent of standalone CLI login changes.
Renew it with the same official flow when it expires.

Set these variables for both the catalog and router, supplying your own account
pins. `Cursor.me()` / the bridge's `Me` returns the stable user ID:

```sh
export CURSOR_BRIDGE_BIN=/absolute/path/bin/cursor-sdk-bridge
export CURSOR_BRIDGE_SHA256="$(shasum -a 256 "$CURSOR_BRIDGE_BIN" | cut -d ' ' -f 1)"
export CURSOR_AUTH_FILE=/absolute/private/path/cursor-auth.json
export CURSOR_CWD=/absolute/private/path/empty-requests
export CURSOR_EXPECTED_EMAIL=account@example.com
export CURSOR_EXPECTED_USER_ID="your-user-id"
export CURSOR_MODEL_PREFIX=cursor
export CURSOR_LABEL=Work
# Optional: use the fastest available Cursor variants. Kimi has no Fast variant.
export CURSOR_SPEED_POLICY=fastest
mkdir -p "$CURSOR_CWD"
chmod 700 "$CURSOR_CWD"
bun run catalog
bun start
```

The picker adds **Kimi K3 (Work)**, **Grok 4.7 (Work)** and
**GPT-5.6 Sol (Work)**, with their own supported reasoning choices. Entries are
text-only with a conservative 200K catalog cap. GPT-5.6 Sol is a separate model;
it is not a fallback alias for GPT-6.1. Reopen Codex after catalog changes.

Each request verifies the pinned executable and authenticated account, uses credential-bound account/catalog discovery cached for five minutes,
validates the exact model parameters, and starts a new private local agent
with an empty built-in tool list, no setting sources, no MCP and no subagents.
Codex tool calls are parsed and validated before returning any actions. Native
Cursor tool/compaction events, unsupported attachments, model substitutions,
partial output and failed streams are refused. Cancellation ends only that
request's dedicated bridge. The temporary agent store is removed on every exit.
Cursor's SDK sandbox helper is unavailable in the tested standalone macOS build;
this adapter enforces no native actions through the tool list and event guard.
Codex's own execution sandbox and approvals still apply to returned calls.

To enable **secondary Opus only → Cursor Opus** on a typed Claude quota refusal:

```sh
export CURSOR_CLAUDE_ACCOUNT_FALLBACK=1
```

Both the secondary Claude account and Cursor must be configured. Primary Opus
stays on its own account, and secondary Fable does not fall back. Auth/network
errors, timeouts, cancellation and malformed output never select Cursor. The
fallback preserves the full verified history and effort, selects the same Opus
model, and adds a supplier notice. Later requests return to direct Claude once
its known quota gate expires. Cursor refusals stop the turn; there is no further
supplier chain. This policy consumes the Cursor account's existing allowance
and obeys its server-side billing limits; it does not establish an included-only
billing guarantee or change spending settings.

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
| `ACCOUNT_CODEX_HOME` | unset | Isolated secondary native Codex profile; enables account aliases |
| `ACCOUNT_CODEX_BINARY` | `codex` | Native Codex executable for cache retrieval and token renewal |
| `ACCOUNT_MODEL_PREFIX` | `secondary` | Distinct lowercase namespace for secondary model aliases |
| `ACCOUNT_LABEL` | `Secondary` | Suffix displayed in the model picker |
| `ACCOUNT_MODELS` | unset | Optional comma-separated native-model allowlist |
| `ACCOUNT_EXPECTED_EMAIL` | unset | Optional secondary login identity pin |
| `ACCOUNT_EXPECTED_WORKSPACE` | unset | Optional secondary workspace pin |
| `ACCOUNT_SPEED_POLICY` | `client` | `client` preserves selection; `fastest` fixes the fastest cached tier |
| `PRIMARY_SPEED_POLICY` | `client` | `client` preserves selection; `standard` fixes primary GPT to Standard |
| `CLAUDE_BIN` | `claude` | Claude CLI path |
| `CLAUDE_CONFIG_DIR` | CLI default | Primary Claude login/configuration directory |
| `CLAUDE_EXPECTED_EMAIL`, `CLAUDE_EXPECTED_ORG` | unset | Optional primary Claude identity pins |
| `CLAUDE_ACCOUNT_CONFIG_DIR` | unset | Enables a separate second Claude login |
| `CLAUDE_ACCOUNT_MODEL_PREFIX` | `secondary` | Prefix for second-account Claude slugs |
| `CLAUDE_ACCOUNT_LABEL` | `Secondary` | Picker label for the second Claude account |
| `CLAUDE_ACCOUNT_MODELS` | both supported Claude models | Optional second-account model subset |
| `CLAUDE_ACCOUNT_BIN`, `CLAUDE_ACCOUNT_CWD` | primary CLI settings | Optional second-account binary and working directory |
| `CLAUDE_ACCOUNT_EXPECTED_EMAIL`, `CLAUDE_ACCOUNT_EXPECTED_ORG` | unset | Optional second Claude identity pins |
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
- Cursor uses its separately stored SDK credential and the no-native-tools policy described above.
- Logs record event names, sizes and counts, never prompt or response content.
- Compaction capsules for Claude/Grok chats are sealed with AES-256-GCM using a local key.

## Development

```sh
bun run check     # typecheck + tests
```

See [AGENTS.md](AGENTS.md) for the layout.

## Disclaimer

Unofficial and not affiliated with OpenAI, Anthropic, xAI or Cursor. It drives official CLIs
and the optional official Cursor SDK bridge with your own accounts; you are responsible for following each provider's terms.

## License

[MIT](LICENSE)
