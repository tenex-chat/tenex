---
name: teams
description: Understand and manage agent team configurations
---

# Teams

Teams are a local grouping mechanism for agents — purely local (no Nostr events). They let agents see their immediate teammates in detail while seeing other teams as collapsed one-liners.

## Files

- **Global teams**: `$TENEX_BASE_DIR/teams.json`
- **Per-project teams**: `$TENEX_BASE_DIR/projects/<project-id>/teams.json`

Per-project teams override global teams with the same name.

## Documentation

- **[schema.md](references/schema.md)** — JSON format, field definitions, and rules

## Usage

Modify teams with `home_fs_read` / `home_fs_write`. Changes are picked up immediately on next system prompt rebuild (mtime-aware caching).

To see all team members with pubkeys:

```
node $TENEX_SRC/src/skills/built-in/teams/scripts/team-roster.js
```

## Effects on System Prompts

- **In a team**: See teammates in detail, other teams as one-line summaries
- **Not in a team**: See all agents with full details
- **Job with team tag**: All handlers see only that team's context
- **Delegation**: `delegate()` accepts team names — routes to team lead
