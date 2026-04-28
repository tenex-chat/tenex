# tenex-system-prompt

Library crate. Pure assembly of an agent's system-prompt string from three inputs: agent identity, project context, and the set of skills the agent is allowed to load.

The whole public API is a single synchronous function:

```rust
build(&AgentIdentity, &ProjectContext, &[SkillRef]) -> String
```

Canonical spec: `docs/plans/2026-04-28-tenex-system-prompt-library.md`.

## In scope

- Persona / identity composition (name, short pubkey, optional category).
- Project-context rendering (working dir, optional title, optional owner).
- Available-skills declaration (name, when-to-use, the tool that loads each skill — pointers only).
- Identity-level guidance fragments (todo usage, tool-description style) that don't change per turn.

## Deliberately out of scope

- Tool definitions or tool docs. Those flow from the agent runner straight to `rig`.
- Skill bodies. They arrive via the `load_skill` tool result, never in the system prompt.
- Reminders, message-stream content, per-turn variability.
- Available *agents* / delegation peers. This crate is identity, not coordination.
- Provider/model-aware formatting. One string for every provider.
- Storage, I/O, async, `Result`. None of this crate can fail.
- Caching. The runner caches the returned string; this crate is stateless.

## Stability contract

Two `build` calls with byte-identical inputs produce byte-identical output. The runner relies on this to use the system prompt as a cache anchor. Any change that varies output across calls with the same inputs (timestamps, hash-map iteration, randomness) is a bug.

Field order, fragment order, whitespace, and trailing-newline handling are all part of the contract. Adjusting them invalidates downstream caches and must be a deliberate, reviewed change.

## Where to extend

- New persona overlay → extend `AgentIdentity` and the identity fragment.
- New always-on project field → extend `ProjectContext` and the project-context fragment.
- New skill metadata for the listing → extend `SkillRef` and `render_available_skills`.
- New identity-level guidance block → add a `const &str`, push it into `parts` in the documented order, and update the golden tests in `tests/build.rs`.

Anything that varies per turn does not belong here — it belongs in `tenex-context` (message stream) or in the agent runner.
