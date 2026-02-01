# Source Directory Guidelines

## Directory Purpose
Entry point for all TENEX source code. This directory contains the layered architecture of the multi-agent AI coordination system.

## Layer Architecture
Dependencies flow **DOWN only**. Violations are blocking errors.

```
Layer 4: commands/ daemon/ event-handler/     [Entrypoints]
    ↓
Layer 3: services/ agents/ conversations/ tools/  [Domain Logic]
    ↓
Layer 2: llm/ nostr/ prompts/ events/            [Protocol/Abstraction]
    ↓
Layer 1: utils/                                   [TENEX-specific helpers]
    ↓
Layer 0: lib/                                     [Pure utilities - ZERO @/ imports]
```

## Commands

```bash
# From project root:
bun test src/              # Run all unit tests
bun test src/**/__tests__/*.test.ts  # Unit tests only
bun test src/**/__tests__/*.integration.test.ts  # Integration tests
bun run typecheck          # Strict TypeScript check
bun run lint               # ESLint on src/
bun run lint:architecture  # Check layering rules
```

## Conventions

### Import Patterns
```typescript
// CORRECT: Direct imports with @/ alias
import { RALRegistry } from "@/services/ral";
import { formatAnyError } from "@/lib/error-formatter";

// WRONG: Barrel imports
import { RALRegistry } from "@/services";

// WRONG: Relative cross-module imports
import { config } from "../../../services/ConfigService";
```

### File Naming
- **Services/Classes**: PascalCase (`ConfigService.ts`)
- **Utilities**: kebab-case (`error-formatter.ts`)
- **Tests**: `*.test.ts` in `__tests__/` subdirectory
- **Types**: `types.ts` in same directory

### Directory Organization
- Create subdirectory when **3+ related files** exist
- Prefer domain folders over dumping helpers in `utils/`
- Service files get `*Service` suffix

## Key Entry Points
- `tenex.ts` - Main CLI runtime entry
- `cli.ts` - Commander CLI skeleton
- `index.ts` - Module exports

## Related Documentation
- [MODULE_INVENTORY.md](../MODULE_INVENTORY.md) - Canonical architecture reference
- [CLAUDE.md](../CLAUDE.md) - Development standards
- [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) - Full architecture guide
