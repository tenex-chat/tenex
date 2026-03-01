# events/ — Event Schemas (Layer 2)

Typed NDK event classes for every event TENEX produces or consumes. Each file is an NDK event wrapper class.

## Contents

- `NDKAgentDefinition.ts` — Agent definition events (kind 4199)
- `NDKAgentLesson.ts` — Agent lesson events (kind 4129)
- `NDKEventMetadata.ts` — Event metadata (kind 513)
- `NDKMCPTool.ts` — MCP tool events
- `NDKProjectStatus.ts` — Project status events (kind 24010)

## Event Kinds

All kind constants are defined in `src/nostr/kinds.ts` — that is the single source of truth. These classes use those constants, never hardcoded numbers.

## Adding New Events

1. Create `NDK<Name>.ts` extending the appropriate NDK class
2. Add the kind constant to `src/nostr/kinds.ts`
3. Export from `index.ts`
