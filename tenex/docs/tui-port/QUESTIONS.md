# TUI port — open questions / spec-vs-source divergences

Pin notable divergences between `tenex/docs/tui-port/{01..12}-*.md` (snapshot
spec) and the live TS source. The port follows TS source — these notes flag
where the spec has fallen behind so future iterations don't re-port removed
surfaces.

## Confirmed stale spec sections

### Spec 10 §2 — `tenex agent add` is gone

Removed in commit `2855d63d` ("remove Nostr-event-based agent installation
(kinds 4199/14199/24012)"). The TS source at
`src/commands/agent/index.ts:38-58` no longer registers an `add` subcommand.
Agent creation happens through the interactive manager or
`agent import openclaw`.

The Rust port matches: `agent_cmd::AgentCommand` has only `Delete`,
`Manage`, `Import`.

### Spec 10 §6 / §8 — kind:4199 references

The "Agent definition format" and "Network publishing" sections that
reference kind:4199 fetches and the `installAgentFromNostr*` family no
longer apply. `installAgentFromDefinitionEvent` /
`installAgentFromDefinitionEventId` have been deleted. AgentStorage's
on-disk schema (§6.1) is still authoritative for persisted agents — those
fields persist for agents that were already installed before the cutover
and for agents created locally.

### Spec 11 §1 — `tenex doctor agents refetch` is gone

Same fallout as the kind:4199 cutover (commit `2855d63d`). With no
Nostr-event-driven agent definitions, there's nothing to refetch. The
live TS source at `src/commands/doctor.ts:43-46` registers only `orphans`
and `categorize` under `tenex doctor agents`. The Rust port now matches.

### Spec 02 / spec docs broadly — NIP-46 is gone

Removed in TS commits `28791660` (nostr_publish_as_user tool),
`af37bf33` (modify_project tool), and `a42db124` (NIP-46 service +
`tenex config nip46` submenu + Daemon init/shutdown). kind:31933
project mutations are now signed directly with the project owner's
nsec via `src/commands/agent/ownerSigner.ts` (env `TENEX_NSEC` →
config `ownerNsec` → password prompt). Spec 02 §3.3 listed a "NIP-46 —
Remote signing" entry in the **Advanced** section; that entry is gone
and the menu is now 15 items, not 16.

The Rust port matches: `tenex/src/config_cmd/nip46.rs` deleted, dispatch
+ menu entry stripped from `config_cmd/mod.rs`, all `nip46_*` accessors
removed from `store/tenex_config.rs`, shared validators relocated to
`tui/prompts/validators.rs`.

### Spec 11 — kind:24030 (TenexAgentDelete) is gone

Removed per user directive in commit `0f8a7668`. The `event-handler`
dispatcher and the daemon ops subscription filter no longer reference
this kind. Spec 11 doesn't list it directly but
`agentDeletion.ts` was implicitly assumed available — it isn't.

## Open: still-stale-or-not?

(none currently)

## Substrate-blocked surfaces (acknowledged, not stubs)

### `tenex doctor migrate` — only reports, doesn't migrate

TS has three migrations registered (`src/services/migrations/migrations/`):

- `unknown→1`: relocate legacy schedules into per-project schedules.json
- `1→2`: reindex PrefixKVStore from 18-char to 10-char prefixes
- `2→3`: bundle built-in skills to `TENEX_BASE_DIR/skills/`

Each migration touches a substrate the Rust port doesn't yet implement
(per-project schedule files, the PrefixKVStore RAG index, the built-in
skills bundle). Implementing them in Rust without those substrates would
either be a stub (forbidden) or a partial port that skips data.

The Rust port's `doctor migrate` reads `config.version`, prints the TS
"Current migration version: X (latest: 3)" line verbatim, and:
- emits "No pending migrations." + "Final migration version: 3" if at v3,
- otherwise surfaces an honest hint and exits 1, telling the user to run
  the TS binary's `tenex doctor migrate` to advance the on-disk state.

This is intentional under CLAUDE.md "no half-finished implementations" —
when the schedules / PrefixKVStore / skills-bundle ports land, this
becomes a real migrate driver.

## Cleared notes

### Root `Cargo.toml` workspace block (resolved)

Earlier fires hit a transient state where root `Cargo.toml` listed
`crates/tenex-context` / `crates/tenex-system-prompt` without the
directories existing yet. The user's parallel work has since landed
both crate scaffolds; `cargo build` / `cargo test` succeed cleanly.
