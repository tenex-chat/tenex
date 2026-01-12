# Repository Guidelines

## Project Structure & Module Organization
TENEX is a Bun CLI with its runtime entry in `src/tenex.ts`; core domains live in `src/agents`, `src/commands`, `src/conversations`, `src/daemon`, `src/events`, `src/llm`, `src/nostr`, `src/prompts`, `src/services`, and `src/tools`, all accessed with the `@/` alias. Scripts covering builds, telemetry, and compatibility reside in `scripts/`, supporting tooling lives under `tools/`, bundled output lands in `dist/`, and e2e docs live in `tests/` and `E2E_TESTING_ARCHITECTURE.md`.

## System Inventory & Code Organization
Use `MODULE_INVENTORY.md` as the canonical map of components, services, and utilities. Consult it before writing code to confirm where work belongs, and update it in the same PR whenever a module’s responsibility shifts. If conventions are fuzzy, log the situation in the \"Mixed Patterns\" section so follow-up refactors are tracked. Follow the domain-first placement rules captured there (thin commands, orchestration in `src/services`, pure helpers in `src/lib`, tools hosting all IO) and call out any exception inside the PR description in addition to the inventory.

## Build, Test, and Development Commands
`bun run start` exercises the CLI entry, while `bun run build` produces the bundled distribution in `dist/`. Run `bun test` before every push; add `--watch` or `--coverage` locally when needed. `bun run typecheck` (wrapper around `scripts/typecheck.sh`) enforces strict TS flags, `bun run lint` applies ESLint, and `bun run lint:architecture` checks layering.

## Coding Style & Naming Conventions
Source files are TypeScript ES modules formatted per the Biome config (4 spaces, double quotes, trailing commas) and linted by ESLint; keep strict compiler flags (`strict`, `noUnused*`, `isolatedModules`) satisfied. Directories use kebab-case, service/class files use PascalCase, and helper/util files use kebab-case or camelCase within a folder’s conventions. Prefer domain folders over dumping helpers in `utils/`, and import shared helpers via `@/…` so bundling stays consistent.

## Testing Guidelines
Place unit tests beside their targets under `src/**/__tests__` with `*.test.ts` names; integration suites use `*.integration.test.ts`, and e2e flows run in `tests/` per `E2E_TESTING_ARCHITECTURE.md`. Run `bun test` and `bun run typecheck` for every PR, adding `bun test --coverage` when touching routing, telemetry, or services. Use descriptive `describe` labels and clean up fake nostr clients or mock LLM providers to avoid leaked handles.

## Commit & Pull Request Guidelines
Follow the Conventional Commit style seen in history (`refactor: …`, `feat: …`) so changelog tooling stays accurate. Keep commits small, scoped to one domain surface, and include doc/test updates. Pull requests need a problem statement, a checklist of commands run (`bun test`, `bun run lint`, etc.), linked issues, and screenshots or logs for UI or agent-output changes; call out any config or secrets reviewers require.
