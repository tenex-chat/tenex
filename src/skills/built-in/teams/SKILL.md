---
name: teams
description: Understand and manage agent team configurations
---

# Teams

Teams are a local grouping mechanism for agents — purely local (no Nostr events).

## What Teams Are

Teams let agents see their immediate teammates in detail while seeing other teams as collapsed one-liners. This keeps system prompts focused as projects grow to many agents.

## File Locations

Teams are defined in JSON files on disk:

- **Global teams**: `$TENEX_BASE_DIR/teams.json` — applies to all projects in this TENEX instance
- **Per-project teams**: `$TENEX_BASE_DIR/projects/<project-id>/teams.json` — overrides global teams with the same name

The project ID is available from the `ID` field in the `<project-context>` section of your system prompt. Use `home_fs_read` / `home_fs_write` to read and write these files.

## JSON Schema

```json
{
    "teams": {
        "code-team": {
            "description": "Handles code implementation and review",
            "teamLead": "execution-coordinator",
            "members": ["execution-coordinator", "claude-code", "clean-code-nazi"]
        },
        "planning-team": {
            "description": "Researches, plans, and architects features",
            "teamLead": "architect-orchestrator",
            "members": ["architect-orchestrator", "tenex-planner", "explore-agent"]
        }
    }
}
```

## Rules & Conventions

- **Team names must be unique** within a file. Per-project teams override global teams with the same name (full replacement, not field-level merge).
- **`teamLead`** must be a valid agent slug and **should** also appear in `members`. The service normalizes this — if the lead is omitted from `members`, they are implicitly added — but explicit inclusion is recommended.
- **An agent can belong to multiple teams.**
- **`members` may be omitted** — defaults to empty array; the lead is then the sole member after normalization.
- **`delegate()` accepts team names** — routes to the team lead. Agent slugs always take priority over team names.

## How to Modify Teams

Agents can read and write these JSON files directly using `home_fs_read` / `home_fs_write`. Changes are picked up immediately on next system prompt rebuild (mtime-aware caching — no restart needed).

Example workflow:
```
1. home_fs_read the current teams.json
2. Modify the JSON (add/remove teams, change members)
3. home_fs_write the updated teams.json
4. Your next delegation or system prompt rebuild reflects the changes
```

## Effect on System Prompt

- **Agents in a team**: See their teammates in detail (`<teammates>` block with full Use Criteria) and other teams as one-line summaries (`<other-teams>` block).
- **Agents not in any team**: See all agents with full details (no change from current behavior — backwards compatible).
- **Active team scope**: When a job has a `["team", "x"]` tag, all agents handling that job see only that team's context, regardless of their actual membership.
