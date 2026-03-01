# prompts/ — Prompt Composition (Layer 2)

Reusable prompt building and system prompt assembly. Execution modules import builders from here — never inline long prompt strings.

## Structure

- `core/` — `SystemPromptBuilder` and core prompt assembly
- `fragments/` — 26+ reusable prompt fragment subdirectories organized by concern (agent-identity, tool-usage, response-format, context-injection, delegation, conversation, etc.)
- `utils/` — Interpolation, validation, and composition utilities
- `index.ts` — Public exports

## Rules

- Fragments are pure functions that return strings. No state, no side effects.
- Business logic (filtering tools, resolving agents) does not belong here — pass pre-processed data in.
- Hardcoded model names or provider-specific content should be parameterized.

## Adding Fragments

Create a subdirectory in `fragments/` with an `index.ts` exporting a function that takes options and returns a string.
