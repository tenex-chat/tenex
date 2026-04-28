# `tenex-project` — Product Spec

## Purpose

A Rust library that turns a project ID into a typed, read-only view of everything a Rust binary needs to know about that project: its agents, its metadata, its skills, its identity allowlists, its MCP configuration. One SQLite file per project, schema-as-contract, opened directly by every consumer.

Sits beside `tenex-conversations` as the second pillar of local state. Different file, different lifecycle, same engine and access model.

## Companion to `tenex-conversations`

| Crate | Concern | Change rate |
|-------|---------|-------------|
| `tenex-conversations` | What happened in conversations. | Constant. |
| `tenex-project` | Static project state: agents, metadata, skills. | Rare. |

Both are SQLite-per-project; both are libraries; both are read by every Rust binary that needs them. Different files because the change rates diverge: conversation rows are written every turn; project rows are written when humans (or agents acting on agent-management commands) edit project state. Putting both in one DB couples their write contention unnecessarily.

## Source-of-truth model

The canonical source is **on relays**:

- Project NIP-33 event (kind:31933) → owner, dTag, repo URL, member pubkeys, metadata.
- Agent definition events (kind:0 + kind:4199) → name, description, instructions, category.
- Skill events (kind:4202) → skill bundle content.

The local store is a **materialized view + local-only augmentation**:
- Materialized rows mirror relay events 1:1, keyed on `nostr_event_id`.
- Augmentation columns hold what cannot be public: agent nsecs (or NIP-46 bunker URIs), working directory paths, telegram chat bindings, intervention-agent overrides, cached prompt-compilation outputs.

If state needs to be shared across hosts, publish more to relays. The local store never becomes a divergent source of truth.

## What it owns

- Project metadata: dTag, owner pubkey, repo URL, working directory, latest NIP-33 event ID, ingested-at timestamp.
- Agent definitions (global, by pubkey): slug, name, instructions, category, description, nsec / signer reference, latest profile event ID, plus mirrors of agent-level JSON: pre-enabled skills, model preferences, Telegram bindings and per-channel allowlists, per-agent MCP server definitions.
- Project membership: which agents are in this project, with project-scoped flags (PM flag, intervention enablement, escalation target).

## What it does *not* own

- Conversation state — that's `tenex-conversations`.
- Relay subscriptions or signing — those are transport concerns.
- Configuration that's truly global (whitelisted pubkeys, LLM provider config, relay list) — that lives in `~/.tenex/config.json` and is read directly by each binary that needs it.
- Cross-host replication.

## Storage

- One SQLite file per project at `~/.tenex/projects/<dTag>/project.db`.
- WAL mode + busy-timeout — same as `tenex-conversations`.
- Schema is the contract. Versioned migrations. Both bindings target the same migration version; mismatch is a startup error.

## Data model (high-level)

- `project` — single-row metadata.
- `agents` — global agent definitions, keyed by pubkey. Global means an agent appears in every project DB it's a member of, materialized identically. Carries scalar columns plus three JSON columns mirroring the agent's on-disk JSON: `default_config_json` (pre-enabled skills, model, mcp access list), `telegram_config_json` (bot, allowlists, chat bindings), `mcp_servers_json` (per-agent MCP server definitions).
- `project_agents` — membership with project-scoped flags only: PM flag, intervention enablement, escalation target. No skill or MCP overrides — those live on the agent row.

Things that intentionally do *not* have a table:

- **Skill catalog.** Skill definitions are filesystem-discovered (`~/.tenex/skills/`, `~/.tenex/projects/<dTag>/skills/`, agent home, `~/.agents/skills/`) plus relay-hydrated kind:4202 events. The bun runtime resolves them at runtime; the Rust agent runner will too. Same as TS today.
- **Transport allowlist as a separate table.** Per-agent Telegram allowlists live inside `telegram_config_json`. Global trust is in `~/.tenex/config.json`.
- **MCP server registry.** Per-agent MCP servers live inside `mcp_servers_json` on the agent row.

Foreign keys are on. The `agents` table is the only one not tied to a single project — keeping it inside the per-project DB is intentional: the same global agent definition appears in every project DB it's a member of, materialized from relay events. Cross-DB joins are not needed.

## Consumers

| Consumer | Access |
|----------|--------|
| Bun project runtime | Read-write (writes during the interim writer phase) |
| Rust agent runner (long-lived session mode) | Read-only, refreshed each turn |
| Rust scheduler | Read-only (slug → pubkey resolution) |
| Rust intervention watcher | Read-only (intervention-agent slug resolution + project agent registry) |
| Rust summarizer | Read-only (project metadata for `a` tag) |
| Future Rust orchestrator | Read-write |
| Future project-state synchronizer | Read-write (sole writer once it exists) |

All consumers open the same file. No service in front.

## API surface

Small typed Rust API. One module per concern:

**Project**
- Open by dTag, by NIP-33 coordinate, or by working directory.
- Read project metadata.

**Agents**
- Lookup by pubkey, by slug-within-project, or list all agents in project.
- Resolve slug → pubkey (used by scheduler, intervention).
- Read agent's effective instructions including project-scoped overrides.
- Get the agent's signer reference (the abstract handle, not the nsec — see "Signing seam" below).

**Allowlists** (agent-scoped, from the agent row's JSON)

**Maintenance**
- Run pending schema migrations.
- Vacuum, integrity-check.

The bindings are typed query wrappers. No ORM. Same discipline as `tenex-conversations`.

## Signing seam

Agent signing is the one abstraction worth building speculatively, because the alternative is rewriting every signing callsite when NIP-46 lands.

The `agents` table stores a **signer reference**, not a raw nsec. Today the reference is `nsec:<bech32>`. Tomorrow it can be `bunker:<connection-uri>`. The `tenex-project` API exposes a `Signer` trait, with one implementation per scheme. Consumers ask the crate for an agent's signer; they don't see what's behind it.

This is the *only* speculative abstraction in the spec. Every other "future swap" point (relay-mux, project-state synchronizer) is a localized change and doesn't need pre-built indirection.

## Concurrency

Inherits from SQLite WAL: unlimited concurrent readers, one writer. The writer-singleton property is enforced by *who* writes:

- Today: the bun runtime is the only writer. It already subscribes to project + agent + skill events on relays and materializes them; today it writes JSON files, tomorrow it writes to this DB instead.
- Long-term: a Rust project-state synchronizer becomes the only writer. The bun runtime stops writing.

Multi-process *reads* are unconstrained. Multi-process *writes* are avoided architecturally.

## Migration story

One-shot migration on first cutover, run via `doctor migrate`:

- Read existing `~/.tenex/agents/<slug>/agent.json` files → `agents` rows.
- Read project NIP-33 event metadata + per-project membership files → `project` and `project_agents` rows.
- Read existing skill files → `skills` rows.
- Old files archived (not deleted) on first run; deleted in the cutover PR after a successful round-trip.

Forward-only migrations after that.

## Language bindings

- **Rust crate** (`tenex-project`): used by every Rust binary that needs project context.
- **TypeScript binding**: used by the bun runtime. Same API shape, same migration version, same schema.
- Schema and migration SQL live in one place (the Rust crate); the TS binding either reads them at build time or vendors a generated copy. One source of truth.

## Non-goals

- No daemon, no socket, no service in front.
- No cross-host replication.
- No backwards-compatibility with the old JSON file layout after migration.
- No abstract storage interface with multiple backends. SQLite is the backend.
- No ORM.
- No write API for things that should come from relay events. Local-only augmentation columns can be written directly; materialized rows must come from a relay-event ingestion path.

## Success criteria

- Every Rust binary reads project state through this crate. No Rust binary parses agent JSON files, project event content, or skill markdown directly.
- Adding an agent to a project causes a single row insert in `project_agents`; the agent runner sees the new agent on its next turn without restarting.
- The bun runtime's project-state writes target this DB; the JSON file paths it writes today are deleted in the cutover PR.
- The signer abstraction is in place from day one; the eventual NIP-46 swap is a single new `Signer` impl with no callsite changes.
- A new Rust binary that needs project context links one crate, opens one file, gets a typed view. No bootstrap, no IPC, no auth.
