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

See references/schema.md for more.

See `references/details.md` for system prompt effects.
