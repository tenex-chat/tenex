# TENEX Backend Repository Guidelines

## Overview
TENEX is a multi-agent AI coordination system built on Nostr. This Bun CLI application enables agents to collaborate, delegate tasks, and maintain persistent conversations across a distributed network.

## Quick Reference

### Essential Commands
```bash
bun run start              # Run CLI
bun run build              # Build to dist/
bun test                   # Run all tests
bun test --watch           # Watch mode
bun test --coverage        # With coverage
bun run typecheck          # TypeScript strict check
bun run lint               # ESLint
bun run lint:architecture  # Layer violation check
```

### Layer Architecture
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

## Project Structure & Module Organization
Runtime entry is `src/tenex.ts`. Core domains are accessed via `@/` alias:

| Directory | Layer | Purpose |
|-----------|-------|---------|
| `src/agents/` | 3 | Agent execution, registration, supervision |
| `src/services/` | 3 | Stateful orchestration, configuration |
| `src/conversations/` | 3 | Conversation persistence, formatting |
| `src/tools/` | 3 | Tool implementations (57+) |
| `src/llm/` | 2 | LLM provider abstraction |
| `src/nostr/` | 2 | Nostr protocol wrappers |
| `src/prompts/` | 2 | Prompt composition, fragments |
| `src/events/` | 2 | Event schemas, constants |
| `src/utils/` | 1 | TENEX-specific utilities |
| `src/lib/` | 0 | Pure utilities (NO @/ imports) |
| `src/commands/` | 4 | CLI entry points |
| `src/daemon/` | 4 | Background orchestration |
| `src/event-handler/` | 4 | Event processing |

Supporting directories:
- `scripts/` - Build scripts, telemetry helpers
- `tools/` - Supporting tooling
- `dist/` - Bundled output
- `tests/` - E2E tests (see `E2E_TESTING_ARCHITECTURE.md`)

## System Inventory & Code Organization
Use `MODULE_INVENTORY.md` as the canonical map of components. Consult it before writing code to confirm where work belongs. Update it in the same PR whenever a module's responsibility shifts.

**Key principles:**
- Thin commands (delegate to services)
- Orchestration in `src/services`
- Pure helpers in `src/lib`
- Tools host all IO operations

## Coding Style & Naming Conventions

### Formatting
- **Formatter**: Biome (4 spaces, double quotes, trailing commas)
- **Linter**: ESLint with strict TypeScript rules
- **Compiler flags**: `strict`, `noUnused*`, `isolatedModules`

### Naming
| Type | Convention | Example |
|------|------------|---------|
| Directories | kebab-case | `event-handler/` |
| Services/Classes | PascalCase | `ConfigService.ts` |
| Utilities | kebab-case | `error-formatter.ts` |
| Tools | `<domain>_<action>` | `rag_search.ts` |
| Tests | `*.test.ts` in `__tests__/` | `AgentExecutor.test.ts` |

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

## Testing Guidelines
- Unit tests: `src/**/__tests__/*.test.ts`
- Integration tests: `*.integration.test.ts`
- E2E tests: `tests/` directory

Run `bun test` and `bun run typecheck` for every PR. Add `--coverage` when touching routing, telemetry, or services.

Use test utilities from `src/test-utils/`:
- `mock-llm/` - Mock LLM providers
- Nostr fixtures
- Scenario harnesses

## Commit & Pull Request Guidelines
Follow Conventional Commits: `refactor:`, `feat:`, `fix:`, `docs:`, `test:`

**PR checklist:**
- [ ] Problem statement
- [ ] Commands run (`bun test`, `bun run lint`, etc.)
- [ ] Linked issues
- [ ] Doc/test updates for code changes
- [ ] Screenshots/logs for UI or agent-output changes

## Key Architectural Rules

### ABSOLUTE: No Temporary Solutions
Never acceptable: "TODO", "FIXME", "HACK", "temporary", "backwards compatible", wrapper classes like `*V2`

### Configuration Access
```typescript
// Always use ConfigService
import { config } from "@/services/ConfigService";
const path = config.getConfigPath("agents");

// Never construct paths manually
const path = `${process.env.HOME}/.tenex/...`;  // WRONG
```

### NDK/Nostr Access
```typescript
// Use wrappers from src/nostr/
import { AgentPublisher } from "@/nostr/AgentPublisher";

// Never use NDK directly outside nostr/
import { NDKEvent } from "@nostr-dev-kit/ndk";  // Only for types
```

### Event Kinds
All Nostr event kinds used by TENEX are defined in `src/nostr/kinds.ts`. This is the single source of truth — never hardcode kind numbers elsewhere. The `src/events/AGENTS.md` and `src/nostr/AGENTS.md` files contain detailed reference tables.

### Tools Pattern
Tools delegate to services, never hold state:
```typescript
// CORRECT
export const my_tool = tool({
  execute: async (params) => {
    const service = new MyService();
    return service.process(params);
  }
});
```

## Related Documentation
- [MODULE_INVENTORY.md](MODULE_INVENTORY.md) - Canonical architecture reference
- [CLAUDE.md](CLAUDE.md) - Development standards
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - Full architecture guide
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) - Developer workflow
- [E2E_TESTING_ARCHITECTURE.md](E2E_TESTING_ARCHITECTURE.md) - E2E testing guide
