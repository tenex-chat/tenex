# TENEX System Prompt Construction

This document describes how TENEX assembles an agent's system prompt. The
central property is **determinism**: assembly is a pure function of its inputs,
with no background compilation, no caching layer, and no separate "effective
instructions" step. Identical inputs produce a byte-identical prompt, which is
what makes the prompt a stable cache anchor for downstream LLM calls.

## 1. Ownership

System-prompt assembly is owned by the **`tenex-system-prompt`** crate. Its
`build_system_prompt` entry point is a pure, synchronous, I/O-free function: it
takes already-resolved inputs and returns the assembled prompt string. It does
not read the filesystem, open relays, or call an LLM.

The **`tenex-agent`** runner is responsible for *gathering* those inputs during
agent bootstrap — discovering the agent home, reading project instructions,
resolving skills and workflows, loading project context — and then calling
`build_system_prompt`. Caching the resulting prompt across turns (for prompt-
cache reuse) is the runner's concern, not the assembler's.

This replaces the old runtime's background "prompt compiler" model entirely.
There is no service that recompiles instructions ahead of time and no
"Effective Agent Instructions" artifact; the prompt is recomputed from inputs
each time it is needed.

## 2. Assembly Order

`build_system_prompt` emits fragments in a fixed order. Order, field layout, and
whitespace are part of the determinism contract — they must not vary for equal
inputs. The fragments, in sequence:

1. **Agent identity** — name, short pubkey, optional category.
2. **Global system prompt** — injected when configured.
3. **Home directory** — the agent's injected home files (see §4), wrapped in a
   `<memorized-files>` block inside `<home-directory>`.
4. **System-reminders explanation** — static guidance that system reminders are
   background context, not user speech.
5. **Agent instructions** — the agent's configured base instructions.
6. **Preloaded skills** — the rendered list of available skill references.
7. **Workflows** — the agent's authored workflows (`$AGENT_HOME/workflows/*.yaml`).
8. **Environment variables** — `$AGENT_HOME`, `$PUBKEY`, `$PROJECT_BASE`,
   `$PROJECT_ID`, `$TENEX_BASE_DIR`, etc. Skipped for workspace-restricted
   categories.
9. **Project context** — project title/id/owner/conversation id, plus a
   `<workspace>` block (root path, branch, worktrees, cwd), a `<channels>` block
   for Telegram bindings, and an `<agents.md>` block (see §5).
10. **Available agents** — teammates, other teams, and unaffiliated agents,
    filtered by the active team.
11. **Todo guidance** and **tool-description guidance** — static guidance.
12. **Category-specific guidance** — orchestrator / principal / domain-expert
    guidance and delegation tips, selected by the agent's category.
13. **Telegram chat context** and **delivery rules** — when the trigger arrived
    via Telegram and/or the agent has Telegram bindings.
14. **Scheduled tasks** — recurring and one-off tasks with next-run times, when
    present.

Optional fragments are omitted when their input is absent, but the relative
order of whatever remains is fixed.

> **Conversation reminders are not part of the system prompt.** They are built
> by the runner and injected into the **user message**, not into the system
> prompt, so they never perturb the cache anchor. See
> `docs/CONTEXT-MANAGEMENT-AND-REMINDERS.md`.

## 3. Lessons

Lessons are not compiled into the prompt by a background process, and they are
not stored in any database. The mechanism is the agent home:

- The `learn` tool (in `tenex-agent`) maintains a single `+INDEX.md` file in the
  agent's home directory. When an agent records a lesson, the tool asks an LLM
  to **merge** the new lesson into the existing `+INDEX.md`, organized by
  category, and writes the result back **synchronously**.
- `+INDEX.md` is not special-cased at assembly time. It is injected because it
  is a `+`-prefixed home file (see §4), like any other.

This is the intentional divergence from the previous runtime, where lessons and
lesson comments were compiled into instructions out of band. Here, lessons live
as an LLM-maintained Markdown file that is injected like any other home file.

## 4. The Agent Home

Each agent has a home directory at `<base_dir>/home/<first-8-hex-of-pubkey>`.

At bootstrap, the runner reads files in that directory whose names start with
`+`, sorted by name. Up to 10 such files are injected, each truncated to a
bounded length, into the home-directory fragment. This is the single mechanism
by which durable, agent-authored context (lessons via `+INDEX.md`, plus any
other `+`-prefixed notes) reaches the prompt.

## 5. Project Instructions

The runner reads the project's root `AGENTS.md` and injects it into the
`<project-context>` block, but only when it is below a small size bound (so a
large `AGENTS.md` does not dominate the prompt). When absent or over the bound,
the block is omitted.

## 6. Design Intent

Keeping assembly pure and deterministic has three consequences that the rest of
the system depends on:

- **Cache stability.** Equal inputs yield an identical prompt, so prompt caching
  upstream is reliable. Anything that should vary turn-to-turn (reminders,
  freshly retrieved context) goes into the user message instead.
- **No hidden lifecycle.** There is no compiler to start, no cache to invalidate,
  no recompile to wait on. The prompt is a function of inputs the runner already
  has.
- **Clear ownership.** `tenex-system-prompt` decides *shape and order*;
  `tenex-agent` decides *what the inputs are*. Changing the assembled output
  means changing one pure function, not coordinating a background subsystem.
