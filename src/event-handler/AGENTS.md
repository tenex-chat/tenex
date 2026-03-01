# event-handler/ — Event Processing (Layer 4)

Domain orchestrators triggered by incoming Nostr events. Decode events, resolve participants, delegate to services. Handlers should be thin — decode, resolve, delegate.

## Contents

- `newConversation.ts` — New conversation creation
- `reply.ts` — Replies to existing conversations
- `project.ts` — Project-level events
- `agentDeletion.ts` — Agent deletion handling
- `index.ts` — Main exports

## Rules

- Handlers decode via `AgentEventDecoder`, resolve participants, then delegate to `services/dispatch/`
- No business logic in handlers — that belongs in services
- Handlers don't import other handlers — they're independent
- Always handle errors and report via Nostr when appropriate
