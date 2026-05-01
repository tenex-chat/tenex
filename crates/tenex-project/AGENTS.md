# tenex-project

Library crate. Typed file-backed view of a TENEX project's static state: project
metadata and project membership come from the persisted project event, while
agent definitions are read from global JSON files under `<base_dir>/agents`.
Opened directly by every Rust binary that needs project context. No daemon, no
socket, no database.

Sits beside `tenex-conversations` (conversation state) as the read-side view of
project-local state. Conversation rows are stored in SQLite; agents are not.

## Storage layout

```
~/.tenex/projects/<dTag>/event.json
~/.tenex/agents/<pubkey>.json
```

`Project::open(project_id, base_dir)` or `Project::open_default(project_id)` resolves the path. `project_id` may be a NIP-33 coordinate (`31933:<pubkey>:<dTag>`) or a bare dTag — normalization happens at the boundary in `id::normalize_project_id`.

## Critical invariants

- **Project-id flexibility.** Every API entry point that accepts a project ID must go through `normalize_project_id`. Do not assume a bare dTag.
- **`Signer` trait is the signing boundary.** The read-side agent projection exposes `signer_ref` as `nsec:<bech32>` from the global JSON record, and the signer module also accepts `bunker://...` NIP-46 references. Do not add other speculative traits.
- **Project membership comes from relay-event ingestion.** `Project` derives members from `p` tags in `projects/<dTag>/event.json`; it must not invent membership from local agent files.
- **Agent definitions are global JSON by pubkey.** `Project` reads `<base_dir>/agents/<pubkey>.json` for each member. Cross-project joins are not needed and must not be added.
- **Unavailable member display names are best-effort.** Missing member-agent JSON is skipped, but logs may ask the host-wide `tenex-identity` socket for a kind:0 display name through the private `src/identity.rs` adapter. Keep this lookup read-only and optional.
- **Read-side only.** `tenex-project` does not mutate agent JSON, project events, or indexes. Global agent writes belong in the installed-agent registry layer, not here.
- **No lessons.** Lessons are not stored here and must never be added.

## Public API

`Project` — the typed handle:
- `metadata()` → `ProjectMetadata`
- `agents()` → `Vec<Agent>`
- `agent_by_pubkey(pubkey)` → `Option<Agent>`
- `agent_by_slug(slug)` → `Option<Agent>`
- `project_agents()` → `Vec<ProjectAgent>` (membership + flags)

Team helpers:
- `load_teams(base_dir, project_id)` reads global and project-specific `teams.json`; `project_id` may be a NIP-33 coordinate or bare dTag.
- `teams_for_agent(teams, slug)` filters team membership for one agent.
- `render_teams_context(member_teams, active_team)` renders the prompt fragment.

Key types: `Agent`, `ProjectAgent`, `ProjectMetadata`, `Signer`, `NsecSigner`, `BunkerSigner`, `SignerScheme`.

## How to approach changes

1. `cargo test -p tenex-project` before and after edits.
2. New agent fields: update `RawStoredAgent`, `Agent`, and `read_agent_file`.
3. New project event fields: update `RawProjectEvent` and the projector helpers.
4. Do not add a daemon, socket, database, or abstract storage backend.

## Intentionally absent

- No daemon or owned socket. The only socket access is the read-only
  `tenex-identity` client lookup for unavailable member display names.
- No database, migrations, or ORM.
- No cross-host replication.
- No skill catalog table (skills are filesystem-discovered at runtime).
- No MCP server registry. Project-scoped MCP server config is read by `tenex-mcp` from the project working directory's `.mcp.json`, not by `tenex-project`.
- No lessons.
