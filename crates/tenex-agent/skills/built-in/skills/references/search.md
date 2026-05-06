# Finding and installing skills

This file is the full workflow for discovering and installing skills from the open agent skills ecosystem (https://skills.sh/) using the `npx skills` CLI.

## The Skills CLI

`npx skills` is the package manager for the open skills ecosystem.

| Command | Purpose |
|---|---|
| `npx skills find [query]` | Search the public catalog by keyword |
| `npx skills add <owner/repo@skill> --dir <path> -y` | Install a skill |
| `npx skills check` | Check for updates to installed skills |
| `npx skills update` | Update all installed skills |

Browse and rank skills at https://skills.sh/.

## Workflow

### 1. Understand what's needed

Identify the domain (React, testing, design, deployment, …) and the specific task. Decide whether this is common enough that a skill probably exists.

### 2. Check the leaderboard before searching

Visit https://skills.sh/ — the leaderboard ranks skills by total installs. Top sources for general-purpose work:

- `vercel-labs/agent-skills` — React, Next.js, web design
- `anthropics/skills` — frontend design, document processing

If the leaderboard already covers the need, skip to step 4.

### 3. Search the catalog

```bash
npx skills find <keywords>
```

Examples:

- "make my React app faster" → `npx skills find react performance`
- "help with PR reviews" → `npx skills find pr review`
- "create a changelog" → `npx skills find changelog`

Tips:

- Use specific keywords: `react testing` beats `testing`.
- Try alternates: `deploy` → `deployment`, `ci-cd`.

### 4. Verify quality before recommending

**Never recommend a skill based on search results alone.** Check:

1. **Install count** — prefer 1K+ installs; be cautious below 100.
2. **Source reputation** — official sources (`vercel-labs`, `anthropics`, `microsoft`) are more trustworthy than unknown authors.
3. **GitHub stars** — open the source repo; <100 stars warrants skepticism.

### 5. Present options to the user

Show the skill name, what it does, install count, source, the install command, and the skills.sh link. Example:

```
I found a skill that might help. "react-best-practices" provides React/Next.js
performance optimization guidelines from Vercel Engineering (185K installs).

Install: npx skills add vercel-labs/agent-skills@react-best-practices
Learn more: https://skills.sh/vercel-labs/agent-skills/react-best-practices
```

### 6. Confirm install scope, then install

Before running `npx skills add`, ask which scope the user wants. The four user-installable scopes and full rationale are in [`creating-skills.md`](creating-skills.md). Quick summary:

- **Just me, all projects** (Agent) → `$AGENT_HOME/skills`
- **Everyone on this project** (Project) → `$PROJECT_BASE/.agents/skills`
- **Every agent on this machine** (Shared) → `$HOME/.agents/skills` (rarely the right choice — confirm explicitly)

> Never install to `$TENEX_BASE_DIR/skills/built-in` — that scope is reserved for skills shipped with TENEX itself.

Once the user picks, install:

```bash
npx skills add <owner/repo@skill> --dir "<resolved-path>" -y
```

## When nothing matches

If no skill fits:

1. Tell the user nothing matched.
2. Offer to do the task directly with general capabilities.
3. If it's a recurring need, suggest authoring a skill — point them at [`creating-skills.md`](creating-skills.md) and `npx skills init <name>`.
