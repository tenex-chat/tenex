# TENEX

Multi-agent AI coordination system built on Nostr. Bun CLI application.

## Commands

```bash
bun test                   # Run all tests
bun run typecheck          # TypeScript strict check
bun run lint               # ESLint
bun run lint:architecture  # Layer violation check
```

## Layer Architecture

Dependencies flow DOWN only. Violations are blocking errors.

```
Layer 4: commands/ daemon/ event-handler/
Layer 3: services/ agents/ conversations/ tools/
Layer 2: llm/ nostr/ prompts/ events/
Layer 1: utils/
Layer 0: lib/  (ZERO @/ imports)
```

## Key Rules

- Use `@/` alias for all cross-module imports. No barrel imports, no deep relative paths.
- Use `src/nostr/` wrappers (`AgentPublisher`, `AgentEventEncoder/Decoder`, `ndkClient`) for publishing/decoding. Import NDK types only for typing.
- Use `ConfigService` for all config/path access. Never construct `~/.tenex` paths manually.
- Tools delegate to services, never hold state.
- Event kinds live in `src/nostr/kinds.ts`. Never hardcode kind numbers.
- `MODULE_INVENTORY.md` is the canonical map of components. Consult before writing code.

## Naming

- Services/Classes: PascalCase files, `*Service` suffix
- Utilities: kebab-case files
- Tools: `<domain>_<action>.ts`
- Tests: `*.test.ts` in `__tests__/` subdirectories
