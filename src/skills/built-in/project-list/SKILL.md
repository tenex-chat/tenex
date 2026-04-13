---
name: project-list
description: "List all known TENEX projects with their agents, running status, and metadata. Aggregates active runtimes, Nostr-discovered projects, and offline local storage into a unified view. Use when checking which projects exist, viewing agent assignments, determining which projects are running, or getting an overview of the TENEX deployment."
tools:
  - project_list
---

# Project List

Provides a unified view of all known TENEX projects by aggregating three sources: active runtimes (running projects), Nostr-discovered projects, and offline projects from local agent storage.

## Tools

### `project_list`

Lists all known projects with their agents and running status. Takes no parameters.

**Returns** for each project:
- `id` — the project's d-tag identifier.
- `title`, `description`, `repository` — project metadata.
- `isRunning` — whether the project has an active runtime.
- `agents` — array of assigned agents with slug, shortened pubkey, role, and PM flag.

**Summary** includes `totalProjects`, `runningProjects`, and `totalAgents` counts.

## Workflow

1. Call `project_list` with no arguments to retrieve the full project inventory.
2. Use the `isRunning` flag to identify active vs. dormant projects.
3. Inspect the `agents` array to understand team composition and roles.
4. Use project IDs from the results with other skills (e.g. `conversation-search` with a `projectId` filter) for deeper investigation.
