# Rust Telegram Adapter Design (M8 Slice)

## Context

TENEX is migrating Telegram from TypeScript-resident transport services to a
Rust-native adapter. The canonical migration plan is
`docs/rust/agent-execution-worker-migration.md` (target ownership) and
`docs/rust/implementation-milestones-and-quality-gates.md` M8. The behavior
oracle is `src/services/telegram/` plus `src/services/ingress/` and
`src/events/runtime/InboundEnvelope.ts`.

The single architectural constraint: Rust owns the Telegram adapter entirely,
TypeScript owns only the agent execution worker, and the worker must not call
the Bot API directly. The `publish_request` protocol is transport-agnostic —
Rust derives Telegram delivery from the accepted runtime event plus the
retained triggering envelope plus agent configuration.

## Scope Of This Document

This plan covers the Rust-side Telegram surface as a sequence of narrow,
independently-landable slices. Only the first slice is implemented in this pass
(see `Slice 1 — Foundations` below). Later slices are sketched so the module
layout holds up and nothing is boxed-in.

## Module Layout (target)

```text
crates/tenex-daemon/src/telegram/
    mod.rs                  - re-exports
    types.rs                - shared Bot API / envelope primitives
    renderer.rs             - Markdown/plain → Telegram HTML renderer
    bindings.rs             - reader for the shared TransportBindingStore file
    delivery_plan.rs        - pure derivation: envelope + class + config → outbox request
    client.rs               - reqwest Bot API client (TBD — Slice 2)
    inbound.rs              - TelegramUpdate → InboundEnvelope (TBD — Slice 3)
    gateway.rs              - long-poll loop, multi-bot registration (TBD — Slice 4)
    chat_context.rs         - admin/member/topic metadata tracking (TBD — Slice 3)
    commands.rs             - /start, /model, /tools, /new (TBD — Slice 5)
    delivery.rs             - outbox drain via Bot API client (TBD — Slice 2)
```

The existing `crates/tenex-daemon/src/telegram_outbox.rs` stays where it is.
It is already the canonical durable outbox primitive; moving it into
`telegram/` is an optional follow-up after the adapter lands. We re-export
from `telegram::outbox` to give the module tree a clean edge without moving
the file and invalidating references.

## Outbox Record Shape

The existing `TelegramOutboxRecord` (already landed) already matches the M8
design decisions. No schema changes are required. Important fields for
delivery derivation:

- `payload`: `HtmlText` / `PlainText` / `AskError` / `ReservedVoice`.
- `delivery_reason`: `FinalReply`, `ConversationMirror`, `ReasoningMirror`,
  `AskError`, `ToolPublicationMirror`, `Voice`.
- `reply_to_telegram_message_id`: derived from the triggering envelope.
- `channel_binding.chat_id` / `message_thread_id`: derived from the envelope.

## Protocol Change: `runtimeEventClass`

The worker `publish_request` frame gains a transport-neutral classification
field:

```text
runtimeEventClass:
  "complete" | "conversation" | "ask" | "error" | "tool_use"
  | "delegation" | "delegate_followup" | "lesson" | "stream_text_delta"
```

These map 1:1 to `AgentRuntimePublisher` methods. Rust uses the class plus the
retained triggering envelope (from the execute frame) plus agent config to
decide whether to enqueue a Telegram delivery record for this publish, and
what delivery reason to stamp on it. `AgentPublisher` on the TS side is the
authoritative encoder; the worker tags each `publish_request` with the
classification as it calls the relevant publisher method.

Rationale for carrying this in the protocol rather than recomputing from
`kind`+`tags`: the conversation/reasoning distinction, the ask-versus-error
distinction, and the complete-versus-conversation distinction all cross-cut
Nostr event kinds and cannot be recovered from the signed event alone
without re-duplicating classifier logic in Rust. A single explicit field is
cheaper and more auditable than a cross-language classifier.

### TS→Rust class mapping (behavior oracle)

From `TelegramRuntimePublisherService.ts`:

| runtimeEventClass    | TS publisher method                | Telegram action                                           |
| -------------------- | ---------------------------------- | --------------------------------------------------------- |
| `complete`           | `complete`                         | always deliver FinalReply                                 |
| `conversation`       | `conversation` (non-reasoning)     | deliver ConversationMirror iff `publishConversationToTelegram` |
| `conversation`       | `conversation` (reasoning)         | deliver ReasoningMirror iff `publishReasoningToTelegram`  |
| `ask`                | `ask`                              | always deliver AskError (`title\n\ncontext` body)         |
| `error`              | `error`                            | always deliver AskError (error message)                   |
| `tool_use`           | `toolUse`                          | deliver ToolPublicationMirror iff renderer returns content |
| `delegation`         | `delegate`                         | never deliver                                             |
| `delegate_followup`  | `delegateFollowup`                 | never deliver                                             |
| `lesson`             | `lesson`                           | never deliver                                             |
| `stream_text_delta`  | `streamTextDelta`                  | never deliver                                             |

The reasoning-versus-conversation branch in the TS service depends on
`intent.isReasoning`, not the event kind. To preserve this cleanly, the
`runtimeEventClass` string set includes `conversation`, and Rust also
receives an explicit `conversationVariant: "primary" | "reasoning"` **only**
when the class is `conversation`. This keeps the field transport-neutral
(it names the semantic intent, not a Telegram-specific behavior) and
recovers the TS reasoning-toggle without Rust peeking inside `content`.

Proposed frame extension (additive, v1-compatible):

```jsonc
{
  "type": "publish_request",
  "runtimeEventClass": "conversation",
  "conversationVariant": "reasoning",
  // ... existing fields
}
```

Validation rules:

- `runtimeEventClass` is required on `publish_request`.
- `conversationVariant` is allowed only when class is `conversation`; required
  then; rejected otherwise. Defaults to `primary` never — workers always set
  it so Rust never has to infer.

## Delivery Derivation

A pure function `plan_telegram_delivery` in `telegram::delivery_plan` takes:

- retained `InboundEnvelope` (triggering envelope from the execute frame)
- `runtimeEventClass` and optional `conversationVariant`
- minimal agent-config slice: `{ botToken, apiBaseUrl, publishConversationToTelegram, publishReasoningToTelegram }`
- minimal accepted-event slice: `{ id: event_id, content: final_text, tool_render: Option<String> }`

and returns `Option<TelegramDeliveryRequest>` — `Some` when the class+config
combination demands delivery, `None` otherwise. This mirrors the TS
`isTelegramContext` + per-method `deliverTelegramMessage` guard exactly. The
function does no I/O and is trivially unit-testable against the TS matrix.

Callers (the publish-request runtime path in the Rust daemon) then hand the
result to `enqueue_telegram_outbox` and let the existing outbox drain it.

### Voice marker handling

The TS `TelegramDeliveryService` recognises a `[[telegram_voice:/abs/path]]`
marker in the final reply content and routes to `sendVoice`. Rust preserves
this by scanning the accepted event content inside `plan_telegram_delivery`
and producing `TelegramDeliveryPayload::ReservedVoice { marker }` when the
marker is present and the path is absolute. Any surrounding text becomes a
second outbox record (same envelope, `HtmlText` payload). This is the exact
TS behavior; it is critically important that a non-absolute path does NOT
trigger voice delivery — otherwise a stray marker in model output could
escalate to an arbitrary filesystem read at delivery time.

## Bindings Reader

`TransportBindingStoreService` writes a JSON array file at
`$TENEX_BASE_DIR/<data>/transport-bindings.json` (path resolved through
`ConfigService.getConfigPath("data")`). Rust reads the same file. Records
are `{ transport, agentPubkey, channelId, projectId, createdAt, updatedAt }`.
Rust never writes this file during M8; writes stay TypeScript-owned (the
worker records the binding when the first message arrives) until the gateway
slice moves write ownership.

The reader is strict: unknown transport values and malformed records are
skipped with a warning, consistent with the TS reader.

## Daemon Maintenance Wiring

`run_daemon_maintenance_once_from_filesystem` (already landed) currently runs
backend-events maintenance + scheduler-wakeup maintenance. Slice 1 adds a
`telegram_outbox` field to `DaemonMaintenanceOutcome` populated by a new
`run_telegram_outbox_maintenance_without_drain` call on every pass.

Why a dedicated "without drain" entrypoint rather than a NoopPublisher: a
no-op publisher would log fake failure attempts on every record every tick,
polluting the outbox's attempt-history with spurious "failed" entries that
the real client would then have to filter. The explicit entrypoint keeps
pending records untouched (except for requeueing legitimately-due failed
records, which is still correct behavior today) and surfaces the pending
count through diagnostics.

Once the real Bot API client lands, the caller switches to
`run_telegram_outbox_maintenance(daemon_dir, &mut client, now_ms)` and
nothing else in the maintenance wiring changes. The two functions share
the `TelegramOutboxMaintenanceReport` output shape.

## What This Pass Implements (Slice 1)

Files added:

- `crates/tenex-daemon/src/telegram/mod.rs`
- `crates/tenex-daemon/src/telegram/types.rs`
- `crates/tenex-daemon/src/telegram/renderer.rs` — port of
  `telegram-message-renderer.ts`. Pure function, unit-tested against the TS
  behavior matrix: code fences, inline code, headings, quotes, bullets,
  bold/italic/underline/spoiler/strike/links, HTML escaping.
- `crates/tenex-daemon/src/telegram/bindings.rs` — read-only reader for the
  shared `transport-bindings.json` file.
- `crates/tenex-daemon/src/telegram/delivery_plan.rs` — `plan_telegram_delivery`
  pure function.
- Re-export `crate::telegram_outbox` as `crate::telegram::outbox` via
  `pub use`.
- Extend `crate::daemon_maintenance` with Telegram-outbox maintenance call.

Protocol additions (both sides):

- `AgentWorkerProtocol.ts`: add `runtimeEventClass` and `conversationVariant`
  to `publish_request` schema with the documented validation rules.
- `worker_protocol.rs`: mirror the field with the same validation.
- `AgentPublisher.ts`: every worker-side publish path sets these fields.
- TS worker: plumb the class through to `publish_request`.

Tests added:

- `telegram::renderer` golden tests covering every TS renderer branch.
- `telegram::bindings` tests for valid records, unknown transport, malformed
  JSON, missing file.
- `telegram::delivery_plan` tests for the TS matrix: each class × variant ×
  config toggle produces the expected outbox request (or None).
- Protocol validator tests for `runtimeEventClass` presence, variant
  consistency, and back-compat rejection of missing field on new frames.

What this pass does NOT implement (tracked for later slices):

- Bot API HTTP client (reqwest) — Slice 2.
- Gateway long-poll loop, multi-bot registration, backlog skip, auth-error
  fail-closed — Slice 4.
- Inbound Telegram update → `InboundEnvelope` normalizer — Slice 3.
- Chat-context API sync (admins/members/topics) — Slice 3.
- `/start`, `/model`, `/tools`, `/new` config command handling — Slice 5.
- **Deleting TypeScript Telegram code must happen as each Rust replacement
  lands.** No feature flags, no parallel running, no "deferred to M10"
  cleanup. When Rust owns outbound delivery, TS outbound delivery is
  deleted in the same slice. When Rust owns the gateway, TS gateway is
  deleted in the same slice. The first slice did not delete anything only
  because no TS subsystem had yet been fully replaced.

## Slice 2 Implementation Notes

Files added:

- `crates/tenex-daemon/src/telegram/client.rs` — blocking Bot API HTTP
  client built on `reqwest::blocking`. The Rust daemon is entirely
  synchronous and the existing `TelegramDeliveryPublisher` trait is a
  blocking `fn(..)`; async would have required wrapping every call site.
  Methods implemented: `send_message`, `send_voice`, `get_me`,
  `get_updates`, `get_chat`, `get_chat_administrators`,
  `get_chat_member_count`, `get_forum_topic_icon_stickers`. The latter
  group is built in Slice 2 even though only `send_message`/`send_voice`
  drain pending outbox records; putting the full consumed surface in one
  place avoids churn in Slices 3–5.
- `crates/tenex-daemon/src/telegram/delivery.rs` —
  `TelegramBotDeliveryPublisher` implementing
  `TelegramDeliveryPublisher`. Decodes `TelegramOutboxRecord::payload`,
  runs one HTML→plain retry on `HtmlText`/`AskError` parse failures (TS
  oracle: `TelegramDeliveryService.sendMessageWithHtmlRetry`), and enforces
  the "voice marker absolute-path only, read file at delivery time" rule
  from `extractTelegramVoiceReply`. Returns `Permanent` on missing/relative
  voice files so the outbox does not retry a filesystem lookup that will
  never succeed.
- `daemon_maintenance.rs` gains a `TelegramMaintenancePublisher` trait
  with two implementations: `NoTelegramPublisher` (drain-less, used
  pre-wire-up and in tests) and `WithTelegramPublisher<'_, P>` (real
  publisher wrapper). Existing callers keep the drain-less behavior;
  production daemon wiring can pass a live publisher without the outbox
  layer itself learning about transport clients.

Dependency additions (Cargo.toml):

- `reqwest 0.12` with `blocking`, `json`, `multipart`, and
  `rustls-tls-native-roots` features, `default-features = false`. Chose
  native-roots over webpki-roots to match the existing
  `tungstenite = { features = ["rustls-tls-native-roots"] }` convention in
  the same crate.
- `tempfile 3` as dev-dependency for the voice-file tests.

Error classification matrix (preserves the TS oracle's behavior):

| Trigger                                          | `TelegramErrorClass` | Retryable |
|--------------------------------------------------|----------------------|-----------|
| Network error (`is_timeout=true`)                | `Timeout`            | yes       |
| Other network error                              | `Network`            | yes       |
| HTTP 429 with `parameters.retry_after=N`         | `RateLimited`        | yes (after N s) |
| HTTP 401 / "Unauthorized"                        | `Unauthorized`       | no        |
| "bot was blocked by the user"                    | `BotBlocked`         | no        |
| "chat not found"                                 | `ChatNotFound`       | no        |
| HTTP 5xx                                         | `ServerError`        | yes       |
| "can't parse entities" with `parse_mode=HTML`    | (HtmlParseError sentinel; publisher triggers plain retry) | — |
| Other 400                                        | `BadRequest`         | no        |
| Missing voice file / relative voice path         | `BadRequest`         | no (permanent, publisher layer) |

The HTML parse failure bubble is a distinct client error variant
(`TelegramClientError::HtmlParseError`) rather than a magic classifier on
the raw description string. The delivery publisher matches on the variant
and issues one retry without a parse mode; that retry's error (if any) is
what propagates. Tests cover both arms.

Testing approach:

- Unit tests in `client.rs` exercise each error-mapping rule against a
  hand-rolled single-shot mock HTTP server bound to a loopback port. No
  external mock library (wiremock etc.) is added: the existing
  `relay_publisher.rs` tests established this pattern and it cheap and
  self-contained.
- Unit tests in `delivery.rs` cover each payload variant against a
  scripted multi-response mock server, including the HTML-retry success
  and HTML-retry-fail flows, reserved voice, and missing/relative voice
  paths.
- Integration tests in `delivery.rs` enqueue records via
  `accept_telegram_delivery_request`, drain through the real publisher
  against the mock server, walk `pending → delivered`, `pending → failed →
  requeue → delivered`, and `pending → permanent-failed`.
- No live-API test is shipped. If a developer needs to verify against the
  real Bot API during a slice, they add an opt-in `#[ignore]`-gated local
  integration test for their own verification and remove it before
  merging.

What Slice 2 does NOT do:

- Wire the real `TelegramBotDeliveryPublisher` into the production daemon
  loop; that requires the per-agent bot-token resolution and is best
  landed together with Slice 4's gateway so the same config read drives
  both inbound polling and outbound drain.
- Introduce any async runtime. `reqwest::blocking` suffices because the
  outbox trait is blocking. If Slice 4's long-poll gateway needs async, it
  will either use `tokio` or, more likely, a dedicated `std::thread` per
  bot since polls are serialized.

## Slice 3 Implementation Notes

Files added:

- `crates/tenex-daemon/src/inbound_envelope.rs` — Rust mirror of
  `src/events/runtime/InboundEnvelope.ts`. `#[serde(rename_all = "camelCase")]`
  on every struct keeps the on-the-wire JSON byte-identical to what the TS
  runtime emits so the worker's `triggeringEnvelope` decoder is unchanged.
  A golden-sample test round-trips a supergroup-topic envelope with
  administrators, seen participants and a reply reference.
- `crates/tenex-daemon/src/telegram/chat_context.rs` — durable per-chat
  snapshot with `schema_version` + `writer` + atomic write/rename, TTL-gated
  API refresh (`get_chat`, `get_chat_administrators`, `get_chat_member_count`,
  `get_forum_topic`), and a seen-participants sliding window capped at 25
  entries. Stamps `last_api_sync_at` even on partial-failure refreshes so
  transient Bot API errors don't hot-loop. Storage layout:
  `$TENEX_BASE_DIR/daemon/telegram/chat-context/<chat_id>.json` with chat
  ids encoded through the same leading-dash normalizer as
  `createTelegramNativeMessageId`.
- `crates/tenex-daemon/src/telegram/inbound.rs` — pure
  `normalize_telegram_update(InboundNormalizationInput) -> Option<InboundEnvelope>`
  function. Mirrors `TelegramInboundAdapter.toEnvelope` plus the
  bot-authored/unsupported-chat-type/unprocessable-message filter rules the
  TS gateway applies before calling the adapter. Callers thread the
  chat-context snapshot in explicitly; the normalizer does no I/O. Returns
  `None` for updates the TS gateway drops (callback queries, channel chats,
  bot-authored messages, empty-content messages with no media, messages
  authored by our own bot id).

How the pieces fit together (Slice 4 wire-up preview):

1. Gateway receives a Bot API update through `TelegramBotClient::get_updates`.
2. Gateway calls
   `chat_context::refresh_chat_context(..)` — TTL-gated, no-op on most ticks.
3. Gateway calls `chat_context::record_seen_participant(..)` with the sender.
4. Gateway downloads any media attachment and builds an `InboundMediaInfo`.
5. Gateway calls `normalize_telegram_update(..)` passing the cached snapshot,
   the sender's `linked_pubkey` lookup, the session reply hint, recipients,
   and project binding.
6. Gateway forwards the resulting envelope to the worker as the triggering
   envelope of the next execute frame. The worker never parses Telegram
   shapes; it only sees the normalized envelope.

The normalizer's `InboundNormalizationInput` takes everything as explicit
fields with no ambient state — no statics, no trait objects — so every
filter and metadata-override path is trivially unit-testable.

Tests added in `telegram::inbound`:

- Private DM, group, supergroup forum-topic (with snapshot-provided topic
  title and administrators) happy paths.
- `edited_message` sets `isEditedMessage = true`.
- Session reply hint wins over `reply_to_message.message_id`; the latter is
  the fallback used when the gateway has no session context.
- Voice message with and without caption; document, photo and video media
  markers match the TS adapter's exact wording.
- Bot-authored messages (both `is_bot: true` and our own `bot_id`) return
  `None`. Channel chat type returns `None`. Callback queries return `None`.
  Empty-content (text/caption only whitespace, no media) returns `None`.
- `sender_linked_pubkey` threads into `PrincipalRef.linked_pubkey`.
- Seen-participants snapshot is carried through to
  `TelegramTransportMetadata.seenParticipants` unchanged.
- Recipient entries serialize as `nostr:<pubkey>` with
  `transport = nostr`, `kind = agent`.

What Slice 3 does NOT do:

- Wire the normalizer into a running gateway. That's Slice 4's job; Slice 4
  will delete `TelegramInboundAdapter.ts`, `TelegramChatContextService.ts`,
  `TelegramChatContextStoreService.ts`, and `TelegramGatewayService.ts` in
  the same commit that lands the Rust gateway loop.
- Handle media downloads. The normalizer takes an already-downloaded
  `InboundMediaInfo` with an absolute local path; fetching bytes from the
  Bot API's `getFile` endpoint is a Slice 4 concern.
- Resolve identity bindings. The gateway passes the sender's
  `linked_pubkey` in as a parameter; the actual lookup against the identity
  binding store remains owned by the runtime ingress layer.

## Slice 4 Implementation Notes

Files added:

- `crates/tenex-daemon/src/telegram/gateway.rs` — long-poll supervisor.
  One `std::thread` per configured bot token. Each thread:
  1. Calls `getMe` to learn its bot identity. Failure with
     `InvalidToken` stops the thread immediately (other bots keep
     polling); other `getMe` errors are logged and the thread proceeds
     with a placeholder identity so the loop still filters bot-authored
     messages correctly.
  2. Runs `skip_backlog` once with `timeout=0` / `allowed_updates` matching
     the TS helper, advancing offset past every update accumulated while
     the daemon was down.
  3. Enters the poll loop: `getUpdates(offset, timeout=30s, limit=100)`.
     On success every update is handed to `process_one` which refreshes
     the durable chat-context snapshot (TTL-gated), records the sender as
     a seen participant, downloads any media attachment via
     `download_telegram_media`, then delegates to
     `telegram::ingress_runtime::process_telegram_update` for the
     transport-binding lookup / auth check / inbound dispatch enqueue.
  4. `InvalidToken` anywhere in the poll loop fails the bot closed.
     Transient errors (network / timeout / 5xx) use exponential backoff
     starting at 1 s and capped at 60 s, with the stop flag polled every
     500 ms so shutdowns don't wait a full backoff interval.
  5. Stop: `TelegramGatewaySupervisor::request_stop` flips an
     `Arc<AtomicBool>` every thread polls between iterations. `join`
     waits for every thread to exit cleanly. Drop also sets the flag.
- `crates/tenex-daemon/src/telegram/media.rs` — blocking media downloader
  with `file_unique_id`-keyed dedup. Mirrors
  `TelegramMediaDownloadService.ts`. Expected-size mismatch re-downloads;
  writes atomically via a `.partial` → rename.
- `crates/tenex-daemon/src/telegram/agent_config.rs` — reader that scans
  `<tenex_base_dir>/agents/*.json` for agents carrying a non-empty
  `telegram.botToken` and turns each into a `GatewayBot`.

`telegram::bindings` gained an identity-binding reader:
`read_identity_bindings`, `find_linked_pubkey`,
`find_linked_pubkey_for_telegram_user`. These match the TS
`IdentityBindingStore` file shape (`<data>/identity-bindings.json`) and
let the normalizer resolve a Telegram sender's `linkedPubkey` without
ambient state.

`telegram::client` gained `get_file`, `file_download_url`, and
`download_file_to` so `media.rs` can resolve and stream Bot API
attachments through the same blocking `reqwest` client used by
`send_message`/`send_voice`.

Daemon startup wiring: `crates/tenex-daemon/src/bin/daemon.rs` now calls
`read_agent_gateway_bots`, constructs a `GatewayConfig`, and starts the
supervisor before the foreground tick loop. On shutdown (signal or
iteration cap) it explicitly signals stop and joins. When no agent has a
bot token the gateway is simply not started.

Config command handling (Slice 5 scope): `/start`, `/model`, `/tools`,
`/new` and callback-query updates are dropped by the Rust pipeline for
now. `process_telegram_update` returns an ignored outcome
(`unsupported_callback_query` for callback queries,
`unbound_channel` for un-bound `/start` flows) and the observer just
records the reason. No Rust→TS bridge was built because:

1. The TS daemon is already decommissioned (`src/commands/daemon.ts` only
   launches the Rust binary); no process exists to host a bridge.
2. A temporary bridge would violate TENEX's "no temporary solutions"
   rule — Slice 5 is the clean landing spot for a Rust-native config
   command handler.

This means `/start`, `/model`, `/tools`, `/new` are non-functional until
Slice 5 lands. Operators who need these flows during the Slice 4–5
window must use the CLI equivalents.

What Slice 4 does NOT do:

- Wire a live `TelegramBotDeliveryPublisher` through
  `run_daemon_foreground_until_stopped_from_filesystem_with_worker` into
  the tick loop. The outbox keeps accepting records; drain will light up
  when the foreground API accepts a Telegram publisher parameter. The
  deferral is bounded — the publisher and outbox drain logic are both
  already in place (Slice 2) and the daemon wiring is the only missing
  piece. Threading a per-bot dispatcher through the worker-runtime loop
  is a self-contained follow-up and was scoped out to avoid touching the
  concurrent worker-publishing work on this branch.
- Implement per-agent bot config updates at runtime. The supervisor is
  started once on daemon boot; adding or removing bot tokens requires a
  daemon restart until Slice 5's config-command handler triggers a
  live reload.

TypeScript services deleted in the same commit:

- `TelegramGatewayService.ts` (+ tests + telemetry test)
- `TelegramInboundAdapter.ts` (+ test)
- `TelegramChatContextService.ts` (+ test)
- `TelegramMediaDownloadService.ts`
- `TelegramRuntimePublisherService.ts` (+ test)
- `telegram-gateway-utils.ts`
- `telegram-runtime-tool-publications.ts` (+ test)
- `src/agents/execution/__tests__/AgentExecutor.no-response.telegram.test.ts`

Kept (worker-side or Slice 5 scope, not replaced by Rust yet):

- `TelegramBotClient.ts` — still used by `TelegramConfigCommandService`
  (Slice 5) and the `send_message` worker tool.
- `TelegramDeliveryService.ts` + `telegram-message-renderer.ts` — still
  used by the `send_message` worker tool for proactive channel sends.
- `TelegramChatContextStoreService.ts` — still consumed by the worker's
  system-prompt fragment (`08-project-context.ts`). Slice 5 will migrate
  this fragment to read the Rust-owned durable snapshot directly.
- `TelegramConfigCommandService.ts`, `TelegramConfigSessionStoreService.ts`,
  `TelegramPendingBindingStoreService.ts`,
  `TelegramBindingPersistenceService.ts` — Slice 5 scope (config
  commands).
- `src/services/telegram/types.ts` — still referenced by agent-config
  types.

## Trade-offs

- **Why not port everything now?** Because a partial adapter that does not
  connect to the real Bot API but still runs in-daemon is a liability. The
  clean foundation (renderer, delivery plan, bindings reader, protocol
  field, maintenance wiring) lets the HTTP client land as a self-contained
  follow-up without rework. A half-written client gated behind flags would
  violate TENEX's "no temporary solutions / no backwards compatibility"
  rules.
- **Why keep `telegram_outbox.rs` at the crate root?** Moving it costs
  churn and would conflict with the ongoing worker-publishing work on the
  same branch. We re-export it under `telegram::outbox` to give callers a
  clean API without moving the file. A rename commit can follow once the
  rest of the module is populated and the crate tree settles.
- **Why accept the protocol field as additive rather than a v2 bump?** The
  existing protocol version is 1 with schema validation; adding a required
  field on a specific message type is a semantic extension that remains
  structurally backwards-compatible at the framing layer (length-prefixed
  JSON). Bumping to v2 would force warm-reuse rejection for every running
  worker across the migration boundary, which is the exact split-brain
  hazard the plan warns about. The shared schema fixture catches drift.
- **`conversation` variant encoding:** alternative was two classes
  (`conversation_primary` / `conversation_reasoning`). Chose a single class
  + variant because the variant is genuinely a sub-axis of the same
  publisher method; making them separate classes would imply they route
  differently on the Nostr side, which is false.

## Open questions, deferred

- Should the Rust gateway share the `skipTelegramBacklog` offset with other
  backends when sharding is enabled? Current answer: no, offset is per-bot
  and per-process. Revisit in Slice 4 if shard handoff needs sticky-offset
  semantics.
- Is `telegram_voice` marker staying as the voice-attachment contract?
  Current answer: yes for M8, matching the migration plan. A structured
  attachment contract is out of scope until after M10.
- Where does bot-token storage live in Rust? The agent's `telegram` config
  block is on the agent record, which Rust already reads via
  `agent_inventory`. Slice 4 will plumb this through; Slice 1 leaves it
  implicit.
