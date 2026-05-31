---
title: Context Projector and Step Loop Architecture
slug: context-projector-step-loop
summary: The context window failure in production grew from ~25K to 264K tokens across 12 rig sub-turns inside a single run_turn_loop iteration, exceeding Ollama's 256K
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-14
updated: 2026-05-18
verified: 2026-05-14
compiled-from: conversation
sources:
  - session:686b6ab8-e86d-458d-b463-ce5fa69e24fb
  - session:88ad7919-ca15-4330-84f5-e235bd9611a7
---

# Context Projector and Step Loop Architecture

## Problem

The context window failure in production grew from ~25K to 264K tokens across 12 rig sub-turns inside a single run_turn_loop iteration, exceeding Ollama's 256K limit. The proactive compactor triggers at 80% of max_context_tokens but only runs once at bootstrap, never re-running inside rig's multi-turn loop, which allows context to grow unbounded mid-turn. max_context_tokens is hardcoded to 200,000 everywhere rather than pulled from the model registry. [^686b6-1]


## Architectural Direction

The correct long-term architecture is for TENEX to own every provider request boundary via a step loop around rig's single-turn completion, not to add content-policy mutations in the provider request sanitizer. Putting content policy in the sanitizer layer is wrong because it splits the source of truth across two layers (projector + sanitizer), makes persisted conversation store diverge from wire payload, cannot express policies requiring their own LLM calls (like compaction), and is a fast-fix tell that short-circuits the architecture. Sanitizer-seam decay (Option C) is useful only as a guardrail, not as the primary context policy seat; silent decay in the sanitizer would split the source of truth. [^686b6-2]

## Current Integration Constraints

Rig 0.35's MultiTurnStreamItem does not provide a clean history handoff point; messages only commit to new_messages after the inner loop ends, so breaking on a ToolResult item sees partial state. ctx_msg_to_rig drops call_id, reasoning blocks, signatures, and provider-specific fields, which would break providers that need those fields if messages are re-projected mid-loop. Persistence currently records tool messages as one collapsed whole-loop event rather than per-step, so splitting the loop requires new per-step transcript/accounting semantics. tool_defs passed to context projection are currently Vec::new(), so preserve_results is dead and not honored at runtime. PromptCancelled/MaxTurnsError must not be abused as a fake history handoff mechanism. [^686b6-3]

## Issue Tracking

Issue #109 addresses projecting context before every in-turn provider request, using a TENEX-owned step loop around rig's single-turn completion. Issue #108 addresses auto-compacting context on 400 'prompt is too long' errors and retrying the turn, as a safety-net guardrail over the #109 root fix. #108's retry classifier should live in crates/tenex-agent/src/turn_loop/error_classify.rs, wrapping the new step abstraction with one bounded retry. The plan is committed to docs/plans/2026-05-14-context-projector-single-source-of-truth.md, which is in .gitignore and treated as a local working doc by project convention. [^686b6-4]

## Milestone Plan (#109)

M1: Carry reasoning blocks and provider call_ids in tenex_context::Message and ToolCall as a pure additive widening with no wire-payload change until M6.
M2: Create a TENEX-owned turn tool registry replacing ToolSet::build_for_turn, dispatching tool execution through the registry to bypass ToolDyn, with synthetic IDs remaining only as a defensive fallback.
M3: Plumb live tool_defs into projection so ToolResultDecayStrategy's preserve_results flag becomes functional.
M4: Extend the projection API with an options struct accepting an in-turn tail of CtxMessages, avoiding write-then-read round-trips per step.
M5: Split persistence into per-step record_step_tool_messages and record_step_prompt_history rather than the current whole-loop record_turn_outcome.
M6: Replace run_agent! with a step loop in a new step_loop.rs organized as step/{projection,stream,tools}.rs rather than a dedicated turn_loop/model_factory.rs, with the canonical trace 68e9cad67ba34ef52499fc81cc23a4c5 as the end-to-end test.
M7: Ensure one EmitHook/ProgressMonitor spans the whole turn, not recreated per step.

<!-- citations: [^686b6-5] [^88ad7-2] -->
## Invariants and Performance Notes

Envelope images from the user prompt (turn_loop/mod.rs:60) must remain visible on every in-turn provider call, not just step 1. CompactionStrategy short-circuits cheaply when total <= threshold (compaction.rs:63-72), so per-step projection does not fire the LLM summarizer until context actually crosses 80%. Anthropic prompt caching (with_prompt_caching at turn_loop/mod.rs:214/218-220) must survive into the new step loop. PostCompletionOutcome::ReEngage semantics and supervision re-engagement at turn_loop/mod.rs:422 must be preserved in the step loop. Repeated run_agent! calls would recreate AgentLoopHook/ProgressMonitor; the progress guard must survive the whole turn. [^686b6-6]
## See Also

