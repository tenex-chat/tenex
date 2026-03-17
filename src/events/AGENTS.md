# events/ — Event Schemas (Layer 2)

Typed NDK event classes for every event TENEX produces or consumes. Each file is an NDK event wrapper class.

Also contains small runtime-facing contracts that must stay in layer 2 so higher layers
can depend on them without reaching into transport-specific implementations.

## Contents

- `NDKAgentDefinition.ts` — Agent definition events (kind 4199)
- `NDKAgentLesson.ts` — Agent lesson events (kind 4129)
- `NDKEventMetadata.ts` — Event metadata (kind 513)
- `NDKMCPTool.ts` — MCP tool events
- `runtime/AgentRuntimePublisher.ts` — phase-1 publishing contract for the conversation/runtime plane
- `runtime/AgentRuntimePublisherFactory.ts` — executor-facing factory type for publisher injection
- `runtime/InboundEnvelope.ts` — canonical inbound transport envelope for conversation-plane ingress
- `runtime/LocalInboundAdapter.ts` — test/gateway adapter for simulating non-Nostr inbound transports against the canonical envelope contract
- `runtime/RecordingRuntimePublisher.ts` — local recording publisher for smoke tests and branch-safe validation

## Event Kinds

All kind constants are defined in `src/nostr/kinds.ts` — that is the single source of truth. These classes use those constants, never hardcoded numbers.

## Adding New Events

1. Create `NDK<Name>.ts` extending the appropriate NDK class
2. Add the kind constant to `src/nostr/kinds.ts`
3. Import the new class directly where it is needed
