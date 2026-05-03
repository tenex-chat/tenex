# Creating Skills

A skill is a directory containing a `SKILL.md` file with YAML frontmatter and Markdown instructions the agent reads when the skill becomes relevant. Skills can also include supporting files in `references/`, `scripts/`, and `assets/` subdirectories.

## Directory layout

```
my-skill/
├── SKILL.md              # required: frontmatter + instructions
├── references/           # optional: docs the agent reads on demand
│   └── domain-deep-dive.md
├── scripts/              # optional: executable helpers
│   └── run.sh
└── assets/               # optional: templates, examples
    └── template.md
```

The directory name **is** the skill ID. Keep it short, kebab-case, descriptive: `react-best-practices`, `pr-review`, `changelog`.

## SKILL.md format

A `SKILL.md` is YAML frontmatter delimited by `---`, followed by Markdown.

### Frontmatter fields

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Human-readable name shown in skill listings |
| `description` | yes | One-line description used to decide when the skill is relevant. Be specific — this is what the agent matches against the user's request |
| `tools` | no | List of tool names this skill expects to use |
| `only-tools` | no | Restrict the agent's tool set to *only* these while the skill is active |
| `allow-tools` | no | Add these tools to the agent's set while the skill is active |
| `deny-tools` | no | Block these tools while the skill is active |

Example:

```yaml
---
name: react-performance
description: React and Next.js performance optimization patterns — bundle size, rendering, hydration, server components
tools:
  - Read
  - Edit
allow-tools:
  - WebFetch
---
```

### Body

The body is markdown the agent reads when the skill is loaded. Keep it lean:

- Open with what the skill does and when to use it (the trigger phrases).
- Walk through the workflow as numbered steps.
- Move deep reference material (long tables, exhaustive examples) into `references/` and link to it from the body.

Skills follow a **progressive-disclosure** pattern: only the frontmatter is preloaded into context. The body of `SKILL.md` is read when the skill is activated, and `references/*` files are read by the agent on demand. Smaller files = less context burned per relevant fact.

## Where to install a skill

Skills are loaded from four scope directories in this precedence order — if the same skill ID exists in more than one, the higher-precedence directory wins:

| # | Scope | Path | When to use |
|---|---|---|---|
| 1 | **Built-in** | `$TENEX_BASE_DIR/skills/built-in/<id>/` | Reserved for skills shipped with TENEX itself. **Never install here.** |
| 2 | **Agent** | `$AGENT_HOME/skills/<id>/` | This agent, every project. The agent's personal toolkit. |
| 3 | **Project** | `$PROJECT_BASE/.agents/skills/<id>/` | Every agent on this project. Shared team conventions. |
| 4 | **Shared** | `$HOME/.agents/skills/<id>/` | Every agent, every project, on this machine. Rarely the right choice — prefer **Agent** scope for personal cross-project skills. |

### Choosing a scope

Ask: *who else benefits from this skill?*

- Only this agent, on every project → **Agent**
- The whole team on this project → **Project**
- Genuinely every agent on this machine → **Shared** (uncommon — confirm explicitly)

Never write to **Built-in** — those skills ship with TENEX and are managed by the TENEX release, not by user installs.

### Install commands

```bash
# Agent (this agent, every project)
npx skills add <owner/repo@skill> --dir "$AGENT_HOME/skills" -y

# Project (every agent on this project)
npx skills add <owner/repo@skill> --dir "$PROJECT_BASE/.agents/skills" -y

# Shared (every agent on this machine — rare)
npx skills add <owner/repo@skill> --dir "$HOME/.agents/skills" -y
```

## Authoring a new skill from scratch

1. Pick the install scope (above) and `cd` into its directory.
2. `npx skills init <skill-id>` to scaffold, or create the directory and `SKILL.md` by hand.
3. Write the frontmatter — a sharp `description` matters most; the agent matches user requests against it.
4. Write the body. Open with the trigger phrases that should activate the skill, then the workflow.
5. If the skill needs deep reference material, add `references/<topic>.md` files and link to them from the body. Keep `SKILL.md` itself short.
6. If the skill ships executable helpers, put them in `scripts/`. Templates and static assets go in `assets/`.

## Tips

- **Be specific in `description`.** "Helps with React" matches nothing useful; "React 19 server-component migration patterns" matches the right requests.
- **Write triggers up front.** List the phrasings ("when the user asks X, …") at the top of the body so the agent knows when to act.
- **One skill, one job.** A skill that tries to cover both "PR reviews" and "release notes" matches neither well. Split it.
- **Leave the deep stuff in `references/`.** Each file the agent doesn't have to read is context it gets to use elsewhere.
