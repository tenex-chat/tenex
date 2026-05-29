# Contributing to TENEX

TENEX is a Rust workspace. The host CLI/supervisor lives in `tenex/`; every other
concern is a focused crate under `crates/`.

## Development Workflow

### Setup
```bash
# Build the workspace
cargo build

# Run the test suite
cargo test --workspace

# Lint (treat warnings seriously)
cargo clippy --workspace --all-targets

# Format
cargo fmt --all
```

---

## Before You Code

### 1. Read the architecture docs
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — the crate model, the three roles, and the library-vs-daemon rule.
- **[crates/AGENTS.md](../crates/AGENTS.md)** — the modularization philosophy and non-negotiable rules.
- **[MODULE_INVENTORY.md](../MODULE_INVENTORY.md)** — the canonical map of every crate. Find the owning crate before writing code.
- The `AGENTS.md` inside the specific crate you are changing — it carries that crate's local invariants.

### 2. Check existing patterns
Look for similar code in the owning crate and follow its established patterns.

### 3. Answer the three questions
1. **Does an existing crate already own this concern?** If yes, extend it.
2. **Is this a new role in the fleet, or a new instance of an existing role?**
   New role → new crate. New instance → the existing home for that role.
3. **Library or daemon?** A process boundary is justified only by concurrency or
   security isolation, language choice, independent restart, or hot-swap. If
   undecided, it is a library.

---

## Coding Guidelines

### Where code goes
- Find the crate that owns the concern (`MODULE_INVENTORY.md`) and put the code there.
- Keep the three roles separate: **Subscribe** (relay connection), **Orchestrate**
  (dispatch / RAL / delegation), **Execute** (LLM loop + tools, `tenex-agent`).
  The runner never opens relays; the orchestrator never calls LLMs.
- Storage lives behind the owning crate's typed API. SQLite schema changes belong
  only to the crate that owns the database; JSON layout changes only to the crate
  that owns that directory.

### File size
- Target: under 300 LOC per file.
- Hard limit: 500 LOC.
- When a file approaches 300 LOC, split it by responsibility before adding more.

### Naming
| Thing | Convention | Example |
|---|---|---|
| Crates | `tenex-<area>`, kebab-case | `tenex-conversations` |
| Modules / files | snake_case `.rs` | `store.rs`, `schema.rs` |
| Types | CamelCase | `ConversationStore` |
| Functions / fields | snake_case | `list_candidates` |

### Error handling
- Represent absence with `Option`; propagate or log-and-bail on failure.
- Never paper over absent or unresolvable data with sentinel values (`"unknown"`,
  `String::new()`, `0`). `unwrap_or(None)` on a `Result<Option<T>>` is always
  wrong — it silently turns I/O and parse errors into "not found".

---

## Testing

### Co-locate unit tests
Unit tests live in a `#[cfg(test)]` module next to the code they test. Integration
tests live in the crate's `tests/` directory:

```
crates/tenex-summarizer/
├── src/
│   ├── scheduler.rs
│   └── source.rs
└── tests/
    └── discover_and_read.rs
```

### Run tests
```bash
cargo test --workspace          # everything
cargo test -p tenex-conversations   # one crate
```

### End-to-end probes
For runtime behavior changes, prefer validating with a real end-to-end probe in
addition to focused unit tests. The runtime probe harness lives under `scripts/`
(for example `scripts/tenex-runtime-probe.ts`) and drives the actual TENEX
binaries against the local relay. See the top-level `AGENTS.md` for record/replay
cassette usage.

---

## Commit Guidelines

### Commit messages
Follow conventional commits:
```
feat(conversations): add delegation-marker synthesis
fix(summarizer): retry on publish failure
refactor(context): single source of truth projection
docs: update architecture guide
test(scheduler): cover quiet-window candidate selection
```

### Pre-commit hook
The pre-commit hook runs `cargo check --workspace`. A commit that does not
compile is blocked. Run `cargo clippy --workspace` and `cargo fmt --all` before
committing.

### Multi-agent working tree
This project runs multiple agents concurrently:
- **Never stash, reset, or revert uncommitted changes** — another agent or the
  user may have in-progress work.
- **Never assume the working tree is clean.** Baseline your diff with
  `git diff HEAD` before you start, and compare afterward to isolate your changes.
- **Commit only your own changes.** Do not commit files you did not touch.

---

## The Boy Scout Rule

Leave every file better than you found it. When you touch a file, fix the obvious
nearby thing — a stale comment, a misplaced `use`, an off-pattern name. Don't
widen scope into a refactor PR, but don't walk past rot either.

---

## Breaking Changes

This project is in active development. We prioritize code quality, architectural
integrity, and coherence over backward compatibility.

- **Do not hesitate to refactor** if it improves the codebase.
- **No compatibility shims past a single bounded cutover.** Rename and update all
  call sites; don't re-export old names.
- **Update all relevant documentation** in the same pull request — including the
  affected crate's `AGENTS.md`, `MODULE_INVENTORY.md`, and the architecture map
  when you add, split, or merge a crate.

---

## Pull Request Checklist

Before submitting:
- [ ] Builds: `cargo build --workspace`
- [ ] Tests pass: `cargo test --workspace`
- [ ] Clippy is clean: `cargo clippy --workspace --all-targets`
- [ ] Formatted: `cargo fmt --all`
- [ ] Code lives in the crate that owns the concern
- [ ] The three roles stay separate
- [ ] Documentation updated (crate `AGENTS.md` / `MODULE_INVENTORY.md` if structure changed)

---

## Getting Help

1. Check [ARCHITECTURE.md](./ARCHITECTURE.md) and the owning crate's `AGENTS.md`.
2. Search for similar code in that crate.
3. Ask in PR review.
