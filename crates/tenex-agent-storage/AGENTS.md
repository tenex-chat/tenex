# tenex-agent-storage

Library crate. Owns TENEX's global installed-agent storage under `<base_dir>/agents`.
Agent records are JSON files named `<pubkey>.json`; `index.json` stores slug and event-id lookups.

## Storage layout

```
<base_dir>/agents/index.json
<base_dir>/agents/<pubkey>.json
```

## Responsibilities

- Read, normalize, sanitize, and persist installed-agent JSON records.
- Maintain the global installed-agent index.
- Provide write-side mutation APIs for installing, deleting, activating, deactivating, and updating agent records.
- Provide read projections for crates such as `tenex-project` without requiring them to mutate storage.

## Boundaries

- No SQLite. Agents are global JSON files, not project database rows.
- No project event mutation. Project membership is still derived by `tenex-project` from project events.
- Keep project consumers read-side only; mutation behavior belongs here.
