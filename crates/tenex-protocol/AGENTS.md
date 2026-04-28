# tenex-protocol

Library crate. Defines the TENEX agent communication protocol: the transport-agnostic vocabulary of `Intent` types and a `Channel` trait that maps intents onto wire messages. Today there is exactly one transport implementation — `NostrChannel` — but the seam exists so future transports (NIP-04 encrypted DMs, Telegram, Slack) land as new `impl Channel` blocks with no changes to callers.

This crate is the canonical home for wire-format knowledge. Kind numbers, tag shapes, threading rules, project a-tag layout — they live here. Other crates produce intents; only this crate knows how an intent becomes a kind:1 with `["e", root, "", "root"]` plus a `["status", "completed"]` tag.

Mirrors the TypeScript canonical encoder at `src/nostr/AgentEventEncoder.ts`.

## Public API

- `Intent` enum + per-variant payload structs (`CompletionIntent`, `ConversationIntent`, `DelegationIntent`, `AskIntent`, `ErrorIntent`, `LessonIntent`, `ToolUseIntent`, `StreamTextDeltaIntent`, `InterventionReviewIntent`).
- `EncodingContext` — resolved primitives the encoder needs (project ref, conversation root, RAL number, model, runtime, branch/team).
- Reference enums: `PrincipalRef`, `ConversationRef`, `MessageRef`, `ProjectRef`. Single `Nostr` variant today; new variants land when transport #2 arrives.
- `Channel` trait with `async fn send(intent, ctx) -> Vec<MessageRef>`. Implementations: `NostrChannel<S: EventSink>`.
- `EventSink` trait with `StdoutNdjsonSink` (always-on) and `RelaySink` (gated by `relay` feature).
- `InboundSource` trait + `InboundEnvelope` + `nostr::decode(event) -> InboundEnvelope` for the inverse direction.

## Critical invariants

- **Encoder is pure.** `NostrEncoder::encode` takes `&Intent + &EncodingContext` and returns `Vec<EventBuilder>`. No I/O, no key material. Sign happens in the channel; deliver happens in the sink.
- **Signing is the channel's job, not the encoder's.** Secret material does not enter the encoder module.
- **Two sinks behind one trait, not two channel types.** Encode + sign plumbing is identical across modes; only the final delivery varies. `StdoutNdjsonSink` and `RelaySink` are interchangeable behind `EventSink`.
- **`relay` feature is opt-in.** `tenex-agent` consumes with `default-features = false` so `nostr-sdk` is excluded from its dependency graph — the no-relay-connections invariant becomes a type-system property, not a convention.
- **Tag-shape parity with TypeScript.** `src/nostr/AgentEventEncoder.ts` is the canonical spec. Any divergence is a bug. Snapshot tests under `tests/` lock the tag set per intent variant.
- **Reference enums are forward-compatible.** When `PrincipalRef::Telegram` lands, the compiler's exhaustive-match check tells every encoder which arms need updating. Do not bypass that check by adding catch-all `_` arms.

## How to approach changes

1. `cargo build -p tenex-protocol && cargo test -p tenex-protocol` before and after edits.
2. New intent variant: add to `Intent` enum + payload struct in `intent.rs` + arm in `nostr/encoder.rs::encode` + snapshot test in `tests/`.
3. New transport: add a sibling module under `src/`, define the encoder, implement `Channel`. Intent types stay shared.
4. New tag: thread it through `EncodingContext` (if computed by the caller) or hardcode in the encoder (if intent-specific). Update the snapshot fixture.
5. Wire-format changes must match `src/nostr/AgentEventEncoder.ts` byte-for-byte.

## Intentionally absent

- No daemon, no socket, no relay connection management (that lives behind `RelaySink` if the feature is enabled, or in the consumer crate).
- No slug→pubkey resolution (caller's job; encoder takes resolved `PrincipalRef`s).
- No project-id resolution (caller passes a `ProjectRef`).
- No retry/backoff middleware. The trait shape supports decorator channels; none are built.
- No `StatusIntent`, `encodeFollowUp` — out of the canonical 9-intent set.
- No NIP-46 bunker signing — belongs to `tenex-identity` when it lands.
- No backwards-compatibility shims for the pre-extraction `AgentSigner` API.
