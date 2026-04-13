---
name: agent-management
description: "Create and update agent configurations (identity, role, instructions, tools) and modify project metadata via owner-signed Nostr 31933 events. Use when onboarding new agents, changing agent roles or instructions, assigning tools to agents, adding or removing agents from a project, or updating project title, description, image, or repository metadata."
tools:
  - agents_write
  - modify_project
---

# Agent Management

Manage agent identities and project-level metadata within TENEX. Covers creating new agents, updating existing agent configurations, and publishing owner-signed mutations to the project's Nostr 31933 event.

## Tools

### `agents_write`

Creates or updates a local agent identity with its configuration.

- **Parameters:** `slug` (identifier), `name`, `role`, `instructions`, `useCriteria` (when to select this agent), `llmConfig` (optional model override), `tools` (optional list of tool names).
- **Creates** a new agent with a fresh keypair if the slug does not exist.
- **Updates** the existing agent in storage if the slug is already registered.
- Tool names are normalized automatically (e.g. `mcp__tenex__` prefixes are stripped).

### `modify_project`

Modifies the current project's owner-signed Nostr 31933 event, allowing agent roster and metadata changes.

- **Parameters:**
  - `add_agents` — agent slugs to add as project members.
  - `remove_agents` — agent pubkeys or slugs to remove.
  - `set` — key/value pairs for metadata updates (`title`, `description`, `image`, `repo`).
- Resolves slugs to pubkeys and validates no conflicts before publishing.

## Workflow

1. **Create an agent:** Call `agents_write` with a unique slug, a descriptive name, role, and instructions. Optionally assign tools.
2. **Add the agent to the project:** Call `modify_project` with `add_agents` containing the new agent's slug.
3. **Update agent config:** Call `agents_write` again with the same slug and updated fields.
4. **Update project metadata:** Call `modify_project` with `set` to change title, description, image, or repo URL.
5. **Remove an agent:** Call `modify_project` with `remove_agents` containing the agent's slug or pubkey.
