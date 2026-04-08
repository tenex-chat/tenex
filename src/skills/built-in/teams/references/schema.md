# Teams JSON Schema

## File Format

Teams are defined in JSON files on disk with the following schema:

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

## Field Definitions

- **`teams`** (object): Top-level container for team definitions, keyed by team name
- **Team name** (string): Unique identifier for the team. Team names must be unique within a file.
- **`description`** (string): Human-readable description of the team's purpose
- **`teamLead`** (string): Agent slug of the team lead. Must be a valid agent slug and should appear in `members`. If omitted from `members`, the lead is implicitly added.
- **`members`** (array, optional): List of agent slugs in the team. Defaults to empty array if omitted; the lead is then the sole member after normalization.

## Rules

- Team names must be unique within a file. Per-project teams override global teams with the same name (full replacement, not field-level merge).
- An agent can belong to multiple teams.
- `delegate()` accepts team names — routes to the team lead. Agent slugs always take priority over team names.
