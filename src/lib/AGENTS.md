# lib/ — Pure Utilities (Layer 0)

Framework-agnostic utility functions with ZERO TENEX dependencies.

**The only rule:** Nothing here can import from `@/` paths. Only npm packages and Node built-ins.

Use `console.error` for errors, not the TENEX logger (which is in `utils/` and would be a layer violation).

## Contents

- `fs/` — Filesystem operations
- `error-formatter.ts` — Error formatting for display
- `string.ts` — String manipulation
- `time.ts` — Time/date utilities
- `json-parser.ts` — Safe JSON parsing
- `agent-home.ts` — Agent home directory resolution
