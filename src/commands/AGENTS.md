# commands/ — CLI Entry Points (Layer 4)

User-facing CLI commands. Thin wrappers that parse input, delegate to services, and format output. No business logic.

## Contents

- `daemon.ts` — Daemon lifecycle plus read-only status probes. Do not hide mutating repair or maintenance actions under daemon status.
- `doctor.ts` — System health diagnostics and explicit repair flows. Future Rust publish-outbox operator commands should live here, with read-only inspect/status separate from mutating repair/drain actions.
- `agent/` — Agent management subcommands
- `setup/` — Onboarding flows (interactive setup, LLM config, embedding config)

Commands are wired via Commander in `src/index.ts`.
