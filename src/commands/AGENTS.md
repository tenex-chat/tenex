# commands/ — CLI Entry Points (Layer 4)

User-facing CLI commands. Thin wrappers that parse input, delegate to services, and format output. No business logic.

## Contents

- `daemon.ts` — Daemon lifecycle plus read-only status probes. Do not hide mutating repair or maintenance actions under daemon status.
- `doctor.ts` — System health diagnostics and explicit repair flows. `doctor publish-outbox` is the operator surface for Rust publish-outbox inspection and repair; keep read-only inspect/status separate from mutating repair/drain actions and delegate to the Rust adapter instead of reimplementing outbox logic here.
- `agent/` — Agent management subcommands
- `setup/` — Onboarding flows (interactive setup, LLM config, embedding config)

Commands are wired via Commander in `src/index.ts`.
