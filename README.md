# codex-subscription-proxy

Use Claude, Grok and optional Cursor models inside [OpenAI Codex](https://github.com/openai/codex), next to GPT, in the same chat.

The proxy sits between Codex and `chatgpt.com`. GPT requests pass straight through. Requests for a
Claude model go to Anthropic's Messages API and Grok requests to xAI's Grok endpoint, each signed in
with your own subscription's login; no CLI runs per turn. Claude, Grok and Cursor make real tool calls,
and their text and each finished tool call stream into Codex as they are written, so Codex starts a
tool while the model writes the next. Grok's and Cursor models' thinking streams too (Claude's thinking
text is omitted by Anthropic unless asked for, and asking delayed its first answer text). Codex keeps running every tool, so approvals, sandboxing and
history work as usual, and you can switch models mid-chat. An optional Cursor login, through Cursor's own SDK, adds Kimi,
Grok and Claude models from a Cursor subscription without changing the Codex app.

```
Codex ──► 127.0.0.1:3468 ──┬──► chatgpt.com          (GPT models)
                           ├──► Anthropic Messages   (claude-*)
                           ├──► xAI Grok endpoint    (grok-*)
                           └──► Cursor agent API     (cursor-*, optional, via @cursor/sdk)
```

## Requirements

- [Bun](https://bun.sh) 1.4.2+ (including streaming Zstd decoding)
- Codex (desktop app or CLI), signed in with ChatGPT
- For Claude: a Claude subscription login from the [Claude Code](https://docs.anthropic.com/claude-code) CLI (`claude auth login`); the CLI is not run afterwards
- For Grok (optional): a SuperGrok login from the Grok Build CLI (`grok login`); the CLI is not run afterwards

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

## Updating

```sh
cd codex-proxy
bun run update
```

That one command pulls the latest code, installs dependencies, rebuilds the model catalog (with your
service's own settings), restarts the launchd service that runs this checkout and waits until it
answers. Without a launchd service it tells you to restart `bun start` yourself: new code only runs
after a restart. Existing chats keep working, and nothing in Codex's config changes. Quit and reopen
Codex only when it says the model list changed. Run it again after Codex itself updates, so new GPT
models appear.

## Connection recovery

GPT WebSocket clients keep their own upstream WebSocket, including Codex's
non-generating connection warmup. A continuation sends only new input when its
previous response and complete history prefix match the same connection.
Account, authorization or model changes start a new connection; a lost upstream
response earns one full-history replay before output is exposed. Unsupported
upgrades fall back to HTTP. HTTP clients continue to use HTTP.

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

Only transport failures qualify: reset or refused sockets, DNS failures, a Claude or Grok stream
that ends before its terminal event, Cursor reporting `unavailable`. Once text has streamed into
Codex the request is never replayed; a drop after that fails the turn as a retryable error.
A plain (non-streaming) JSON request cannot be held, so it still gets an immediate 503 with a
generic "Network connection
interrupted" message. Timeouts are not outages: the per-turn model deadline stays terminal and
Codex owns that budget. The native GPT relay keeps its 4-retry burst first and only switches to
the pending loop once that burst fails on a reconnectable error. `OFFLINE_RETRY_BASE_MS`
shortens the first backoff step for test suites; production keeps 1 s.

Authentication, quota and validation errors still fail promptly. Known gap: the compaction
bridge used by `bridgeFor` still has only the finite native retry burst. Reload a running proxy
after updating its source.

### Model capacity

GPT capacity errors (`server_is_overloaded`) get one recovery window of up to 120 seconds,
on HTTP, SSE, native WebSockets and compaction. The router retries the same model/account
and request with jittered 1–15 second backoff, honoring `Retry-After` without shortening it.
A hint beyond the remaining window ends recovery instead of retrying early. Ordinary
5xx, quota, authentication, context and policy errors keep their existing handling.

Recovery discards empty scaffolding from failed attempts. Once retrying, it exposes one stable
response id and progress events, so Stop still works during backoff. Successful item/call ids
and all prior tool receipts are preserved. The next native WebSocket continuation may replay
full history once because the logical recovery id differs from the upstream connection id.
The router never replays an inference after exposing text, reasoning or a tool event; unknown
events and more than 1 MiB of buffered metadata also commit the current attempt. A lasting
overload keeps its native classification. No automatic model/account fallback is enabled.

## Compaction and task continuation

The router's summarization request is internal maintenance, not a new user task. Its tool-free,
summary-only instruction expires when the summary is returned. Restored summaries are assistant
history followed by a developer boundary directing the agent to resume the actual unfinished
request. This also applies to older capsules whose summaries mistakenly describe maintenance as
a user-requested pause. Actual user pauses, approval limits and newer requests still control.
Verbatim user anchors and tool receipts retain their existing preservation and capacity rules.

## Retries and errors versus native Codex

The router mirrors the native Codex client's retry and error policy wherever a request passes
through to ChatGPT, and adapts it where a subscription backend is the model. Native source of truth:
`codex-rs/model-provider-info` (4 request retries, 200 ms doubling backoff, 5xx and transport
retried, 429 not), `codex-rs/codex-api/src/sse/responses.rs` (unparseable frames skipped,
`response.failed` codes classified) and `codex-rs/protocol/src/error.rs` (which errors retry).

| Situation | Native Codex | This router |
| --- | --- | --- |
| OpenAI 5xx (500/502/503/507…) | retried 4x, 200 ms doubling, ±10% jitter | same (`UPSTREAM_5XX_RETRIES`, `UPSTREAM_RETRY_BASE_MS`); explicit capacity errors use the separate recovery window below |
| Dropped socket to OpenAI | retried 4x, then the stream reconnect budget (5) | same 4x burst, then streams and WebSocket turns stay pending with progress events and 1–30 s backoff until the network returns or Codex cancels; plain JSON gets a 503; timeouts are not retried (Codex owns that budget) |
| OpenAI 4xx incl. 429 | not retried, status surfaced | relayed once with the real status and body |
| Lasting 5xx | surfaced with real status | surfaced with real status as `server_error`, never masked as 400 |
| Unparseable SSE frame | skipped, stream continues | skipped (`sse-frame-skipped` log) |
| Stream ends without terminal event | retryable stream error | WebSocket: retryable `server_error`; HTTP: raw relay so Codex detects it |
| Upstream `response.failed` | classified by code | capacity before exposed output gets the same-model recovery window; other failures and exhausted recovery preserve native classification |
| GPT capacity / overload | `server_is_overloaded`, not retried | up to 120 s of cancellable same-model/account recovery before output; honors `Retry-After`, sends progress, retains prior tool receipts |
| Internal router/backend crash | retryable | `server_error` 500 on every transport; diagnostic never leaked |
| Malformed request body / unknown model | 400, not retried | 400, not retried |
| Subscription refusal, auth, quota | n/a | terminal `invalid_prompt` with the backend's own message (a ChatGPT-shaped 429 would make Codex hide which model is capped) |
| Prompt over the model's context window | `context_length_exceeded`, not retried | a Claude, Grok or Cursor "prompt is too long" becomes the same native `context_length_exceeded` code, so Codex stops retrying and offers compaction |
| Provider 5xx (Claude, Grok) | retried 4x, 200 ms doubling | at most five HTTP attempts per router request, shared with fresh stream retries; jittered backoff honors bounded `Retry-After` hints; exhaustion is terminal so native retries do not multiply the budget |
| Provider overloaded | `server_is_overloaded`, not retried | a Claude or Grok overload (529) that outlasts that burst becomes native `server_is_overloaded` |
| Subscription network drop (Claude, Grok, Cursor) | n/a | same pending loop as above; see Connection recovery |

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

Keep the second Claude login in a separate configuration directory. The CLI is only
used to sign in; a second desktop app is unnecessary.

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
preserving the primary entries. Each account has its own login, token refresh and
persisted quota snapshot. Switching accounts replays
the shared Codex history to the selected account. A failed login or exhausted
account never falls back to the other Claude subscription. The optional Cursor
quota policy below applies only to secondary Opus when explicitly enabled.

Only enable models that the second subscription can use. `CLAUDE_ACCOUNT_MODELS`
optionally selects a comma-separated subset of `claude-opus-5-5,claude-fable-5-1,claude-fable-5-2`.
`CLAUDE_ACCOUNT_REASONING_EFFORT=medium` fixes both the account's requests and
picker rows at medium, including when a saved chat requests another effort.
`CLAUDE_ACCOUNT_SPEED_POLICY=fastest` requests `speed: "fast"` for Fable 5.2
and Opus 5.5. Other accounts keep their existing speed and effort settings.
Fast mode requires the organization's fast-mode and usage-credit access; it
uses credits outside the included subscription limits. The proxy does not
enable billing or change organization settings.
`CLAUDE_ACCOUNT_EXPECTED_EMAIL` and `CLAUDE_ACCOUNT_EXPECTED_ORG` can pin the
identity Anthropic reports for the login; they are checked once per access token,
before its first turn. The second profile must differ from the primary `CLAUDE_CONFIG_DIR`
(or `~/.claude`), including through symlinks. These options are independent of
the optional second native Codex account and disabled by default.

## Optional Cursor subscription

Cursor turns go through Cursor's own TypeScript SDK (`@cursor/sdk`, pinned in `bun.lock`), run inside
the router, so each turn calls Cursor's agent API directly with no helper process in between. Install
dependencies with `bun install`. The ordinary Cursor CLI is not used.

If a Cursor model emits internal `CallDynamicTool` serialization as assistant text, the router
blocks it before it reaches Codex, including when its marker is split across streamed tokens.
It retries once if nothing has streamed and no real tool call was made; otherwise it reports
the malformed output without replaying actions. Printed markup is never executed as a tool.

Authenticate with the official [SDK browser login](https://cursor.com/docs/sdk/typescript#cursorauth).
Run this once from the repository:

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
pins. `Cursor.me()` returns the stable user ID:

```sh
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

The picker adds **Kimi K3 (Work)**, **Grok 4.7 (Work)**, **Opus 5.5 via
Cursor (Work)** and **Muse Wonder (Work)**, with their own supported reasoning
choices. Kimi is text-only with a conservative 200K context cap; Grok supports
images and 256K, Opus images and 1M, and Muse Wonder images and 300K. Reopen
Codex after catalog changes.

Each request verifies the authenticated account with credential-bound account/catalog discovery
cached for five minutes, and validates the exact model parameters. An agent is created ahead of each
turn (and when a chat opens), so a turn starts by sending; each turn names its model and tools when
it sends. Every agent has its own working directory, an empty in-memory file tree, no setting
sources and no subagents; its directory and Cursor's transcript folder for it are deleted when it ends.

Codex's client tools are registered as SDK custom tools (`customTools`) whose callbacks run in the
router. The model calls them as real tool calls; each call is handed to Codex as an ordinary
`function_call`/`custom_tool_call` the moment the model makes it, so Codex starts running it while
the model may still be writing the next one, and the callback is held. When Codex's next request
carries the results, the held callbacks are answered and the same Cursor run continues: no new agent,
no re-prompt and nothing parsed out of model text. Calls written within `CURSOR_TOOL_SETTLE_MS` (25
ms) of each other end the turn together as one parallel step. The agent's allowed tools are only the
`mcp` group and its only tools are Codex's, so it has no shell, edit, read, web or subagent tool; any
other tool event stops the turn. Function arguments that miss a required field or break the schema
go back to the model to fix and never reach Codex. Tool results keep inline images. Text and the
model's thinking stream into Codex as they are written.

A run continues only when its model parameters, instructions, tools, credential and complete
model-visible history prefix are unchanged and the request answers exactly the held calls; anything
else (a user message mid-run, a tool search, a rotated login) cancels it and replays the history in a
fresh agent. A run waiting on Codex is held up to `CURSOR_SESSION_IDLE_MS`; past
`CURSOR_MAX_HELD_RUNS` (16) waiting runs, the one waiting longest is cancelled and replays if
continued later. Cursor summarizing its own context is reported as a context overflow so Codex
compacts instead. Unsupported attachments, model substitutions and failed runs are refused with
Cursor's own reason; a network failure is an outage like any other. Codex's own execution sandbox
and approvals still apply to returned calls. Content-free `cursor-turn` counters record setup time,
continuation and call counts.

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

## Resource bounds and response fidelity

Each configured account admits up to eight active model turns and queues at most 64 more.
Tool-result continuations take priority over fresh turns. Queued turns can be cancelled; a full
queue reports overload. Cursor releases its active permit when it yields tools, so a held callback
never blocks its own continuation. Native GPT's permit lasts until its response body ends or is
cancelled, and primary and secondary accounts have separate gates. These limits bound local work;
they do not change provider quota or billing settings.

History retention conservatively charges each entry's complete input and output toward a 512-MiB
payload allowance (512 entries, 12-hour expiry with idle sweeps). Shared immutable items are charged
once until their last owner is evicted; independent replays and each entry's reference arrays pay
their own charge. An evicted continuation
asks Codex to resend the full history. Cursor's continuation signature uses the actual streamed
message/tool order, including text between parallel calls, rather than rearranging it on replay.

SSE and WebSocket outgoing buffers are bounded by bytes. A client that cannot consume output within
the allowance is explicitly disconnected and its generation cancelled; executable events are never
silently discarded. Direct Claude screenshot fitting runs asynchronously, with two conversions at
once, shared in-flight work and a byte-bounded LRU. Cancelling every waiter stops the conversion.

Provider output limits/refusals retain incomplete status and details. Claude reaching its context
window reports native `context_length_exceeded`; a paused turn retains `end_turn: false`. Useful
partial compaction summaries still follow the existing compaction policy. Real cache-read and
available reasoning-token counts reach Codex. Content-free diagnostics include `first_useful_ms`
(text or a completed tool call), `request-normalized`, `provider-admission` queue time,
`provider-retry` attempts/delays, and structured `cursor-replay` reasons. Missing timing is null,
not a zero-duration text sample from a tool-only turn. No prompt or response content is recorded.

Foreign history restoration is cached only after an explicitly completed response. Failed,
incomplete or dropped streams never create a reusable summary. Older unchecked cache files are
ignored and restored once under this policy. Concurrent restorations share upstream work;
cancelling the last waiter aborts it, while cancelling one waiter leaves others running.

Claude and Grok preserve explicit parallel-call restrictions, named/required tool choice and
output-token limits in their provider requests. Cursor's SDK supports `tool_choice: auto` or
`none`; explicit required/named choice, `parallel_tool_calls: false` with tools enabled, and `max_output_tokens`
are refused before generation because the SDK cannot enforce them. A cancelled Cursor setup
releases its local agent and owns any late SDK result; a stalled remote cancel cannot indefinitely
block local cleanup.

Structured output is explicit too: Claude translates `text.format: json_schema` to its native
`output_config.format`; Grok forwards Responses JSON-schema/JSON-object formats unchanged.
Cursor rejects structured-output requests before generation, and Claude rejects arbitrary
JSON-object mode (use a schema). Provider schema enforcement remains authoritative; the router
also rejects malformed JSON and supported structural violations in a completed final answer,
without replaying the turn or any tool action. Internal compaction uses prose rather than the
final-answer schema, and a compaction interrupt aborts its work while keeping the original history.

HTTP GPT JSON and SSE replies now populate the same bounded continuation history as WebSockets.
SSE framing is incremental, supports LF/CRLF/CR and bounds complete events in UTF-8 bytes.
Compressed requests use asynchronous streaming Zstd decoding with bounded wire/output bytes and
decoder windows; incomplete frames and trailing garbage are refused. Custom-tool grammar is
reserved before explanatory prose is shortened; syntax that cannot fit is explicitly refused.

## Configuration

Everything has a default; set only what you need.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3468` | Loopback port |
| `CODEX_HOME` | `~/.codex` | Where Codex keeps `auth.json` and `models_cache.json` |
| `PROXY_STATE_DIR` | `~/.codex-subscription-proxy` | Catalog and summary key |
| `CATALOG_FILE` | `$PROXY_STATE_DIR/models.json` | Model catalog served to Codex |
| `SUMMARY_KEY_FILE` | `$PROXY_STATE_DIR/summary.key` | 32-byte key for compaction capsules, created on first start |
| `GPT_MAX_ACTIVE`, `CLAUDE_MAX_ACTIVE`, `GROK_MAX_ACTIVE`, `CURSOR_MAX_ACTIVE` | `8` | Maximum active turns per account/provider; continuations have queue priority |
| `PROVIDER_MAX_QUEUED` | `64` | Maximum queued turns per account before reporting overload |
| `STREAM_BUFFER_BYTES` | `33554432` | Maximum queued output bytes per SSE/WebSocket client, including complete event frames |
| `IMAGE_CACHE_BYTES` | `67108864` | Maximum retained fitted-image bytes (also capped at 64 entries) |
| `UPSTREAM_TIMEOUT_MS` | `900000` | Timeout for requests to `chatgpt.com` |
| `UPSTREAM_CAPACITY_RECOVERY_MS` | `120000` | Recovery window from the first GPT overload; `0` prevents capacity retries |
| `UPSTREAM_CAPACITY_RETRY_BASE_MS` | `1000` | Initial GPT capacity retry delay, doubled with jitter up to 15 s |
| `UPSTREAM_CAPACITY_HEARTBEAT_MS` | `10000` | Progress cadence while holding GPT metadata or recovering capacity |
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
| `CATALOG_EFFORTS` | unset | `fragment=effort` pins, e.g. `claude=medium,gpt=high`; one effort per row |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Primary Claude login (Claude Code configuration directory); the router uses and refreshes it |
| `CLAUDE_EXPECTED_EMAIL`, `CLAUDE_EXPECTED_ORG` | unset | Optional primary Claude identity pins |
| `CLAUDE_ACCOUNT_CONFIG_DIR` | unset | Enables a separate second Claude login |
| `CLAUDE_ACCOUNT_MODEL_PREFIX` | `secondary` | Prefix for second-account Claude slugs |
| `CLAUDE_ACCOUNT_LABEL` | `Secondary` | Picker label for the second Claude account |
| `CLAUDE_ACCOUNT_MODELS` | both supported Claude models | Optional second-account model subset |
| `CLAUDE_ACCOUNT_EXPECTED_EMAIL`, `CLAUDE_ACCOUNT_EXPECTED_ORG` | unset | Optional second Claude identity pins |
| `CLAUDE_TIMEOUT_MS` | `300000` | Claude stream idle timeout, not a total reasoning deadline |
| `CURSOR_SPARE_AGENTS` | `1` | Agents kept ready per login for the next turn; `0` creates each at its turn |
| `CURSOR_MAX_HELD_RUNS` | `16` | Runs kept waiting on Codex tool results before the oldest is replayed instead |
| `CURSOR_SESSION_IDLE_MS` | `900000` | How long a run waiting on Codex tool results is kept |
| `CURSOR_TOOL_SETTLE_MS` | `25` | Quiet time after a native tool call before the calls so far go to Codex as one step |
| `CURSOR_CLEANUP_TIMEOUT_MS` | `2000` | Maximum wait for a remote Cursor cancel before local disposal proceeds |
| `GROK_HOME` | `~/.grok` | Grok Build profile holding the login the router uses and refreshes (use a dedicated one) |
| `GROK_TIMEOUT_MS` | `300000` | Grok stream idle timeout, not a total reasoning deadline |

### Claude

Claude turns go straight to Anthropic's Messages API with the Claude Code login of
`CLAUDE_CONFIG_DIR` (its macOS keychain item, or `.credentials.json` elsewhere), identified
as Claude Code, so no CLI process runs. Codex's tools are sent as Claude tools and Claude makes
real, parallel tool calls; raw-input tools such as `apply_patch` take their input as the
string field `input`, and namespaced tools are flattened and mapped back. History keeps its
structure; every tool call is paired with its result as Anthropic requires. Claude's thinking
is kept in memory and put back before its own calls on the next turn. Prompt caching marks the
tools, the system prompt and the newest turn, so each turn reads what the previous one wrote.
Quota comes from Anthropic's rate-limit headers on every reply. A compaction keeps the tools and system prompt
(with calls forbidden), so it reads the whole conversation from the cache too.

Claude inline images are checked for both encoded size (5 MiB) and dimensions
(3,000 pixels per axis), including screenshots inside replayed tool results.
The dimension ceiling applies from the first turn, so crossing 20 images in
a growing conversation cannot invalidate earlier screenshots. Images above
either ceiling are fitted asynchronously with macOS `sips` and cached; when
conversion is unavailable or fails, a text note replaces the image.

The router owns the login while it runs: it refreshes the access token shortly before expiry
(one refresh shared by concurrent turns) and writes the rotated tokens back where Claude Code
keeps them. Running the `claude` CLI on the same profile at the same time can invalidate the
router's refresh token; sign in again with `claude auth login` if a turn says so.

### Grok

Grok turns go straight to xAI's Responses endpoint (`cli-chat-proxy.grok.com`), the
one Grok Build itself uses with a SuperGrok login, so no CLI process runs. Codex's
tools are sent as function tools and Grok makes real, parallel tool calls; raw-input
tools such as `apply_patch` take their input as the string field `input`, and
namespaced tools are flattened and mapped back. History keeps its structure: calls,
results (including screenshots), messages and images. Grok's own encrypted reasoning
is kept in memory and put back before its calls on the next turn; other providers'
reasoning is dropped.

Sign in once with Grok Build, preferably into a dedicated profile:

```sh
GROK_HOME=/absolute/private/path/grok grok login
```

The router then owns that login. Its access token lasts six hours and every refresh
rotates the refresh token, so the router refreshes it shortly before expiry (one
refresh shared by concurrent turns) and writes the new tokens back into the same
`auth.json`. Do not also run the `grok` CLI against that profile, or the two will
invalidate each other's refresh token. A rejected refresh is terminal and says how
to sign in again. The request identifies itself as the current Grok Build client;
when xAI rejects that version (HTTP 426), the router looks up the latest release
once and retries.

### Run at login (macOS)

Create `~/Library/LaunchAgents/codex-subscription-proxy.plist` with `ProgramArguments` set to
`bun /path/to/codex-subscription-proxy/src/main.ts`, `RunAtLoad` and `KeepAlive` set to true, then
`launchctl load` it. The process exits on unexpected errors so launchd restarts it cleanly.

Set `ProcessType` to `Interactive`. Codex waits on every request the router serves: under
`Background` (CPU and I/O throttled to priority 4) the router's share of a cold turn measured 1.0 s
median and 3.0 s p90, against 0.29 s and 0.35 s.
A `ProcessType` change needs `launchctl bootout` and `bootstrap`; `kickstart -k` keeps the loaded one.

## Security

- Listens on `127.0.0.1` only.
- Every request must carry the exact ChatGPT token Codex stored in `auth.json`. Requests with an
  `Origin` header (browsers) are rejected.
- Claude and Grok get only Codex's tools, as function tools. Codex executes every call.
- The Claude login token is sent only to Anthropic (`api.anthropic.com`, and `platform.claude.com`
  to refresh); the Grok one only to `auth.x.ai` (refresh) and xAI's Grok endpoint.
- Cursor uses its separately stored SDK credential and the no-native-tools policy described above.
- Logs record event names, sizes and counts, never prompt or response content.
- Compaction capsules for Claude/Grok chats are sealed with AES-256-GCM using a local key.

## Development

```sh
bun run check     # typecheck + tests
```

See [AGENTS.md](AGENTS.md) for the layout.

## Disclaimer

Unofficial and not affiliated with OpenAI, Anthropic, xAI or Cursor. It calls Anthropic's and xAI's
endpoints as their official clients do, and Cursor's through its official SDK, with your own accounts; you are
responsible for following each provider's terms.

## License

[MIT](LICENSE)
