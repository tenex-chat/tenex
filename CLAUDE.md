# TENEX Development Standards

You are working on TENEX, a multi-agent AI coordination system built on Nostr.

## ABSOLUTE RULES - NO EXCEPTIONS

### NO TEMPORARY SOLUTIONS
The following are **NEVER acceptable**:
- "temporary", "for now", "placeholder", "TODO", "FIXME", "HACK"
- "legacy", "backwards compatible", "deprecated but kept"
- "we can refactor later", "quick fix", "workaround"
- Comments explaining why bad code exists instead of fixing it
- Wrapper classes like `Enhanced*`, `New*`, `*V2`
- Re-exporting old interfaces for compatibility
- `_unusedVar` patterns - delete unused code entirely

**If code isn't right, fix it properly or don't write it.**

### THE RIGHT FIX, NOT THE FAST FIX
The goal is **always** the right long-term, sustainable, idiomatic, coherent fix. Never the simplest or fastest one.
- Speed and convenience are not values. Correctness, coherence, and long-term sustainability are.
- Never hack things in the name of expediency.
- Never frame a fix as "for now" — every change should be one you'd be comfortable maintaining for years.
- If the right fix is hard, do the hard thing. If it's unclear, investigate until it's clear.
- Technical debt is never an acceptable tradeoff for shipping faster.

### NO OVER-ENGINEERING
- Don't add features beyond what's requested
- Don't create abstractions for single-use code
- Don't add "just in case" error handling
- Don't wrap libraries unnecessarily
- Three similar lines > premature abstraction

### NOSTR USAGE
- Use the `nostr-sdk` crate for Nostr primitives (events, keys, filters).
- TENEX event kind/tag construction and decoding lives in `tenex-protocol` (intent vocabulary + Nostr channel encoding). Build and parse TENEX events there — never ad-hoc at call sites.
- Signing is always behind the `Signer` trait (`tenex-project`); never reach for raw keys.
- The agent runner (`tenex-agent`) does not open relay connections — subscription and orchestration live outside it.

---

## Architecture

TENEX is a Rust workspace. The host CLI/supervisor is `tenex/`; every other
concern is a crate under `crates/`. See `MODULE_INVENTORY.md` for the full map
and `crates/AGENTS.md` for the authoritative rules.

### One crate, one thing
Each crate owns a single concern — a storage layer, a projection, a daemon, or
a one-shot binary. New behavior extends the crate that already owns the concern;
it does not accrete into an unrelated one.

### Three roles, kept separate
- **Subscribe** — owns the relay connection.
- **Orchestrate** — owns dispatch, RAL state, the delegation tree.
- **Execute** — the LLM loop and tools (`tenex-agent`).

The runner never opens relays; the orchestrator never calls LLMs; the subscriber
never tracks delegations. Mixing these is the biggest design failure mode here.

### Library vs daemon
Take a process boundary only when you get concurrency/security isolation,
language choice, independent restart, or hot-swap. Otherwise it is a library. A
daemon's public surface is a Unix socket speaking NDJSON; a library's is a typed
Rust API over its substrate (a versioned SQLite schema or a JSON file layout).
Pick one; never both.

### Storage is the contract
SQLite migrations are forward-only and belong only to the crate that owns the
database; JSON file-layout changes belong only to the crate that owns that
directory. State lives on disk — every process must survive restart from it.

**Rule:** Project IDs accept either the NIP-33 coordinate (`31933:<pubkey>:<dTag>`) or the bare dTag — normalize once at the owning crate's boundary.

---

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Crates | `tenex-<area>`, kebab-case | `tenex-conversations` |
| Modules / files | snake_case `.rs` | `store.rs`, `schema.rs` |
| Types | CamelCase | `ConversationStore` |
| Functions / fields | snake_case | `list_candidates` |
| Tests | `#[cfg(test)]` module or `tests/*.rs` | `tests/discover_and_read.rs` |

Each crate carries an `AGENTS.md` with its local invariants. Read it before
changing that crate.

---

## Dependency Patterns

```rust
// CORRECT: depend on the crate that owns the concern; import what you need
use tenex_conversations::ConversationStore;
use tenex_project::Signer;

// WRONG: reaching across roles — opening a relay from inside the agent runner,
//        or calling an LLM from the orchestrator
// WRONG: re-normalizing a project id at every call site instead of once at the
//        owning crate's boundary
```

Crate dependencies are declared in each crate's `Cargo.toml` and the workspace
`Cargo.toml`. Keep the graph acyclic and minimal. The tree is Rust-only — no
`bun`/TypeScript imports.

---

## Before Writing Code

### MANDATORY - Answer These Questions First:
1. **Which crate owns this concern?** (Extend it; don't add a new crate unless it is a new role in the fleet)
2. **Does similar code already exist?** (Search before creating)
3. **What's the minimal change needed?** (No scope creep)
4. **Am I about to write a TODO?** (Stop. Fix it now or don't do it)

### When Modifying Existing Code:
1. Read the file first - understand before changing
2. Follow existing patterns in that file
3. Don't "improve" unrelated code
4. Don't add comments to code you didn't change
5. Keep `AGENTS.md` up to date — if you add, rename, or restructure modules, commands, or conventions, update the relevant `AGENTS.md`

---

## Anti-Patterns to Reject

### Role / Crate Violations
```rust
// REJECT: the agent runner opening a relay connection  ❌
// REJECT: the orchestrator calling an LLM              ❌

// FIX: keep Subscribe / Orchestrate / Execute separate. Relay access lives
//      outside tenex-agent; LLM calls live inside it.
```

### Sentinel Values That Mask Failure
```rust
// REJECT: silently turning an error into "not found"
let view = resolve(pubkey).unwrap_or(None);  // ❌ (on Result<Option<T>>)
let name = display_name.unwrap_or_else(|| "unknown".into());  // ❌

// FIX: represent absence with Option; propagate or log-and-bail on failure
```

### Backwards Compatibility
```rust
// REJECT: keeping the old name alive
pub use new_module::NewName as OldName;  // ❌

// FIX: just rename it and update all call sites.
```

### Unused Code
```rust
// REJECT: underscore prefix for unused
let _old_value = compute();  // ❌

// FIX: delete it entirely
```

### God Modules
```rust
// REJECT: one type doing everything
impl ConversationManager {
    fn fetch(&self) {}
    fn persist(&self) {}
    fn format(&self) {}
    fn summarize(&self) {}
    // ... 50 more methods
}

// FIX: split by concern across crates/modules
//      (storage vs projection vs summarizer)
```

---

## Tool Implementations

Agent tools live in `crates/tenex-agent/src/tools/` (one file per tool). They should:
- Be single-purpose
- Delegate business logic to the crate that owns it (`tenex-rag`, `tenex-mcp`, `tenex-conversations`, …)
- Never hold state
- Follow naming: `<domain>_<action>.rs`

```rust
// CORRECT: the tool delegates to the owning crate
use tenex_rag::RagStore;
// ...the tool resolves the store, calls it, and shapes the result.
// It holds no schema, no SQL, and no vector-store logic itself.

// WRONG: the tool opens the vector store and implements query logic inline
```

---

## Multi-Agent Environment

This project runs multiple agents concurrently. Follow these rules to avoid interfering with parallel work:

- **Never stash, reset, or otherwise touch uncommitted working-tree changes.** Other agents or the user may have in-progress work; stashing or reverting it causes data loss.
- **Never assume the working tree is clean before starting work.** Baseline your diff by capturing `git diff HEAD` to a temp file, then compare after your own changes to isolate what you did.
- **Commit only your own changes.** Do not commit files you did not touch; the user or another agent may have left them in a deliberate intermediate state.

---

## References

- **Full architecture guide:** `docs/ARCHITECTURE.md`
- **Crate philosophy and rules:** `crates/AGENTS.md`
- **Module inventory:** `MODULE_INVENTORY.md`

---

## Summary

1. **No temporary solutions** - Do it right or don't do it
2. **Right fix, not fast fix** - Sustainable, idiomatic, coherent — never expedient
3. **No backwards compatibility** - Clean breaks only
4. **No over-engineering** - Minimal changes for the task
5. **Respect crate boundaries** - One crate, one concern; keep the three roles separate
6. **Build Nostr events in `tenex-protocol`** - Use `nostr-sdk` primitives; sign behind the `Signer` trait
7. **Delete unused code** - Don't comment or underscore it
