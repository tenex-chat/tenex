# TENEX Context Management And Reminders

This document explains how TENEX shapes the message list sent to the LLM on each
turn: context-window management (compaction, tool-result decay), delegation-marker
expansion, proactive RAG context, and reminders.

The short version:

- The canonical conversation transcript is **immutable**.
- On each turn, the **`tenex-context`** crate *projects* that history into the
  `messages[]` the model sees, by running a fixed pipeline of strategies over an
  in-memory copy. It never mutates stored messages.
- The system prompt is assembled once (by `tenex-system-prompt`) and stays
  stable across the turn's steps — it is the cache anchor. Volatile per-turn
  material (reminders, RAG context) is added to the projected messages, not to
  the system prompt and not by rewriting historical messages.
- Projection is **deterministic** from its inputs. There is no asynchronous
  reminder queue, no provider-specific delta/full/skip logic, and no
  cache-anchor decision gating — those were TypeScript-era concepts that no
  longer exist.

## Ownership

- **`tenex-context`** owns projection. Its public surface is `project()` /
  `project_with_options()` (history → `messages[]`, with token estimates and
  cache-breakpoint hints) and `record_turn()` (write-back to per-agent prompt
  history). Modules: `projection`, `tokens`, `turn`, `types`, and `strategies/`.
- **`tenex-agent`** drives it. The turn loop calls `project_with_options(...)`
  for each step with a stable system prompt, the precomputed proactive-context
  block, and the tool definitions; it calls `record_turn(...)` afterward.

## The strategy pipeline

`tenex-context` runs these strategies in a **fixed order** over a clone of the
projected message list. Each is a pure transformation; none touches the stored
transcript.

1. **Compaction** — when the projected token count reaches the threshold
   (default 80% of the model's context window), the system prompt and a recent
   tail of messages (default 6) are preserved and the middle is collapsed into a
   summary. The summary is an 8-section LLM-produced digest when a
   `CompactionSummarizer` is available (`tenex-agent` provides an LLM-backed
   implementation); otherwise a deterministic placeholder is used.
2. **Tool-result decay** — the most recent decay-eligible tool results (default
   3) are kept verbatim; older ones are replaced by a marker that preserves the
   tool-call/tool-result linkage. Eligibility is per tool via `ToolDef.preserve_results`:
   tools whose output is a work product (e.g. `load_skill`, `delegate`) are never
   decayed.
3. **Delegation-marker expansion** — pending delegations are dropped from the
   stream and surfaced as an `<agent-delegations>` reminder block on the last
   non-system message; completed/aborted delegations are rewritten in place as a
   user message carrying the child transcript; deeply nested delegations are
   reduced to a one-line reference to bound prompt growth.
4. **Proactive context (RAG)** — a precomputed RAG block is appended to the last
   **user** message (computed once per invocation and threaded in as a stable
   option, so it does not perturb tool-call linkage).
5. **Reminders** — the current todo state is rendered as a
   `<system-reminder><agent-todos>` block and appended inline to the last
   non-system message.

## Reminders, concretely

Reminders are deterministic functions of current state, not a stateful engine.
They reach the model in two places:

- **In the user message.** At bootstrap, the runner composes the user message
  from the triggering event plus appended plain-text blocks: the todo reminder,
  conversation reminders read from the store, and external/remote-agent
  disclosures. At projection time, the reminders strategy appends the current
  `<agent-todos>` block to the last non-system message.
- **In the system prompt (stable additions only).** At bootstrap the runner
  appends an active-tools reminder and an active-shell-tasks reminder to the
  otherwise-stable system prompt. Because these are fixed for the duration of the
  turn, they do not break cache stability.

There is **no** separate runtime-overlay store, no `queue/defer/advance/collect`
async reminder context, and no per-provider placement model. Supervision
messages that re-engage an agent are persisted as ordinary `supervision`-type
user messages in the conversation store (see `docs/SUPERVISION.md`) and then
projected like any other message — they are not a special reminder channel.

## Prompt history and cache observation

`record_turn()` appends one entry per visible message to the per-agent prompt
history (`agent_prompt_history`), capturing `agent_pubkey`, `prompt_id`,
`sequence`, `role`, `source_kind`, and `overlay_type` (e.g. `delegation` for an
expanded delegation marker). This answers "what did this agent actually see,"
separately from and without mutating the canonical transcript.

Cache observations from the turn (whether a cache hit occurred, breakpoint hints)
are recorded for **observability**. They do not gate strategy behavior: reminders
are always appended to the last message and never rewrite earlier ones, so there
is no cache-anchor decision logic to maintain.

## Configuration

There is no per-strategy configuration surface. The pipeline order is fixed and
the thresholds are constants in `tenex-context`: compaction at 80% of context,
a 6-message preserved tail, 3 verbatim recent tool results. The model's context
window size is supplied by the runner per request.

## Design intent

- **Immutability + projection.** The transcript is the source of truth; the
  prompt is a deterministic projection of it. This prevents the prompt-drift
  failure mode where repeatedly appending reminders into old user messages
  duplicated content and grew the prompt without bound.
- **Stable system prompt = reliable caching.** Everything that varies per turn
  lives in the projected messages (appended to the tail), so the system-prompt
  cache anchor stays byte-stable. See `docs/system-prompt-architecture.md`.
- **One pipeline, no hidden lifecycle.** Five composable strategies in a fixed
  order, each pure, replace the previous runtime's reminder engine, async queue,
  and overlay bookkeeping.

## Where to look

- `crates/tenex-context/` (`projection.rs`, `strategies/`, `turn.rs`, `types.rs`) and its `AGENTS.md`.
- `crates/tenex-agent/src/agent_bootstrap/` (user-message composition, system-prompt reminders) and the projection call in `crates/tenex-agent/src/turn_loop/`.
- `docs/system-prompt-architecture.md` for the stable system-prompt anchor.
