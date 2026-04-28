# `crates/` — Modularization Philosophy

This directory holds the Rust crates that decompose the TENEX bun monolith
into a Unix-style fleet. The shape and the rules are deliberate. Read this
before adding, splitting, or merging crates.

## Unix philosophy, applied here

- **Each crate does one thing.** A storage layer, a projection, a one-shot
  binary, a subsystem of the umbrella daemon. Not a kitchen sink.
- **Composition through narrow contracts**, not through inheritance or
  shared globals. Two contracts dominate this tree:
  1. **SQLite schema-as-contract**: storage crates expose a typed read/write
     API over a versioned schema. Multiple processes (bun TS, Rust binaries)
     open the same file. No service in front, no IPC layer.
  2. **NDJSON over Unix sockets** (and over stdio for one-shots): the
     canonical local IPC. Same frame format whether the peer is a subprocess
     or a long-lived daemon. `tenex-agent` already uses this for stdio.
- **Text streams between processes**, typed APIs within a process.
- **Crash and restart are normal**. State lives on disk; in-memory caches
  are caches, not the truth. Any process should survive being killed and
  restarted from SQLite or filesystem state.

## Three roles, kept separate

When designing anything that touches relays + LLM + tools, do not collapse:

- **Subscribe** — owns the relay connection (today: per-project; eventually:
  the host-wide relay-multiplexer).
- **Orchestrate** — owns dispatch, RAL state, delegation tree
  (`tenex-runtime`, forward plan; today: bun runtime).
- **Execute** — owns the LLM loop and tools (`tenex-agent`).

The runner does **not** open relays. The orchestrator does **not** call
LLMs. The subscriber does **not** track delegations. Mixing these is the
single biggest design failure mode here.

## Library vs daemon — the decision rule

Process boundaries cost something. Take one only when you get at least
one of: concurrency isolation, security isolation, language choice,
independent restart, hot-swap. Otherwise it is a library, not a daemon.

| Want | Make it a … |
|---|---|
| Typed read/write of per-project state shared across processes | Library + SQLite (`tenex-conversations`, `tenex-project`) |
| LLM-bound or stateful work that should survive bun-runtime crashes | Daemon (`tenex-summarizer`, future `tenex-cron`, `tenex-intervention`) |
| Pure compute reachable over a frame protocol | One-shot or long-lived binary (`tenex-agent`) |

If a daemon is justified, its public surface is a Unix socket speaking
NDJSON. If a library is right, its public surface is a typed Rust API
over SQLite. Pick one; never both.

## Cross-cutting contracts

These hold across every crate. Violations are bugs.

- **Project IDs accept either form.** Public APIs that take a project
  identifier accept the full NIP-33 coordinate (`31933:<pubkey>:<dTag>`)
  or the bare dTag. Normalize once at the boundary.
- **Schema is the contract.** Migrations are forward-only and versioned.
  A DB whose schema version exceeds `CURRENT_SCHEMA_VERSION` is rejected
  at open time.
- **Lessons are not in any DB here.** Out of scope for `tenex-project`
  and `tenex-conversations`. They get their own home or no home.
- **Signing is behind the `Signer` trait.** Today: `nsec:` scheme.
  Tomorrow: `bunker:` (NIP-46). One swap when it lands.
- **No bun TS imports.** Crates here are Rust-only. The bun runtime
  consumes the same SQLite schemas via TS bindings; that's the only
  cross-language surface.
- **Bun-side data on disk is the legacy source until cutover.** Migration
  helpers (`migrate_from_legacy`) read it and write to SQLite. They do
  not delete the originals; that is an operator concern.

## When to add a new crate

Three questions, in order:

1. *Does an existing crate already own this concern?* If yes, extend it.
2. *Is this a new role in the fleet, or a new instance of an existing
   role?* New role → new crate. New instance → put it in the existing
   home for that role.
3. *Library or daemon?* Apply the decision rule above. If undecided, it
   is a library.

If all three answers point to "yes, new crate," update both
`docs/plans/2026-04-28-architecture-map.md` and the workspace
`Cargo.toml` in the same change.

## Discipline — non-negotiable

- **Simplicity over complexity, every time.** The simplest design that
  meets the requirement wins. Abstractions earn their place by serving
  two or more concrete consumers — never one, never speculative.
- **Repetition is a hard boundary.** Three similar lines is fine; the
  third copy of a real pattern is a refactor, not optional. Notice it
  the moment it appears, not the tenth time.
- **Zero accumulation of technical debt.** No "temporary" code. No
  "for now." No `_unused` prefixes. No commented-out blocks. No
  backwards-compatibility shims past a single bounded cutover. If the
  right fix is hard, do the hard thing; if it is unclear, investigate
  until clear. Speed is not a value here. Coherence is.
- **Boy Scout Rule.** Leave every file better than you found it. Touch
  a file → fix the obvious nearby thing: a stale comment, a misplaced
  import, an off-pattern name. Don't widen scope to a refactor PR, but
  do not walk past rot. Small, continuous improvement is how this tree
  stays small.

## Where to look next

- Per-crate orientation: `crates/<crate>/AGENTS.md`.
- The full picture: `docs/plans/2026-04-28-architecture-map.md`.
- The forward plan for the orchestrator role:
  `docs/plans/2026-04-28-tenex-runtime-orchestrator.md`.
- Project-wide rules: the top-level `CLAUDE.md`.
