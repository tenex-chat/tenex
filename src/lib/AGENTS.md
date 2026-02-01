# Pure Utilities (Layer 0)

## Directory Purpose
Framework-agnostic, **pure utility functions** with **ZERO TENEX dependencies**. This is the lowest layer of the architecture - nothing in this directory can import from `@/` paths.

## CRITICAL RULE
```typescript
// FORBIDDEN - Will break layered architecture
import { anything } from "@/services/...";
import { anything } from "@/utils/...";
import { logger } from "@/utils/logger";

// ALLOWED
import { something } from "npm-package";
import * as fs from "node:fs";
console.error("Use console, not TENEX logger");
```

## Commands

```bash
# Test this directory
bun test src/lib/

# Verify no layer violations
bun run lint:architecture
```

## Directory Contents

| File/Directory | Purpose |
|---------------|---------|
| `fs/` | Filesystem operations (mkdir, readdir, exists, etc.) |
| `string.ts` | String manipulation utilities |
| `error-formatter.ts` | Error formatting for display |
| `time.ts` | Time/date utilities |
| `json-parser.ts` | Safe JSON parsing |
| `validation.ts` | Generic validation helpers |

## Conventions

### What Belongs Here
- Platform-level primitives
- Pure functions with no side effects (except `fs/`)
- Framework-agnostic utilities
- Code reusable in any Node/Bun project

### What Does NOT Belong Here
- Anything TENEX-specific → move to `utils/`
- Code requiring configuration → move to `services/`
- Code with Nostr dependencies → move to `nostr/`
- Code needing logging → use `console.error`

### Error Handling
```typescript
// CORRECT: Use console for errors
console.error("Something went wrong:", error);

// WRONG: Using TENEX logger
import { logger } from "@/utils/logger";  // Layer violation!
```

## Anti-Patterns

```typescript
// REJECT: Importing from TENEX modules
import { config } from "@/services/ConfigService";

// REJECT: Using TENEX-specific types
import type { AgentContext } from "@/agents/types";

// REJECT: Domain-specific logic
function formatAgentResponse() { }  // Too TENEX-specific
```

## Related
- `../utils/` - TENEX-specific utilities (Layer 1)
- Parent [MODULE_INVENTORY.md](../../MODULE_INVENTORY.md)
