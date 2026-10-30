# codex-subscription-proxy

Use Claude, Grok and optional Cursor models inside [OpenAI Codex](https://github.com/openai/codex), next to GPT, in the same chat.

The proxy sits between Codex and `chatgpt.com`. GPT requests pass straight through. Requests for a
Claude or Grok model are answered by the official `claude` or `grok` CLI, signed in with your own
subscription. Codex keeps running every tool, so approvals, sandboxing and history work as usual,
and you can switch models mid-chat. An optional pinned Cursor SDK bridge adds Kimi,
Grok and Claude models from a Cursor subscription without changing the Codex app.

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

GPT WebSocket clients keep their own upstream WebSocket, including Codex's
non-generating connection warmup. A continuation sends only new input when its
previous response and complete history prefix match the same connection.
Account, authorization or model changes start a new connection; a lost upstream
response earns one full-history replay before output is exposed. Unsupported
upgrades fall back to HTTP. HTTP clients continue to use HTTP. Set
`UPSTREAM_WEBSOCKET=0` to use the former HTTP relay for every client.

Secondary-account identity checks, token refresh and speed policies are shared
by both transports. Each client's connection and history stay separate.

### Network outages

A network outage is handled once, at the router level, for every backend: Claude (primary,
secondary and the quota fallback), Grok, Cursor, the GPT relay on HTTP and WebSocket, and GPT
or local compaction. When the network drops before anything has reached Codex, the router keeps
the same request pending, sends `response.in_progress` progress events every 10 seconds, and
retries with backoff from 1 to 30 seconds until the network returns or Codex cancels the turn.
The outage therefore never consumes Codex's own stream reconnect budget, so a long disconnect
does not end as "Reconnecting 5/5" and a dropped turn. Recovery preserves the original request
and tool receipts. Stop/cancel also stops the pending request and its retries.

Only transport failures qualify: reset or refused sockets, DNS failures, a subscription CLI
exiting with a network error, Cursor reporting `unavailable`. A plain (non-streaming) JSON
request cannot be held, so it still gets an immediate 503 with a generic "Network connection
interrupted" message. Timeouts are not outages: the per-turn model deadline stays terminal and
Codex owns that budget. The native GPT relay keeps its 4-retry burst first and only switches to
the pending loop once that burst fails on a reconnectable error. `OFFLINE_RETRY_BASE_MS`
shortens the first backoff step for test suites; production keeps 1 s.

Authentication, quota and validation errors still fail promptly. Known gap: the compaction
bridge used by `bridgeFor` still has only the finite native retry burst. Reload a running proxy
after updating its source.

## Compaction and task continuation

The router's summarization request is internal maintenance, not a new user task. Its tool-free,
summary-only instruction expires when the summary is returned. Restored summaries are assistant
history followed by a developer boundary directing the agent to resume the actual unfinished
request. This also applies to older capsules whose summaries mistakenly describe maintenance as
a user-requested pause. Actual user pauses, approval limits and newer requests still control.
Verbatim user anchors and tool receipts retain their existing preservation and capacity rules.

## Retries and errors versus native Codex

The router mirrors the native Codex client's retry and error policy wherever a request passes
through to ChatGPT, and adapts it where a subscription CLI is the model. Native source of truth:
`codex-rs/model-provider-info` (4 request retries, 200 ms doubling backoff, 5xx and transport
retried, 429 not), `codex-rs/codex-api/src/sse/responses.rs` (unparseable frames skipped,
`response.failed` codes classified) and `codex-rs/protocol/src/error.rs` (which errors retry).

| Situation | Native Codex | This router |
| --- | --- | --- |
| OpenAI 5xx (500/502/503/507…) | retried 4x, 200 ms doubling, ±10% jitter | same (`UPSTREAM_5XX_RETRIES`, `UPSTREAM_RETRY_BASE_MS`); covers turns, compaction and bridge calls |
| Dropped socket to OpenAI | retried 4x, then the stream reconnect budget (5) | same 4x burst, then streams and WebSocket turns stay pending with progress events and 1–30 s backoff until the network returns or Codex cancels; plain JSON gets a 503; timeouts are not retried (Codex owns that budget) |
| OpenAI 4xx incl. 429 | not retried, status surfaced | relayed once with the real status and body |
| Lasting 5xx | surfaced with real status | surfaced with real status as `server_error`, never masked as 400 |
| Unparseable SSE frame | skipped, stream continues | skipped (`sse-frame-skipped` log) |
| Stream ends without terminal event | retryable stream error | WebSocket: retryable `server_error`; HTTP: raw relay so Codex detects it |
| Upstream `response.failed` | classified by code | forwarded verbatim so Codex classifies it |
| Internal router/backend crash | retryable | `server_error` 500 on every transport; diagnostic never leaked |
| Malformed request body / unknown model | 400, not retried | 400, not retried |
| Subscription CLI refusal, auth, quota | n/a | terminal `invalid_prompt` with the backend's own message (a ChatGPT-shaped 429 would make Codex hide which model is capped) |
| Prompt over the model's context window | `context_length_exceeded`, not retried | a Claude, Grok or Cursor "prompt is too long" becomes the same native `context_length_exceeded` code, so Codex stops retrying and offers compaction |
| Provider overloaded | `server_is_overloaded`, not retried | a Claude or Grok overload (529) reported after the CLI's own retries becomes native `server_is_overloaded` instead of a retried 500 that reruns the whole CLI turn |
| Subscription CLI network drop (Claude, Grok, Cursor) | n/a | same pending loop as above; see Connection recovery |

`test/failure-matrix.test.ts` exercises every registered model row (GPT relay, personal and
secondary Claude, Cursor, Grok, the Opus quota fallback) against each row above on plain HTTP,
streaming HTTP and WebSocket.

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

`CATALOG_EFFORTS` pins reasoning effort per model, for example
`claude=medium,gpt=high,kimi=max,grok=max`. The first fragment found in a slug
wins; when that model lacks the effort, its strongest level is used, and
unmatched models keep their default. Every row then offers one effort, so the
Codex picker opens straight on the model list instead of the effort slider.

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

The picker adds **Kimi K3 (Work)**, **Grok 4.7 (Work)** and **Opus 5.5 via
Cursor (Work)**, with their own supported reasoning choices. Kimi is text-only
with a conservative 200K context cap; Grok supports images and 256K, and Opus
supports images and 1M. Reopen Codex after catalog changes.

Each request verifies the pinned executable and authenticated account, uses
credential-bound account/catalog discovery cached for five minutes, and
validates the exact model parameters. A bounded pool reuses local bridges;
each bridge runs only one request at a time. Fresh agents get a separate empty
working directory, an empty built-in tool list, no setting sources, no MCP and
no subagents. A validated tool call can retain its agent for the next tool
result, sending only the new history. Reuse requires matching model parameters,
instructions, tools and the complete model-visible history prefix. Changed
history, credentials or expired sessions start a fresh agent with full replay.
Codex tool calls are parsed and validated before returning any actions. Native
Cursor tool/compaction events, unsupported attachments, model substitutions,
partial output and failed streams are refused. Cancellation ends only that
request's exclusively leased bridge; cancelling a queued request leaves active
runs alone. Idle bridges and their stores are removed after two minutes by
default. Idle retained agents yield immediately when other work needs a bridge.
Cursor's SDK sandbox helper is unavailable in the tested standalone macOS build;
this adapter enforces no native actions through the tool list and event guard.
Codex's own execution sandbox and approvals still apply to returned calls.

The default pool holds at most eight bridges, bounding local process and memory
pressure during helper fan-out. `CURSOR_MAX_BRIDGES` tunes that bound. Set
`CURSOR_SESSION_REUSE=0` to keep bridge pooling but replay each agent in full,
or `CURSOR_BRIDGE_REUSE=0` to restore the former per-request process lifecycle.
Neither setting changes the selected model, reasoning effort, speed policy or
context limit. Content-free `cursor-turn` phase counters distinguish queue,
setup, generation and continuation reuse; `cursor-cleanup` reports cleanup
after validated output has been delivered.

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
| `UPSTREAM_WEBSOCKET` | `1` | Keep GPT WebSocket clients on native upstream WebSockets; `0` uses HTTP upstream |
| `CATALOG_EFFORTS` | unset | `fragment=effort` pins, e.g. `claude=medium,gpt=high`; one effort per row |
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
| `CLAUDE_IDENTITY_CACHE_MS` | `60000` | Reuse a verified identity while its local account binding is unchanged; `0` probes each fresh session |
| `CLAUDE_STANDBY_MAX` | `1` | Maximum unused prewarmed CLI per account; `0` disables prewarming |
| `CLAUDE_STANDBY_IDLE_MS` | `120000` | Lifetime of an unused prewarmed Claude CLI |
| `CURSOR_MAX_BRIDGES` | `8` | Resident Cursor bridge bound, including startup and cleanup; maximum `32` |
| `CURSOR_BRIDGE_IDLE_MS` | `120000` | Idle bridge lifetime, including any retained tool session |
| `CURSOR_SESSION_IDLE_MS` | `900000` | Maximum age of a retained Cursor tool session; bridge eviction can end it sooner |
| `CURSOR_BRIDGE_REUSE` | `1` | `0` restores one bridge process per request |
| `CURSOR_SESSION_REUSE` | `1` | `0` disables agent continuation while retaining bridge pooling |
| `GROK_BIN` | unset | Grok CLI path; Grok is disabled until set |
| `GROK_CWD` | unset | Empty working directory for Grok |
| `GROK_HOME` | `~/.grok` | Grok profile directory (use a dedicated one) |
| `GROK_TIMEOUT_MS` | `300000` | Grok stdout/stderr idle timeout, not a total reasoning deadline |
| `GROK_KILL_GRACE_MS` | `2000` | Grace before SIGKILL when a Grok process group ignores cancellation |
| `GROK_BIN_SHA256` | unset | Pause Grok if the binary changes |
| `GROK_PROFILE_SHA256` | unset | Pause Grok if its config, hooks or plugins change |

### Grok

The bridge disables Grok Build's native session search: it already supplies the
complete Codex conversation, so rebuilding an index of every stored CLI session
before each turn only adds work. Existing CLI history is preserved. Cancellation,
timeout and output overflow stop the request's whole process group, including
helpers that keep output pipes open. A rejected or expired subscription login is
terminal and explains how to sign in again using the same isolated `GROK_HOME`.

Use `[skills] ignore = ["~/.agents/skills"]` in that isolated profile if its
native personal skills should not supplement Codex's supplied instructions.
Review the profile and recompute its pin after changing this setting.
The profile pin covers nested hook/plugin files. Symlinks in those folders
pause the backend for review rather than allowing unverified target contents.

Valid JSON argument strings retain their exact semantics; malformed string
escapes can be repaired, and nested tool contracts are validated before any
action reaches Codex. Explicit new user rechecks and agent-wait polling are
not treated as stuck repeated reads. Cursor models can repair malformed output
in the same agent with a bounded correction budget. Authentication, native
action attempts, model changes and cancelled runs never use that repair path.

The CLI must receive `--verbatim`: Grok Build 1.0.46 otherwise replaces prompts
over roughly 100 KB with excerpts and an archive pointer, losing history and
tool contracts even below the model's context window. The bridge keeps the
full prompt in a private file and sends it without that offload.

Grok's native tool registry is emptied before generation. The bridge allows
the recognized `read_file` ID, explicitly denies that same ID, and denies the
`search_tool`/`use_tool` meta tools the CLI otherwise always retains. Unknown
allowlist placeholders fail open in this CLI and must not be used. The empty
finalized registry supplies both model definitions and dispatch handlers, so
native calls have no executable handler. Validate the active session's
`tool_definitions_count=0` after CLI upgrades before accepting a new binary pin.

Give Grok a dedicated `GROK_HOME` and pin `GROK_BIN_SHA256` and
`GROK_PROFILE_SHA256` so changes pause the backend for review. The optional
[`scripts/grok-deny-native.py`](scripts/grok-deny-native.py) hook is an extra
defense only when runtime loading is verified: 1.0.46 can list a user hook in
`inspect` while loading none in real sessions. The execution boundary does
not depend on that hook being present.

### Run at login (macOS)

Create `~/Library/LaunchAgents/codex-subscription-proxy.plist` with `ProgramArguments` set to
`bun /path/to/codex-subscription-proxy/src/main.ts`, `RunAtLoad` and `KeepAlive` set to true, then
`launchctl load` it. The process exits on unexpected errors so launchd restarts it cleanly.

## Security

- Listens on `127.0.0.1` only.
- Every request must carry the exact ChatGPT token Codex stored in `auth.json`. Requests with an
  `Origin` header (browsers) are rejected.
- Claude and Grok run with native execution tools and integrations disabled,
  with API keys stripped from their environment. Codex executes their returned calls.
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
