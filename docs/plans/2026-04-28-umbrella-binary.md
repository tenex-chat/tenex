# `tenex` umbrella binary — Restructure Spec

## Purpose

Collapse the growing fleet of small Rust binaries (`tenex` daemon, `whitelist`, `tenex-agent`, plus the upcoming `tenex-summarizer`, `tenex-scheduler`, `tenex-intervention`) into one multi-call binary, `tenex`, with subcommands. Each subsystem stays a separate library crate; the umbrella binary thin-wraps them as subcommands. Like `git`, `cargo`, or `bun`.

## Why

- **Single install surface.** One binary on `$PATH`. Users run `tenex cron list` instead of remembering `tenex-scheduler list`.
- **Shared infrastructure.** Tracing init, config loading, signal handling, lockfile helpers — written once, used by every subcommand.
- **Discoverability.** `tenex --help` lists every subsystem. `tenex <thing> --help` is the right place to find a subsystem's options.
- **Cohesive UX.** Subcommand naming, flag conventions, exit codes are consistent because they live in one tree.
- **Lower friction for new subsystems.** Add a subcommand, link a crate, done — no new binary, no new packaging concern.

## Workspace layout

```
crates/
  tenex-agent/          (library + thin agent loop)
  tenex-summarizer/     (library)
  tenex-scheduler/      (library)
  tenex-intervention/   (library)
  tenex-supervisor/     (library; was: daemon/)
  tenex-whitelist/      (library; was: whitelist/)
  tenex-conversations/  (library)
  tenex-project/        (library)
  tenex-context/        (library)
cli/                    (the `tenex` binary; depends on every crate above)
```

The existing `daemon/` and `whitelist/` crates at the workspace root move under `crates/` and are renamed to `tenex-supervisor` and `tenex-whitelist`. Their current binary entry points become `pub fn run(args) -> Result<()>` library entry points; `cli/` calls them.

## Subcommand surface

```
tenex supervise           # was: tenex daemon (project supervisor)
tenex agent               # one-shot agent runner (today's tenex-agent binary)
tenex cron                # scheduler subcommands
  tenex cron list
  tenex cron add ...
  tenex cron add-once ...
  tenex cron rm <id>
  tenex cron run
tenex intervention        # intervention watcher
  tenex intervention run
  tenex intervention status
tenex summarize           # kind:513 summarizer
  tenex summarize run
  tenex summarize status
tenex whitelist           # whitelist daemon + checks
  tenex whitelist check <pubkey> <project-dtag>
  tenex whitelist status
tenex doctor              # diagnostics; bun-side today, eventually multi-language
```

`supervise` replaces `daemon` to free that name (daemon is too generic now that we have several). `tenex daemon` aliases to `supervise` for one release cycle, then is removed.

## Library / binary discipline

Each subsystem crate exposes:

- A small `pub` API for in-process use (e.g., `tenex_summarizer::run(opts)`).
- Its CLI argument types as `pub` (clap `Args` derive, re-exported).
- No `main`, no top-level binary. The binary is only in `cli/`.

This means every subsystem is testable in isolation (no subprocess), and the umbrella binary is a thin shell:

```rust
// cli/src/main.rs
match cli.command {
    Command::Supervise(args) => tenex_supervisor::run(args).await,
    Command::Agent(args)     => tenex_agent::run(args).await,
    Command::Cron(args)      => tenex_scheduler::run(args).await,
    Command::Intervention(a) => tenex_intervention::run(a).await,
    Command::Summarize(args) => tenex_summarizer::run(args).await,
    Command::Whitelist(args) => tenex_whitelist::run(args).await,
}
```

## Shared infrastructure

A small `tenex-runtime` crate holds what every subcommand needs:

- Tracing / `EnvFilter` setup (today duplicated in `daemon/` and `whitelist/`).
- Lockfile helpers (`flock`-based single-instance pattern).
- Config loading from `~/.tenex/config.json`.
- Standard signal handlers (SIGINT/SIGTERM → graceful shutdown).
- Path helpers for `~/.tenex/projects/<dTag>/...`.

This crate is layer-0 by analogy to TypeScript `lib/` — pure utilities, no subsystem imports.

## Process model

Subcommands fall into three groups:

- **Long-lived daemons**: `supervise`, `cron run`, `intervention run`, `summarize run`, `whitelist` (the daemon side, not `check`). Each takes a flock; running `tenex cron run` while another is up exits cleanly.
- **One-shots**: `agent`, `cron list / add / rm`, `whitelist check`, `summarize status`, etc. No flock. Read-write directly to disk. Exit on completion.
- **Hybrids**: `whitelist check` auto-spawns the whitelist daemon if absent (the existing pattern). Keep that behavior under the umbrella subcommand.

Each long-lived daemon uses the shared signal handler and lockfile, and lifecycles independently. The umbrella binary does *not* run multiple daemons in one process. To have all daemons running, launch them all (typically via systemd / launchd / a process supervisor — that's outside this spec).

## Naming and aliases

- The binary is named `tenex`. Symlinks for tab-completion convenience are not provided; subcommand discovery via `tenex --help` is enough.
- The `daemon` subcommand is preserved as an alias for `supervise` for one release cycle, with a deprecation warning. Then removed. (This is the *only* backwards-compat shim in the restructure; it's transient and bounded.)

## Subsumes the existing binaries

The following binaries are removed in the cutover:
- `tenex` (current, with `daemon` subcommand) — becomes `tenex supervise`.
- `whitelist` (separate crate) — becomes `tenex whitelist`.
- `tenex-agent` — becomes `tenex agent`.

Plus the not-yet-shipped binaries planned in their respective specs:
- `tenex-summarizer` — becomes `tenex summarize` (the standalone binary is never shipped; it lands directly under the umbrella).
- `tenex-scheduler` — becomes `tenex cron`.
- `tenex-intervention` — becomes `tenex intervention`.

## Migration sequence

1. **Restructure first.** Move `daemon/` → `crates/tenex-supervisor/`, `whitelist/` → `crates/tenex-whitelist/`. Convert each `main` into a `pub fn run`. Add `cli/` with subcommands `supervise`, `whitelist`, `agent`. Verify `tenex supervise` and `tenex whitelist check` work end-to-end.
2. **Land new subsystems under the umbrella.** Each new spec'd binary (`summarize`, `cron`, `intervention`) ships only as a `tenex` subcommand. They never have a standalone binary phase.
3. **Drop the `daemon` alias.** After one release cycle of the alias, remove it.

The `tenex-summarizer` agent that's currently running in the background is producing a standalone crate. That's fine: when it finishes, the crate goes under `crates/tenex-summarizer/` and `cli/` adds the `summarize` subcommand. The standalone binary the agent produces is deleted; only the library remains.

## Non-goals

- No multi-daemon orchestration in one process. Each daemon is its own process.
- No subcommand plugin system (no dynamic loading, no third-party subcommands). Subcommands are statically linked.
- No runtime feature flags to disable subcommands at compile time. All in or all out — the binary is small, the subsystems are small.
- No web UI, no admin shell, no REPL. CLI subcommands are the interface.
- No backwards compatibility with old binary names beyond the one-cycle `daemon` alias.

## Success criteria

- `which tenex` is the only Rust binary on a TENEX host. No `whitelist`, no `tenex-agent`, no separate per-subsystem binaries.
- Adding a new subsystem is: add a crate, add a subcommand variant, link it in `cli/`. No new binary, no new packaging concern.
- `tenex --help` lists every subsystem with one-line descriptions; `tenex <subsystem> --help` shows that subsystem's options.
- Shared infrastructure (tracing, lockfile, config) lives in `tenex-runtime` and is used identically by every subcommand. No copy-pasted setup code across subsystems.
- The `daemon` alias deprecation warning fires and then disappears one release later, with no other backwards-compat code in the tree.
