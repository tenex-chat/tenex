# tenex-context

Library crate. Turns a conversation identifier into the `messages[]` half of an LLM request. Owns projection (history → messages), context-management strategies (compaction, tool-result decay, reminder overlays), and cache-anchor decisions for the message stream.

Sits between `tenex-conversations` (storage) and the agent runner (LLM loop). Sibling of `tenex-system-prompt`; neither imports the other.

Canonical spec: `docs/plans/2026-04-28-tenex-context-library.md`

## Public API

Two entrypoints; everything else is strategy plumbing.

- `project(store, conversation_id, agent_pubkey, system_prompt: &str, model_profile, tool_defs, summarizer, name_resolver, proactive_context, compaction_override) -> Projection` — read history, run the strategy stack, emit `messages` + `cache_breakpoints` + `telemetry`. The system prompt enters opaque; this crate never inspects or assembles it. `proactive_context` is overlaid by the proactive-context strategy; `compaction_override` is a one-shot threshold override for reactive compaction retries.
- `record_turn(store, conversation_id, agent_pubkey, turn)` — persist what the agent runner sent and what the provider observed. Writes per-message rows into `agent_prompt_history` and updates `agent_context_state`.

Both take `&ConversationStore` from `tenex-conversations`. Stateless from the consumer's perspective: the crate holds no long-lived state.

Key types: `ModelProfile`, `ToolDef`, `Message`, `Projection`, `BreakpointHint` / `BreakpointKind`, `ProjectionTelemetry`, `TurnRecord`, `CacheObservation`.

## The `preserve_results` contract

Tool definitions carry a `preserve_results: bool`. The decay strategy resolves each tool-result message in the working set against the `tool_defs` argument:

- `tool_name` matches a def with `preserve_results: true` → never evicted.
- `tool_name` matches a def with `preserve_results: false` → decay-eligible.
- `tool_name` not in `tool_defs` (e.g., a deactivated built-in skill) → decay-eligible by default.

Two tools must set the flag from day one: `load_skill` (skill body is load-bearing context) and `delegate` (the delegated work product is the substrate for the rest of the agent's reasoning). The flag is opt-in; new no-decay tools require zero changes to this crate.

## Strategy pipeline

Default stack, fixed order:

1. `CompactionToolStrategy` — when projected tokens exceed a fraction of `model_profile.max_context_tokens`, collapse the middle of the message vector (preserving the system prompt and a tail window) into a single summary marker.
2. `ToolResultDecayStrategy` — honors `preserve_results`. Keeps the most recent decay-eligible tool results verbatim; older eligible results are replaced by a placeholder message that retains the tool-call linkage.
3. `ExpandDelegationMarkersStrategy` — renders delegation markers into user-shaped messages (full transcript for direct children, one-line reference for nested), so later overlays have a message to attach to.
4. `ProactiveContextStrategy` — overlays the pre-computed `<proactive-context>` block onto the last non-system message.
5. `RemindersStrategy` — appends a system-reminder note to the last non-system message so it rides at the tail of the prompt.

Each strategy implements the `Strategy` trait (`name() -> &'static str`, `apply(&self, &mut ProjectionContext) -> anyhow::Result<()>`). Adding a new strategy is one file in `src/strategies/` plus a test fixture; nothing else changes.

## Cache anchors

`SystemAnchor` is emitted unconditionally at the boundary just past the system prompt. `MessageStream` is emitted only when `model_profile.prompt_cache` is true. The runner consumes these positions and attaches provider-specific cache controls; this crate names *where* and *what kind*, not the protocol mechanics.

## Not in scope

- **System-prompt assembly.** Belongs to `tenex-system-prompt`. The system prompt arrives as `&str` and is treated as stable.
- **Tool definitions / tool transmission.** Tool defs flow agent → `rig` directly. Tool defs enter this crate only so strategies can resolve `preserve_results` by name.
- **The LLM call itself.** No sockets, no streaming, no provider auth.
- **Skill resolution, agent identity, instructions.** Inputs the agent runner assembles upstream into the system prompt.
- **Lessons / RAG / vector storage.** Out of scope here, as elsewhere in the workspace.

## How to approach changes

1. `cargo test -p tenex-context` before and after edits.
2. New strategies live as `src/strategies/<name>.rs` plus an entry in `src/strategies/mod.rs::default_stack()` (or a custom stack at the call site).
3. Storage methods in use: `list_messages`, `list_tool_messages`, `list_prompt_history`, `get_agent_context_state`, `append_prompt_history`, `upsert_agent_context_state`. Consult `tenex-conversations` before adding more.
4. Do not import `tenex-system-prompt`. Do not call into LLM clients. Do not build provider-specific message shapes — translate from `Message` at the runner boundary.
