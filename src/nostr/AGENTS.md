# nostr/ — Nostr Integration (Layer 2)

Encapsulates all Nostr protocol interactions. Higher layers never manipulate NDKEvent directly — they use these wrappers.

## Key Files

- `ndkClient.ts` — NDK bootstrap and connection management
- `AgentPublisher.ts` — Primary event publishing interface
- `AgentProfilePublisher.ts` — Agent profile/metadata publishing
- `InterventionPublisher.ts` — Intervention event publishing
- `AgentEventEncoder.ts` — Encode data into Nostr event format
- `AgentEventDecoder.ts` — Decode Nostr events into TENEX data
- `kinds.ts` — **Single source of truth** for all event kind constants
- `keys.ts` — Key management
- `encryption.ts` — NIP-44/NIP-04 encryption
- `TagExtractor.ts` — Tag parsing utilities
- `BlossomService.ts` — Blossom media upload
- `relays.ts` — Relay configuration
- `trace-context.ts` — Distributed tracing via Nostr tags

## Rules

- NDK type imports (for typing) are fine anywhere. NDK instance usage is confined to this module.
- All event publishing goes through `AgentPublisher` or specialized publishers.
- Kind numbers come from `kinds.ts`. Never use magic numbers.

## Event Flow

Publishing: Data → AgentEventEncoder → NDKEvent → AgentPublisher → Relay
Receiving: Relay → NDK Subscription → NDKEvent → AgentEventDecoder → Data
