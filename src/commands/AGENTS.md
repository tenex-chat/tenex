# commands/ — CLI Entry Points (Layer 4)

User-facing CLI commands. Thin wrappers that parse input, delegate to services, and format output. No business logic.

## Contents

- `daemon.ts` — Daemon start/stop
- `doctor.ts` — System health diagnostics
- `doctor-transport-chat.ts` — reusable branch-local transport chat harness with persistent session artifacts
- `doctor-transport-smoke.ts` — local transport-neutral runtime smoke test with `nostr` and `local` inbound transport modes
- `agent/` — Agent management subcommands
- `setup/` — Onboarding flows (interactive setup, LLM config, embedding config)

Commands are wired via Commander in `src/index.ts`.
