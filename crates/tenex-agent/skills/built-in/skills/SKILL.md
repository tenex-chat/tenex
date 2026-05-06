---
name: skills
description: Helps users discover and install agent skills when they ask "how do I do X", "find a skill for X", "is there a skill for X", or want to extend agent capabilities. Use when the user is looking for installable skills from the open agent skills ecosystem.
---

# Skills

Dispatcher for the open agent skills ecosystem (https://skills.sh/) and the `npx skills` CLI. The full instructions live in `references/` and are read on demand — do not act from memory; open the relevant reference before doing the work.

## When to read which reference

- User asks **"how do I do X"**, **"find a skill for X"**, **"is there a skill for X"**, **"can you do X"** (specialized capability), or wants to extend agent capabilities → read [`references/search.md`](references/search.md) and follow it to find, vet, and install the skill.

- User wants to **author** a new skill (directory layout, frontmatter, install scopes) → read [`references/creating-skills.md`](references/creating-skills.md) and follow it.

Relative links resolve against this skill's `path` attribute (the directory shown in the surrounding `<skill ...>` tag).
