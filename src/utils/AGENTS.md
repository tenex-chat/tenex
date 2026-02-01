# TENEX Utilities (Layer 1)

## Directory Purpose
Higher-level utility functions **tied to TENEX behavior**. Can import from `lib/` and npm packages, but **NOT from `services/`, `agents/`, or `commands/`**.

## Layer Rules
```typescript
// ALLOWED
import { formatAnyError } from "@/lib/error-formatter";
import { NDKEvent } from "@nostr-dev-kit/ndk";

// FORBIDDEN - Layer violation
import { config } from "@/services/ConfigService";
import { AgentExecutor } from "@/agents/execution";
```

## Commands

```bash
# Test this directory
bun test src/utils/

# Check for layer violations
bun run lint:architecture
```

## Directory Contents

| File/Directory | Purpose |
|---------------|---------|
| `git/` | Git operations including worktree management |
| `git/worktree.ts` | Git worktree creation, listing, cleanup |
| `agentFetcher.ts` | Agent discovery and fetching |
| `delegation-chain.ts` | Delegation chain tracking utilities |
| `nostr-entity-parser.ts` | Nostr entity (npub, note, etc.) parsing |
| `logger.ts` | TENEX logging configuration |
| `lessonFormatter.ts` | Lesson content formatting |
| `phase-utils.ts` | Agent phase determination helpers |
| `lockfile.ts` | File locking utilities (accepts path parameter) |

## Conventions

### What Belongs Here
- TENEX-specific helpers that don't need service state
- Parsing/formatting utilities for TENEX data types
- Git operations that don't need project context
- Pure transformation functions for TENEX domain

### What Does NOT Belong Here
- Stateful logic → move to `services/`
- Pure utilities without TENEX dependency → move to `lib/`
- Agent execution logic → move to `agents/`
- Configuration access → pass as parameter or move to `services/`

### Parameter Injection Pattern
When a utility needs data from services, accept it as a parameter:

```typescript
// CORRECT: Accept path as parameter
export function cleanupWorktree(projectsConfigPath: string, name: string) {
  // Implementation uses the passed path
}

// WRONG: Import from services
import { config } from "@/services/ConfigService";
export function cleanupWorktree(name: string) {
  const path = config.getConfigPath();  // Layer violation!
}
```

## Git Utilities (`git/`)

The `git/` subdirectory contains all Git-related operations:

```typescript
import {
  createWorktree,
  listWorktrees,
  removeWorktree
} from "@/utils/git/worktree";
```

Key functions:
- `createWorktree()` - Create isolated worktree for parallel work
- `listWorktrees()` - List all active worktrees
- `removeWorktree()` - Clean up completed worktrees
- `getWorktreeMetadata()` - Get metadata about a worktree

## Anti-Patterns

```typescript
// REJECT: Accessing services directly
import { RALRegistry } from "@/services/ral";

// REJECT: Holding state
let cachedData = null;  // Should be in a service

// REJECT: Business logic
async function executeAgent() { }  // Should be in agents/
```

## Related
- `../lib/` - Pure utilities (Layer 0)
- `../services/` - Stateful services (Layer 3)
- Parent [MODULE_INVENTORY.md](../../MODULE_INVENTORY.md)
