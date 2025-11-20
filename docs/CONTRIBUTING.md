# Contributing to TENEX

## Development Workflow

### Setup
```bash
# Install dependencies
bun install

# Run tests
bun test

# Run type checking
bun run typecheck

# Run architecture linting
bun run lint:architecture
```

---

## Before You Code

### 1. Read the Architecture Guide
Familiarize yourself with [ARCHITECTURE.md](./ARCHITECTURE.md) to understand:
- Layered architecture
- Dependency rules
- Naming conventions
- Where to put new code

### 2. Check Existing Patterns
Look for similar code in the codebase and follow established patterns.

### 3. Plan Your Changes
- What layer does this belong in?
- Does this create any circular dependencies?
- Is naming consistent with existing code?

---

## Coding Guidelines

### File Organization

**Put code in the right layer:**
- **Pure utilities** → `src/lib/`
- **TENEX helpers** → `src/utils/`
- **Business logic** → `src/services/`
- **Domain logic** → `src/agents/`, `src/conversations/`, `src/tools/`
- **Entry points** → `src/commands/`, `src/daemon/`, `src/event-handler/`

**Create subdirectories** when you have 3+ related files:
```
services/
├── my-feature/
│   ├── MyFeatureService.ts
│   ├── types.ts
│   ├── helper.ts
│   └── index.ts
```

---

### Naming Conventions

**Services:** Use `Service` suffix
```typescript
// ✅ Good
class NotificationService { }
class EmailService { }

// ⚠️ Acceptable (legacy)
class ReportManager { }  // Rename when convenient
```

**Files:** Match the class name
```typescript
// NotificationService.ts
export class NotificationService { }
```

**Utilities:** Use descriptive names
```typescript
// agent-resolution.ts
export function resolveAgent() { }
```

---

### Import Patterns

**Use @/ alias for absolute imports:**
```typescript
// ✅ Good
import { config } from "@/services/ConfigService";
import { formatAnyError } from "@/lib/error-formatter";

// ❌ Bad
import { config } from "../../../services/ConfigService";
```

**Import directly from service directories:**
```typescript
// ✅ Good
import { RAGService } from "@/services/rag";
import { DelegationService } from "@/services/delegation";

// ❌ Bad (avoid barrel imports)
import { RAGService, DelegationService } from "@/services";
```

---

### Dependency Management

**Declare dependencies explicitly:**
```typescript
export class MyService {
    constructor(
        private readonly config: ConfigService,
        private readonly logger: Logger
    ) {}
}

// Export convenience instance
export const myService = new MyService(config, logger);
```

**Check dependency direction:**
- `lib/` → No TENEX imports
- `utils/` → Can import `lib/`
- `services/` → Can import `utils/`, `lib/`, `nostr/`, `llm/`
- `commands/` → Can import `services/` and below

---

## Testing

### Co-locate Tests
Tests live next to the code they test:
```
services/
├── my-feature/
│   ├── MyFeatureService.ts
│   ├── __tests__/
│   │   └── MyFeatureService.test.ts
│   └── index.ts
```

### Test Pure Functions
Pure utilities in `lib/` should be easy to test:
```typescript
import { describe, expect, it } from "bun:test";
import { toKebabCase } from "@/lib/string";

describe("toKebabCase", () => {
    it("converts PascalCase to kebab-case", () => {
        expect(toKebabCase("HelloWorld")).toBe("hello-world");
    });
});
```

### Test Services with DI
Use dependency injection for testability:
```typescript
import { describe, expect, it } from "bun:test";
import { MyService } from "../MyService";

describe("MyService", () => {
    it("does something", () => {
        const mockConfig = { get: () => "test-value" };
        const mockLogger = { info: () => {} };
        const service = new MyService(mockConfig, mockLogger);

        expect(service.doSomething()).toBe("expected-result");
    });
});
```

---

## Commit Guidelines

### Commit Messages
Follow conventional commits:
```
feat: add notification service
fix: resolve circular dependency in lib/fs
refactor: rename ReportManager to ReportService
docs: update architecture guide
test: add tests for RAG service
```

### Pre-Commit Hook
Our pre-commit hook runs architecture checks using Claude Code:
- Checks for circular dependencies
- Verifies layer boundaries
- Validates naming conventions
- Suggests improvements

**If blocked:**
1. Read the error message carefully
2. Fix the architectural violation
3. Or ask in PR if you believe it's a false positive

---

## Architecture Linting

### Run Manually
```bash
bun run lint:architecture
```

### What It Checks
- ✅ `lib/` has no imports from `utils/` or `services/`
- ✅ No circular dependencies
- ✅ Service naming conventions
- ✅ Import patterns

---

## Common Tasks

### Adding a New Utility

**If it's pure (no TENEX deps):**
```typescript
// src/lib/my-util.ts
export function myUtil(input: string): string {
    return input.toUpperCase();
}
```

**If it's TENEX-specific:**
```typescript
// src/utils/my-helper.ts
import { formatAnyError } from "@/lib/error-formatter";

export function myHelper(agent: AgentInstance): string {
    // ... TENEX-specific logic
}
```

---

### Adding a New Service

**1. Create service directory:**
```bash
mkdir -p src/services/my-feature
```

**2. Create service file:**
```typescript
// src/services/my-feature/MyFeatureService.ts
import { config } from "@/infrastructure/config";
import { logger } from "@/infrastructure/logger";

export class MyFeatureService {
    constructor(
        private readonly config: ConfigService,
        private readonly logger: Logger
    ) {}

    doSomething(): void {
        this.logger.info("Doing something");
    }
}

export const myFeatureService = new MyFeatureService(config, logger);
```

**3. Create types file:**
```typescript
// src/services/my-feature/types.ts
export interface MyFeatureConfig {
    enabled: boolean;
}
```

**4. Create index.ts:**
```typescript
// src/services/my-feature/index.ts
export { MyFeatureService, myFeatureService } from "./MyFeatureService";
export type { MyFeatureConfig } from "./types";
```

**5. Use in other code:**
```typescript
import { myFeatureService } from "@/services/my-feature";

myFeatureService.doSomething();
```

---

### Adding a New Tool

```typescript
// src/tools/implementations/my_tool.ts
import type { ExecutionContext } from "@/agents/execution/types";
import { tool } from "ai";
import { z } from "zod";

const myToolSchema = z.object({
    input: z.string().describe("The input to process"),
});

async function executeMyTool(
    input: z.infer<typeof myToolSchema>,
    context: ExecutionContext
): Promise<{ result: string }> {
    // Implementation
    return { result: "success" };
}

export const my_tool = tool({
    description: "Does something useful",
    parameters: myToolSchema,
    execute: async (input, { context }) => {
        return await executeMyTool(input, context);
    },
});
```

---

## Boy Scout Rule

**Always leave code better than you found it.**

When working in a file:
- Fix obvious issues nearby
- Improve naming if unclear
- Add comments if confusing
- Move misplaced code to correct layer
- Update imports to use @/ alias

**Small improvements compound over time.**

---

## Getting Help

### Architecture Questions
1. Check [ARCHITECTURE.md](./ARCHITECTURE.md) first
2. Search for similar code in the codebase
3. Ask in PR review
4. Consult with team

### Blocked by Pre-Commit Hook?
The hook uses Claude Code to review commits. If blocked:
1. Read the feedback carefully
2. Fix the architectural issue
3. Check if you're introducing circular dependencies
4. Verify you're adding code to the right layer

**The hook is strict but helpful** - it prevents technical debt.

---

## Pull Request Checklist

Before submitting:
- [ ] Tests pass: `bun test`
- [ ] Types check: `bun run typecheck`
- [ ] Architecture lint passes: `bun run lint:architecture`
- [ ] Pre-commit hook passes (commit locally first)
- [ ] Code follows naming conventions
- [ ] No circular dependencies introduced
- [ ] Code is in the correct layer
- [ ] Documentation updated if needed

---

## Advanced Topics

### Refactoring Services
When refactoring legacy code:
1. Don't change everything at once
2. Rename files first (update imports)
3. Rename classes in separate PR
4. Add DI gradually
5. Group into subdirectories when beneficial

### Breaking Changes
**This is unreleased software** - no backwards compatibility required.
- Break things to make them better
- Clean, modern code over legacy support
- No deprecated patterns

---

## Questions?

If you're unsure about anything:
- Check [ARCHITECTURE.md](./ARCHITECTURE.md)
- Look for similar patterns in the codebase
- Ask in PR review
- Trust the pre-commit hook feedback

**When in doubt, ask!**
