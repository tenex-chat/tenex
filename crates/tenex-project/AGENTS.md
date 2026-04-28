# tenex-project

Library crate. Typed SQLite-backed view of a TENEX project's static state: agent definitions, project metadata, membership, transport allowlists, MCP configuration. One file per project, opened directly by every Rust binary that needs project context. No daemon, no socket.

Sits beside `tenex-conversations` (conversation state) as the second pillar of per-project local state. Different file because change rates diverge: conversation rows are written every turn; project rows change only when humans or agent-management commands edit project configuration.

Canonical spec: `docs/plans/2026-04-28-tenex-project-library.md`

## Storage layout

```
~/.tenex/projects/<dTag>/project.db
```

`Project::open(project_id, base_dir)` or `Project::open_default(project_id)` resolves the path. `project_id` may be a NIP-33 coordinate (`31933:<pubkey>:<dTag>`) or a bare dTag — normalization happens at the boundary in `id::normalize_project_id`.

## Critical invariants

- **Schema is the contract.** `migrations::initialize()` runs at open time. Mismatch with the TS binding is a startup error.
- **Forward-only migrations.** Never alter or remove existing migrations.
- **Project-id flexibility.** Every API entry point that accepts a project ID must go through `normalize_project_id`. Do not assume a bare dTag.
- **`Signer` trait is the only speculative abstraction.** The `agents.signer_ref` column holds `nsec:<bech32>` today. The `Signer` trait (`src/signer.rs`) exists so that the future `bunker:<uri>` scheme is a new impl with no callsite changes. Do not add other speculative traits.
- **Materialized rows come from relay-event ingestion only.** Local-only augmentation columns (`working_directory`, `signer_ref`, etc.) may be written directly. Rows that mirror relay events must originate from a relay-event ingestion path.
- **Agents table is global-by-pubkey, per-project-file.** The same agent definition is materialized in every project DB it belongs to. Cross-DB joins are not needed and must not be added.
- **No lessons.** Lessons are not stored here and must never be added.

## Public API

`Project` — the typed handle:
- `metadata()` → `ProjectMetadata`
- `agents()` → `Vec<Agent>`
- `agent_by_pubkey(pubkey)` → `Option<Agent>`
- `agent_by_slug(slug)` → `Option<Agent>`
- `project_agents()` → `Vec<ProjectAgent>` (membership + flags)
- `upsert_metadata(...)`, `upsert_agent(...)`, `upsert_project_agent(...)` — write path
- `integrity_check()` → `String`

Key types: `Agent`, `ProjectAgent`, `ProjectMetadata`, `Signer`, `NsecSigner`, `SignerScheme`.

## How to approach changes

1. `cargo test -p tenex-project` before and after edits.
2. Schema changes go in `src/migrations.rs` as a new versioned entry.
3. New agent fields: add migration column + update `Agent` struct + update upsert SQL.
4. The TypeScript binding targets the same migration version. Confirm compatibility before landing schema changes.
5. Do not add a daemon, socket, or abstract storage backend.

## Intentionally absent

- No daemon or socket.
- No ORM.
- No backwards-compatible JSON file layout after migration (one-shot via `tenex doctor migrate`).
- No cross-host replication.
- No skill catalog table (skills are filesystem-discovered at runtime).
- No separate MCP server registry table (lives in `mcp_servers_json` on the agent row).
- No lessons.
