# `tenex-system-prompt` — Product Spec

## Purpose

A small Rust crate that turns an agent's identity, its project context, and the set of skills it can load into a single system-prompt string. Pure assembly. No I/O, no provider awareness, no opinions about the message stream.

The output is treated as opaque by every downstream consumer: it is the cache anchor, not a structured object.

## Companion to `tenex-context`

| Crate | Concern | Change rate |
|-------|---------|-------------|
| `tenex-system-prompt` | Who the agent is. Identity + capability description. | Slow per agent. |
| `tenex-context` | What the model sees right now. Messages, decay, cache. | Fast. |

The two are siblings, not stacked. The agent runner calls `tenex-system-prompt::build(...)` once when its inputs are known, then hands the resulting string to `tenex-context::project(...)` every turn.

## Scope

- Rust-only.
- Called by the agent runner. Neither `tenex-context` nor `tenex-conversations` imports this crate.
- Output is "stable per agent identity": byte-identical across turns and conversations until one of the inputs changes (instructions edited, available-skills set changes, project context changes). The runner is responsible for caching the result and recomputing only when an input changes — the crate itself holds no cache.

## What it owns

- **Agent persona / instruction composition.** Name, role, instructions, category overlays.
- **Project-context rendering.** Project name, description, owner, any always-on framing.
- **Available-skills declaration.** Lists which skills exist, when to use each, and the tool name that loads it. Names and pointers only — never the skill body.

## What it does *not* own

- **Tool definitions or tool docs.** MCP tools and built-in tools flow agent → `rig` directly. No tools section is rendered into the system prompt.
- **Skill content.** Loaded on demand via the `load_skill` tool; the body returns as a system-reminder inside the tool result, not in the system prompt.
- **Reminders.** They live in the message stream, never in the system prompt.
- **Provider/model-aware formatting.** One string for every provider; any provider-specific quirks belong to the LLM-call layer.
- **Storage.** No reads, no writes.
- **Cache decisions.** Downstream's problem.

## API surface

```
build(
  agent: &AgentIdentity,
  project_ctx: &ProjectContext,
  available_skills: &[SkillRef],
) -> String
```

That's the whole API. Pure function, no `Result`, no I/O.

- `AgentIdentity` — pubkey, name, instructions, category, any persona overlays.
- `ProjectContext` — project name, description, owner, anything else always-on.
- `SkillRef` — skill name, when-to-use blurb, the tool name that loads it. No body.

## Stability contract

Two calls with byte-identical inputs produce byte-identical output. This is the contract that makes the system prompt a viable cache anchor: the runner can compute it once at agent boot and reuse the same string for every turn until an input changes.

When an input does change (instructions edited, a skill added/removed at the agent level, project metadata edited), the runner recomputes and accepts the resulting cache miss. "Available skills" here is the *set the agent could load*, not the *set currently loaded* — runtime activation does not change the system prompt.

## Layering

```
tenex-agent (run loop, LLM calls, tool execution)
   ↓
tenex-system-prompt    tenex-context
       (identity → text)    (history → messages[])
                              ↓
                     tenex-conversations (storage)
```

Sibling to `tenex-context`. Neither imports the other.

## Testing model

Pure function, golden tests. Fixture: an `AgentIdentity` + `ProjectContext` + skill list. Assertion: the output matches a golden file. Diffs are trivial to read because the output is just text.

## Non-goals

- No segment metadata, no cache-region annotations, no structured `SystemPrompt` value object. The output is `String`.
- No tool rendering.
- No provider-aware variants.
- No persistence; the runner caches in-process if needed.
- No reminders, no skill bodies, no per-turn variability.
- No async API. The function is synchronous because nothing in it can block.

## Success criteria

- The Rust agent runner builds zero system-prompt strings by hand.
- Adding a new persona overlay or project-context field is one change in this crate plus a fixture.
- Two `build` calls with identical inputs produce byte-identical strings.
- `tenex-context` never imports this crate; the system prompt crosses the boundary as a `&str`.
