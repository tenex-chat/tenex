# TENEX Architecture Guide

## Table of Contents
- [Core Principles](#core-principles)
- [Layered Architecture](#layered-architecture)
- [Module Organization](#module-organization)
- [Naming Conventions](#naming-conventions)
- [Import Patterns](#import-patterns)
- [Adding New Code](#adding-new-code)
- [Anti-Patterns to Avoid](#anti-patterns-to-avoid)

---

## Core Principles

### 1. **Unidirectional Dependencies**
Dependencies flow **downward only**, never upward:

```
commands/daemon/event-handler → services/agents/conversations/tools
  ↓
llm/nostr/prompts/events
  ↓
utils
  ↓
lib
```

**Rule:** Lower layers never import from higher layers.

### 2. **Pure Utilities in lib/**
The `lib/` layer contains **zero TENEX-specific code**. These are pure, reusable utilities that could work in any Node.js project:
- Filesystem operations
- String manipulation
- Time formatting
- Validation helpers
- Error formatting

**Rule:** `lib/` has NO imports from `utils/`, `services/`, or any TENEX modules.

### 3. **TENEX-Specific Utilities in utils/**
The `utils/` layer contains helpers specific to TENEX's domain:
- Nostr entity parsing
- Agent resolution
- Phase management
- Git operations
- Conversation utilities

**Rule:** `utils/` can import from `lib/` but not from `services/` or higher layers.

### 4. **Business Logic in services/**
The `services/` layer contains stateful business logic and domain services:
- Configuration management
- RAG operations
- Scheduling
- Delegation
- MCP integration

**Rule:** Services can import from `utils/`, `lib/`, `nostr/`, `llm/`, but not from `commands/`, `daemon/`, or `event-handler/`.

---

## Layered Architecture

### Layer 0: Platform Primitives (`lib/`)
**Purpose:** Framework-agnostic utilities

**Contains:**
- `lib/fs/` - Filesystem operations
- `lib/shell.ts` - Shell execution
- `lib/string.ts` - String utilities
- `lib/validation.ts` - Validation helpers
- `lib/formatting.ts` - Text formatting
- `lib/error-formatter.ts` - Error formatting
- `lib/time.ts` - Time utilities

**Dependencies:** Node.js built-ins, npm packages only

**Example:**
```typescript
// ✅ Good - pure utility
export function toKebabCase(str: string): string {
    return str.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

// ❌ Bad - depends on TENEX code
import { config } from "@/services/ConfigService";
```

---

### Layer 1: TENEX Utilities (`utils/`)
**Purpose:** Domain-specific helpers

**Contains:**
- `utils/nostr/` - Nostr parsing utilities
- `utils/git/` - Git operations (including worktree management)
- `utils/agent-resolution.ts` - Agent lookup helpers
- `utils/phase-utils.ts` - Phase management
- `utils/conversation-utils.ts` - Conversation helpers
- `utils/logger.ts` - Logging (can depend on services/config)

**Dependencies:** `lib/`, Node.js built-ins, npm packages

**Example:**
```typescript
// ✅ Good - TENEX-specific helper using lib utilities
import { formatAnyError } from "@/lib/error-formatter";

export function parseNostrUser(input: string): { pubkey: string } | null {
    // ... implementation
}
```

---

### Layer 2: Protocol & Abstraction Layers
**Modules:** `events/`, `nostr/`, `llm/`, `prompts/`

**Purpose:** Protocol implementations and provider abstractions

**Dependencies:** `utils/`, `lib/`

---

### Layer 3: Domain Logic
**Modules:** `services/`, `agents/`, `conversations/`, `tools/`

**Purpose:** Business logic, state management, capabilities

**Dependencies:** Everything below (layers 0-2)

---

### Layer 4: Application Entry Points
**Modules:** `commands/`, `daemon/`, `event-handler/`

**Purpose:** CLI, runtime orchestration, event routing

**Dependencies:** Everything below (layers 0-3)

---

## Module Organization

### Services Directory Structure

Services should be organized by domain, with related code grouped together:

```
services/
├── delegation/           # Delegation domain
│   ├── DelegationService.ts
│   ├── DelegationRegistry.ts
│   ├── types.ts
│   └── index.ts
├── rag/                  # RAG domain
│   ├── RAGService.ts
│   ├── SubscriptionService.ts
│   ├── ...
│   └── index.ts
├── scheduling/
├── reports/
├── mcp/
└── ...
```

**When to create a subdirectory:**
- 3+ related files
- Distinct domain boundary
- Internal implementation details to hide

**Small services (1-2 files):** Keep at top level until they grow.

---

## Naming Conventions

### Services
**Preferred suffix:** `Service`

```typescript
// ✅ Preferred
ConfigService
RAGService
SchedulerService
DelegationService

// ✅ All services now use the "Service" suffix.
```

**Goal:** Consistent "Service" suffix for all business logic classes.

**Exception:** Low-level infrastructure managers (e.g., `DatabaseManager`) can keep "Manager" if they're purely technical, not business logic.

---

### File Naming
- **Services:** `SomethingService.ts` (PascalCase)
- **Utilities:** `kebab-case.ts` or `camelCase.ts` (be consistent within a directory)
- **Types:** `types.ts` or `Something.types.ts`
- **Tests:** `Something.test.ts` (co-located in `__tests__/`)

---

## Import Patterns

### Rule 1: No Barrel Exports for Services
**Do NOT** use `services/index.ts` barrel export. Import directly from service directories:

```typescript
// ✅ Good - direct import
import { DelegationService } from "@/services/delegation";
import { RAGService } from "@/services/rag";

// ❌ Bad - barrel import
import { DelegationService, RAGService } from "@/services";
```

**Why:**
- Explicit dependencies
- Better tree-shaking
- Faster TypeScript compilation
- No barrel maintenance

### Rule 2: Subdirectories Control Their Exports
Each service subdirectory has an `index.ts` that controls what's public:

```typescript
// services/delegation/index.ts
export { DelegationService } from "./DelegationService";
export type { DelegationRecord } from "./types";
// DelegationRegistry is internal, not exported
```

### Rule 3: Use @/ Alias
Always use the `@/` path alias for absolute imports:

```typescript
// ✅ Good
import { config } from "@/services/ConfigService";
import { formatAnyError } from "@/lib/error-formatter";

// ❌ Bad - relative imports for cross-module
import { config } from "../../../services/ConfigService";
```

---

## Adding New Code

### Adding a New Utility

**1. Determine if it's pure or TENEX-specific:**
- **Pure** (no TENEX deps) → `lib/`
- **TENEX-specific** → `utils/`

**2. Create the file:**
```typescript
// lib/array-utils.ts (pure utility)
export function chunk<T>(array: T[], size: number): T[][] {
    // ... implementation
}
```

**3. Export from directory index if needed:**
```typescript
// lib/index.ts
export * from "./array-utils";
```

---

### Adding a New Service

**1. Decide if it needs a subdirectory:**
- **Yes** if: 3+ related files, distinct domain
- **No** if: 1-2 files, simple service

**2. Create the service:**
```typescript
// services/notifications/NotificationService.ts
export class NotificationService {
    constructor(
        private readonly config: ConfigService,
        private readonly logger: Logger
    ) {}

    // Methods...
}

// Export default instance for convenience
export const notificationService = new NotificationService(config, logger);
```

**3. Create index.ts:**
```typescript
// services/notifications/index.ts
export { NotificationService, notificationService } from "./NotificationService";
export type { NotificationOptions } from "./types";
```

**4. Import where needed:**
```typescript
import { notificationService } from "@/services/notifications";
```

---

### Adding to Existing Layers

**Adding to lib/:**
- Must be pure, no TENEX dependencies
- No imports from `utils/`, `services/`, etc.
- Use console.error instead of TENEX logger

**Adding to utils/:**
- Can import from `lib/`
- Should be domain helpers, not business logic
- If it needs state, it should be a service instead

**Adding to services/:**
- Can import from `utils/`, `lib/`, `nostr/`, `llm/`, `prompts/`, `events/`
- Cannot import from `commands/`, `daemon/`, `event-handler/`

---

## Anti-Patterns to Avoid

### ❌ Circular Dependencies
```typescript
// lib/something.ts
import { logger } from "@/utils/logger";  // ❌ lib → utils (wrong direction)

// utils/helper.ts
import { someService } from "@/services/SomeService";  // ❌ utils → services
```

**Solution:** Move code to correct layer or use dependency injection.

---

### ❌ Barrel Export Bypass
```typescript
// ❌ Importing from barrel when subdirectory exists
import { RAGService } from "@/services";

// ✅ Import directly from subdirectory
import { RAGService } from "@/services/rag";
```

---

### ❌ Business Logic in Utilities
```typescript
// ❌ Bad - stateful service masquerading as utility
// utils/user-manager.ts
export class UserManager {
    private users: Map<string, User> = new Map();
    // ... state management
}
```

**Solution:** Move to `services/` if it has state or business logic.

---

### ❌ Inconsistent Naming
```typescript
// ❌ Mixed naming styles
ConfigService
ReportManager
SchedulerService
PubkeyNameRepository
```

**Solution:** Standardize on "Service" suffix.

---

## Dependency Injection Pattern

**Recommended pattern for services:**

```typescript
// services/something/SomethingService.ts
export class SomethingService {
    // Declare dependencies in constructor
    constructor(
        private readonly config: ConfigService,
        private readonly logger: Logger,
        private readonly someOtherService: SomeOtherService
    ) {}

    doSomething(): void {
        // Use injected dependencies
        const value = this.config.get("key");
        this.logger.info("Doing something", { value });
    }
}

// Export default instance for convenience
import { config } from "@/infrastructure/config";
import { logger } from "@/infrastructure/logger";
import { someOtherService } from "@/services/some-other";

export const somethingService = new SomethingService(
    config,
    logger,
    someOtherService
);
```

**Benefits:**
- Testable (inject mocks)
- Clear dependencies
- No hidden singletons
- Convenient default instance

---

## Evolution Strategy

### Completed Improvements

- **Pure Utilities in `lib/`**: All pure, framework-agnostic utilities are now isolated in the `lib/` directory with zero TENEX dependencies.
- **No Circular Dependencies**: All circular dependencies between layers have been resolved.
- **Consistent Service Naming**: All services have been refactored to use the `Service` suffix, removing legacy names like `ReportManager` and `PubkeyNameRepository`.
- **Git Utilities Consolidated**: All Git-related helpers, including worktree management, are now centralized in `utils/git/`.
- **Configuration Architecture**: A centralized `ConfigService` now manages all configuration, ensuring consistent and predictable settings management.

### Target State

**We are incrementally moving toward:**
1. ⏳ **Subdirectory Grouping for Services**: Gradually group related services into subdirectories for better organization.
2. ⏳ **Dependency Injection Pattern**: Continue to adopt dependency injection for all services to improve testability and clarity.
3. ⏳ **Removal of Barrel Exports**: Phase out all remaining barrel exports in favor of direct imports.

**Philosophy:** Make incremental improvements. Leave code better than you found it (Boy Scout Rule).

---

## Questions?

If unsure where code belongs:
1. Is it pure/framework-agnostic? → `lib/`
2. Is it a TENEX helper with no state? → `utils/`
3. Does it manage state or business logic? → `services/`
4. Is it protocol-specific? → `nostr/`, `llm/`, etc.

When in doubt, **ask in PR review** or **check this document**.

---

## See Also
- [CONTRIBUTING.md](./CONTRIBUTING.md) - Development workflow
- [MODULE_INVENTORY.md](../MODULE_INVENTORY.md) - Current module list
- [TESTING_STATUS.md](./TESTING_STATUS.md) - Testing guidelines
