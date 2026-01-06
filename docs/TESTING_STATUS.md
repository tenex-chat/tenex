# Testing Status

This file is intentionally lightweight. For current status, run:

```bash
bun test
bun run typecheck
```

## Current State

- Unit and integration tests run under Bun test.
- The mock LLM service is available in `src/test-utils/mock-llm` for deterministic testing.
- An end-to-end harness is not yet implemented (see `E2E_TESTING_ARCHITECTURE.md` for the original design).

## Guidance

- Co-locate tests under `src/**/__tests__` with `*.test.ts` names.
- Add `bun test --coverage` when touching routing, telemetry, or services.
- Prefer NDK test helpers via `src/test-utils/ndk-test-helpers.ts`.
