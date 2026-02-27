# TENEX Development Standards

You are working on TENEX, a multi-agent AI coordination system built on Nostr.

## ABSOLUTE RULES - NO EXCEPTIONS

### NO TEMPORARY SOLUTIONS
The following are **NEVER acceptable**:
- "temporary", "for now", "placeholder", "TODO", "FIXME", "HACK"
- "legacy", "backwards compatible", "deprecated but kept"
- "we can refactor later", "quick fix", "workaround"
- Comments explaining why bad code exists instead of fixing it
- Wrapper classes like `Enhanced*`, `New*`, `*V2`
- Re-exporting old interfaces for compatibility
- `_unusedVar` patterns - delete unused code entirely

**If code isn't right, fix it properly or don't write it.**

### NO OVER-ENGINEERING
- Don't add features beyond what's requested
- Don't create abstractions for single-use code
- Don't add "just in case" error handling
- Don't wrap libraries unnecessarily
- Three similar lines > premature abstraction

### NDK USAGE
- Import NDK types directly from `@nostr-dev-kit/ndk` for typing
- Use `src/nostr` wrappers (`AgentPublisher`, `AgentEventEncoder/Decoder`, `ndkClient`) for publishing and decoding
- Avoid ad-hoc NDK access outside `nostr/` unless tests need mocks

---

## Architecture

### Layer Hierarchy (Dependencies Flow DOWN Only)
```
Layer 4: commands/ daemon/ event-handler/
    ↓
Layer 3: services/ agents/ conversations/ tools/
    ↓
Layer 2: llm/ nostr/ prompts/ events/
    ↓
Layer 1: utils/
    ↓
Layer 0: lib/  ← ZERO TENEX imports
```

**Violations are blocking errors. No exceptions.**

### Layer Rules

| Layer | Can Import | Cannot Import |
|-------|------------|---------------|
| `lib/` | Node built-ins, npm only | ANY `@/` imports |
| `utils/` | `lib/` | `services/`, `agents/`, `commands/` |
| `services/` | `utils/`, `lib/`, `llm/`, `nostr/` | `commands/`, `daemon/`, `event-handler/` |
| `commands/` | Everything below | N/A |

### Services Organization
```
services/
├── ral/           ← Delegation/RAL state
│   ├── RALRegistry.ts
│   └── types.ts
├── rag/
├── mcp/
├── ConfigService.ts  ← Small services at root
└── ...
```

**Rule:** Create subdirectory when 3+ related files exist.

---

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Services | `*Service` suffix | `ProjectStatusService` |
| Files (services) | PascalCase | `ProjectStatusService.ts` |
| Files (utils) | kebab-case | `error-formatter.ts` |
| Types | `types.ts` or inline | `types.ts` |
| Tests | `*.test.ts` in `__tests__/` | `__tests__/Foo.test.ts` |

---

## Import Patterns

```typescript
// CORRECT: Direct imports with @/ alias
import { RALRegistry } from "@/services/ral";
import { formatAnyError } from "@/lib/error-formatter";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// WRONG: Barrel imports
import { RALRegistry } from "@/services";

// WRONG: Relative cross-module imports
import { config } from "../../../services/ConfigService";
```

---

## Before Writing Code

### MANDATORY - Answer These Questions First:
1. **Where does this code belong?** (Check layer hierarchy)
2. **Does similar code already exist?** (Search before creating)
3. **What's the minimal change needed?** (No scope creep)
4. **Am I about to write a TODO?** (Stop. Fix it now or don't do it)

### When Modifying Existing Code:
1. Read the file first - understand before changing
2. Follow existing patterns in that file
3. Don't "improve" unrelated code
4. Don't add comments to code you didn't change

---

## Anti-Patterns to Reject

### Layer Violations
```typescript
// REJECT: utils importing services
// utils/something.ts
import { config } from "@/services/ConfigService";  // ❌

// FIX: Move to services/ or pass config as parameter
```

### Backwards Compatibility
```typescript
// REJECT: Keeping old interface
export { OldName as NewName };  // ❌
export const legacyMethod = newMethod;  // ❌

// FIX: Just rename it. Update all call sites.
```

### Unused Code
```typescript
// REJECT: Underscore prefix for unused
const _oldValue = compute();  // ❌

// FIX: Delete it entirely
```

### God Classes
```typescript
// REJECT: Class doing everything
class ConversationManager {
  fetch() { }
  persist() { }
  format() { }
  summarize() { }
  // ... 50 more methods
}

// FIX: Split into focused services
```

---

## Tool Implementations

Tools in `src/tools/implementations/` should:
- Be single-purpose (one file = one tool)
- Delegate business logic to services
- Never hold state
- Follow naming: `<domain>_<action>.ts`

```typescript
// CORRECT: Tool delegates to service
import { RAGService } from "@/services/rag";

export const rag_search = tool({
  execute: async ({ query }) => {
    const ragService = new RAGService();
    return await ragService.query(query);
  }
});

// WRONG: Tool implements business logic directly
export const rag_search = tool({
  execute: async ({ query }) => {
    const db = await lancedb.connect();
    // ... 100 lines of implementation
  }
});
```

---

## References

- **Full architecture guide:** `docs/ARCHITECTURE.md`
- **Module inventory:** `MODULE_INVENTORY.md`
- **Testing status:** `docs/TESTING_STATUS.md`

---

## Summary

1. **No temporary solutions** - Do it right or don't do it
2. **No backwards compatibility** - Clean breaks only
3. **No over-engineering** - Minimal changes for the task
4. **Respect layer boundaries** - Dependencies flow down
5. **Use `nostr/` wrappers** - Keep NDK publishing/decoding inside `src/nostr`
6. **Delete unused code** - Don't comment or underscore it
