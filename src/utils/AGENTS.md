# utils/ — TENEX Utilities (Layer 1)

TENEX-specific helpers that don't need service state. Can import from `lib/` and npm packages but NOT from `services/`, `agents/`, or `commands/`.

When a utility needs data from services, accept it as a parameter — don't import services directly.

## Contents

- `git/` — Git operations including worktree management
- `logger.ts` — TENEX logging configuration
- `delegation-chain.ts` — Delegation chain tracking
- `nostr-entity-parser.ts` — Nostr entity (npub, note, etc.) parsing
- `lessonFormatter.ts` — Lesson content formatting
- `conversation-id.ts` — Conversation identifier helpers
- `metadataKeys.ts` — Metadata key constants
- `sqlEscaping.ts` — SQL escaping utilities
- `cli-theme.ts`, `cli-error.ts` — CLI display helpers
- `error-handler.ts` — Error handling utilities

## Boundary

If it's pure and reusable in any project → move to `lib/`. If it needs state or coordinates workflows → move to `services/`.
