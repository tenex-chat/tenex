# `tenex-project` — Product Spec

## Purpose

A Rust library that turns a project ID into a typed, read-only view of the static project state a Rust binary needs: project metadata, project membership, and the global agent definitions for project members.

This crate is file-backed. It does not own a SQLite database. Project metadata comes from the persisted project event; agent definitions come from global installed-agent JSON files under `<base_dir>/agents`. Conversation state remains in `tenex-conversations`.

## Companion Crates

| Crate | Concern | Storage |
|-------|---------|---------|
| `tenex-conversations` | Conversation transcripts, tool messages, prompt history, and context state. | SQLite |
| `tenex-agent-registry` | Global installed-agent registry records and indexes. | JSON files |
| `tenex-project` | Read-side project metadata, membership, and member-agent projections. | JSON files |

`tenex-project` composes the project event with read projections from `tenex-agent-registry`; it does not mutate either source.

## Source-of-truth Model

The canonical source is **on relays**:

- Project NIP-33 event (kind:31933) -> owner, dTag, repo URL, member pubkeys, metadata.
- Agent definition events and local installed-agent records -> name, description, instructions, category, signer material, and local configuration.
- Skill files and skill events remain filesystem/relay-discovered at runtime; they are not persisted here.

The local file layout is a materialized read view plus local-only installed-agent augmentation. If state needs to be shared across hosts, publish more to relays; do not turn `tenex-project` into an independent source of truth.

## Storage Layout

```text
<base_dir>/projects/<dTag>/event.json
<base_dir>/agents/index.json
<base_dir>/agents/<pubkey>.json
```

There is no `project.db`, no `agents` table, and no project-local agent rows.

## What It Owns

- Project metadata projected from `projects/<dTag>/event.json`: dTag, owner pubkey, title, repo URL, latest event ID, ingested timestamp.
- Project membership projected from `p` tags on the project event.
- Read-side agent projections for project members by loading `<base_dir>/agents/<pubkey>.json`.
- Signer resolution through the `Signer` trait from the projected `signer_ref`.

## What It Does Not Own

- Agent JSON mutation, installed-agent indexes, key generation, category migration, or Telegram config writes. Those belong to `tenex-agent-registry`.
- Conversation state. That belongs to `tenex-conversations`.
- Relay subscriptions, event publishing, or project event mutation.
- Skill catalog persistence.
- Cross-host replication.

## API Surface

`Project` is the typed handle:

- `Project::open(project_id, base_dir)` and `Project::open_default(project_id)`
- `metadata() -> Option<ProjectMetadata>`
- `agents() -> Vec<Agent>`
- `agent_by_pubkey(pubkey) -> Option<Agent>`
- `agent_by_slug(slug) -> Option<Agent>`
- `project_agents() -> Vec<ProjectAgent>`
- `resolve_slug(slug) -> Option<String>`
- `signer_for_agent(pubkey) -> Result<Box<dyn Signer>, SignerError>`

Project IDs may be full NIP-33 coordinates (`31933:<pubkey>:<dTag>`) or bare dTags. Normalize once at the API boundary.

## Signing Seam

Agent signing is the one abstraction worth keeping. The read-side agent projection exposes a signer reference; today it is `nsec:<bech32>` derived from the global JSON record's `nsec`. Tomorrow it can be `bunker:<connection-uri>`. Consumers ask the project for an agent signer and do not need to know which scheme backs it.

## Concurrency

`tenex-project` is read-side file access. Multi-process reads are allowed. Writes happen elsewhere:

- Project event writes are project-event mutation/publishing concerns.
- Installed-agent writes go through `tenex-agent-registry`.
- Conversation writes go through `tenex-conversations`.

## Success Criteria

- Rust binaries that need project context use `tenex-project` instead of reparsing project events and agent JSON ad hoc.
- `tenex-project` never mutates agent JSON, project events, or indexes.
- Adding an agent to a project is reflected by the project event membership; the project view loads the corresponding global agent JSON by pubkey.
- The signer abstraction remains localized and does not imply a database schema.
