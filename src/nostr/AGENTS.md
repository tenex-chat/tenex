# nostr/ — Nostr Integration (Layer 2)

Encapsulates all Nostr protocol interactions. Higher layers never manipulate NDKEvent directly — they use these wrappers.

## Key Files

- `ndkClient.ts` — NDK bootstrap and connection management
- `AgentPublisher.ts` — Primary agent event publication interface; signs events and hands them to the Rust publish outbox
- `AgentProfilePublisher.ts` — Agent profile/metadata publication through the Rust publish outbox
- `InterventionPublisher.ts` — Intervention event publication through the Rust publish outbox
- `AgentEventEncoder.ts` — Encode data into Nostr event format
- `AgentEventDecoder.ts` — Decode Nostr events into TENEX data
- `NostrInboundAdapter.ts` — Normalize inbound Nostr events into canonical transport envelopes
- `kinds.ts` — **Single source of truth** for all event kind constants
- `keys.ts` — Key management
- `encryption.ts` — NIP-44/NIP-04 encryption
- `TagExtractor.ts` — Tag parsing utilities
- `BlossomService.ts` — Blossom media upload
- `relays.ts` — Relay configuration
- `trace-context.ts` — Distributed tracing via Nostr tags

## Rules

- NDK type imports (for typing) are fine anywhere. NDK instance usage is confined to this module.
- TypeScript must not publish directly to relays in daemon/runtime paths. It signs events and enqueues them through `RustPublishOutbox`; Rust owns relay publishing.
- Agent event publishing goes through `AgentPublisher` or specialized publishers.
- Kind numbers come from `kinds.ts`. Never use magic numbers.

## Event Flow

Publishing: Data → AgentEventEncoder → NDKEvent → signer → RustPublishOutbox → Rust relay publisher
Receiving: Relay → Rust subscription gateway → Rust ingress/worker dispatch → TypeScript worker execution
