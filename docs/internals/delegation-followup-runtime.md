---
title: "Delegation Followup Runtime"
date: "2026-04-29"
audience: "llms"
scope: "How delegate_followup works in the Rust runtime, including event routing, persisted route lookup, id canonicalization, and comparison with the TypeScript RAL implementation."
status: "investigated"
related_docs:
  - "docs/internals/delegation-runtime.md"
  - "docs/internals/ral-lifecycle-and-mid-run-injection.md"
  - "docs/RUST-AGENT-SPEC.md"
related_files:
  - "crates/tenex-agent/src/tools/delegate_followup.rs"
  - "crates/tenex-agent/src/tools/delegate_followup_resolution.rs"
  - "crates/tenex-protocol/src/nostr/encoder.rs"
  - "tenex/src/runtime_cmd/mod.rs"
  - "src/tools/implementations/delegate_followup.ts"
  - "src/services/ral/DelegationRegistry.ts"
confidence: "high for current Rust source, medium for restart/cross-project edge cases"
---

# Delegation Followup Runtime

## Question

How does `delegate_followup` deliver additional instructions to an already delegated agent, how does it avoid creating a new child conversation, and how does the parent still wake up in the original parent conversation when the delegatee completes?

## Short Answer

In the Rust runtime, a followup is a normal kind:1 agent-authored message into the existing delegated child conversation. The followup p-tags the delegatee and carries an `["e", original_delegation_event_id, "", "root"]` tag. Because the root `e` tag is the original delegation event, `conversation_id_from_event()` resolves the followup to the child conversation rather than to a new conversation.

`delegate_followup` accepts `delegation_conversation_id`, with `delegation_event_id` as an input alias. The id may be the original 64-character delegation id, a unique 10-character prefix, or a previous followup event id. Rust canonicalizes those inputs through the local `conversation.db`: it finds the child conversation whose `rustRuntime.delegation` route matches the original delegation and scans persisted messages so a prior followup id maps back to the canonical original delegation id.

The runtime deliberately does not register a new delegation route for followups. Fresh route registration rejects events that already have an `e` tag. The existing route stored under the original child conversation remains authoritative. When the delegatee later publishes `status=completed` in that child conversation, the runtime reads the stored route and dispatches the completion back to the parent agent in the parent conversation.

## System Map

`crates/tenex-agent/src/tools/delegate_followup.rs` owns the tool surface. It resolves the target delegation id, derives or validates the recipient, sends a `DelegationIntent` with `followup_of`, and then sends a `ToolUseIntent` that q-tags the emitted followup event.

`crates/tenex-agent/src/tools/delegate_followup_resolution.rs` owns local id resolution. It opens the project `conversation.db`, resolves full ids and 10-character prefixes, reads `conversations.runtime_state_json.rustRuntime.delegation`, and scans conversation messages for prior followup event ids.

`crates/tenex-protocol/src/nostr/encoder.rs` owns the wire shape. A `DelegationRequest` with `followup_of` becomes a kind:1 text event with an `e` root tag to the original delegation id and a `p` tag to the delegatee. A fresh delegation instead omits `e` and carries a `delegation` parent tag.

`crates/tenex-agent/src/hook.rs` treats `delegate_followup` like `delegate` for tool-use publication: the hook releases the runtime driver but does not publish a pre-tool tool-use event. The tool publishes the audit event after it knows the followup event id.

`tenex/src/runtime_cmd/mod.rs` owns runtime routing. It records fresh delegation routes, rejects followups as fresh routes because they have an `e` tag, resolves followup dispatch to the child conversation via the root `e` tag, and routes later child completions back to the parent from the stored route.

## Runtime Flow

1. A parent agent previously called `delegate`, producing a child conversation whose id is the delegation event id. Runtime route registration persisted this mapping under the child conversation:

   ```json
   {
     "rustRuntime": {
       "delegation": {
         "parentAgentPubkey": "...",
         "parentConversationId": "...",
         "parentCompletionRecipientPubkey": "...",
         "childAgentPubkey": "...",
         "childConversationId": "...",
         "delegationEventId": "...",
         "createdAt": 123
       }
     }
   }
   ```

2. The parent agent calls `delegate_followup` with a delegation id and message. The recipient is optional when the local route exists. If the recipient is provided, Rust validates that it matches the original child agent.

3. The resolver canonicalizes the input id. A direct original delegation id resolves from the child conversation row. A 10-character prefix must uniquely match either a child conversation id or a persisted message event id inside a routed child conversation. A previous followup event id resolves by scanning messages and returning the containing child conversation id.

4. The tool builds a `DelegationIntent` with `followup_of: MessageRef::Nostr { event_id: canonical_original_delegation_id }`. The protocol encoder publishes a kind:1 event that p-tags the child agent and roots the event at the original delegation id.

5. The runtime receives the followup because it targets a project agent by p-tag. `register_delegation_route_if_needed()` does nothing: `fresh_delegation_target()` rejects any event with an `e`, `tool`, `status`, `intent`, `reasoning`, or `error` tag. This is the guard that prevents followups from becoming new delegations.

6. `select_dispatch_target()` does not treat the followup as a completion because it lacks `status=completed`. It falls back to ordinary agent selection and `conversation_id_from_event()`. The root `e` tag makes the dispatch key `(child_agent, original_delegation_id)`, so the child agent receives the followup in the same child conversation where the original delegated work is running.

7. `accept_dispatch()` persists the followup message in the child conversation and either queues it behind an active child run or starts a child-agent process immediately. This uses the same driver and queue rules as any other message for the same `(agent, conversation)` pair.

8. The tool also emits a `ToolUseIntent` with `tool_name = "delegate_followup"` and `referenced_messages = [followup_event_id]`. That creates the audit/tool event after the followup event exists, preserving the q-tag correlation.

9. When the child agent later completes, its completion event is rooted at the child conversation and p-tags the parent agent. `delegation_route_for_completion()` reads the stored route from the child conversation, verifies the sender is the child agent and the p-tag includes the parent agent, and returns the parent dispatch target.

10. The parent agent is then spawned or queued with `TENEX_CONVERSATION_ID` set to the parent conversation id and `TENEX_COMPLETION_RECIPIENT_PUBKEY` set from the route. The parent continues in the original parent conversation rather than in the child conversation.

## State And Data

The canonical route is stored once, on the original child conversation row:

`<base_dir>/projects/<dTag>/conversation.db` -> `conversations.runtime_state_json.rustRuntime.delegation`

Followup events are not route records. They are persisted as ordinary messages in the child conversation. This is why `delegate_followup_resolution.rs` can canonicalize a previous followup event id: it scans routed child conversations' `messages.nostr_event_id` values and maps any matching followup message back to that conversation's original route.

The original delegation id remains the canonical id. A followup event id is an alias for lookup and audit correlation, not a new delegation conversation id.

The parent wake-up state is not stored on the followup. The parent wake-up uses the same `DelegationRoute` that was created by the original delegation.

## Contracts And Invariants

A followup must use the original delegation id as the root `e` tag. If it uses `reply`, or points at a later followup event instead of the original delegation root, the runtime may derive the wrong conversation id and the child process will not receive the message in the intended context.

Fresh delegations and followups are distinguished structurally. A fresh delegation is agent-authored, p-tags a project agent, and has no `e` tag. A followup p-tags the project agent and has an `e` root tag. Runtime route creation depends on that distinction.

The stored route's `childAgentPubkey` is the source of truth for recipient inference. If an explicit recipient is provided, it must resolve to the same pubkey or the tool rejects the call.

Followup id prefixes must be unique across routed child conversation ids and message event ids. Ambiguous prefixes fail instead of picking one.

The child completion must still be authored by the recorded child agent and p-tag the recorded parent agent. Followup publication does not loosen completion validation.

## Failure And Recovery

Invalid ids fail before publishing. The Rust resolver accepts only full 64-character hex ids or 10-character hex prefixes.

If no local route can be found, `delegate_followup` can still accept a full original delegation id, but it cannot infer the recipient. In that case the caller must provide an explicit recipient. This matters for cross-project, external, or not-yet-indexed delegations where the local `conversation.db` does not contain the child route.

If a full id is actually a prior followup event id, Rust can canonicalize it only if that followup event has already been persisted in a routed child conversation. Otherwise the id is treated as a canonical id and recipient inference may fail.

If the child agent is currently running, the dispatch coordinator queues the followup for the same `(child_agent, child_conversation)` pair. If the active child run consumes the persisted followup via message injection, runtime cleanup can drop the queued duplicate using the normal consumed-message markers.

If the original route row is missing or malformed, child completion routing cannot wake the parent, even if the followup was delivered. The durable route is therefore more important than any individual followup event.

## Observability

Fresh delegation route creation logs `registered delegation route`; followups should not produce that log. Seeing a route registration for a followup-shaped event means the structural fresh/followup distinction has broken.

Relay-visible followup events should show:

- kind `1`
- pubkey of the parent agent
- `["p", child_agent_pubkey]`
- `["e", original_delegation_event_id, "", "root"]`
- no `["delegation", ...]` tag
- a later `tool=delegate_followup` event with a q-tag/reference to the followup event

Focused tests in the current Rust tree:

- `cargo test -p tenex-protocol delegation_followup_uses_delegation_as_root`
- `cargo test -p tenex-agent resolves_followup_event_id_to_canonical_delegation`
- `cargo test -p tenex delegation_route_maps_child_completion_back_to_parent_context`

The existing runtime probe `bun run scripts/tenex-runtime-probe.ts delegation-basic` verifies the surrounding parent/child completion route but does not yet include a dedicated `delegate_followup` scenario.

## Source Guide

Read `crates/tenex-agent/src/tools/delegate_followup.rs` for the public tool schema, recipient validation, followup emission, and delayed audit event.

Read `crates/tenex-agent/src/tools/delegate_followup_resolution.rs` for canonical id lookup, prefix matching, and prior-followup-id handling.

Read `crates/tenex-protocol/src/nostr/encoder.rs` for the exact Nostr tag distinction between fresh delegation and followup delegation.

Read `tenex/src/runtime_cmd/mod.rs` for fresh route persistence, completion route lookup, p-tag target selection, and `conversation_id_from_event()`.

Read `crates/tenex-conversations/src/store.rs` and `crates/tenex-conversations/src/schema.rs` for the `conversation.db` JSON runtime-state blob and message persistence APIs that make followup id canonicalization possible.

Read `docs/internals/delegation-runtime.md` for the broader delegation model and parent completion behavior.

## Addendum: Differences From The TypeScript Implementation

TypeScript reference consulted: local git object `master` at commit `96f0398dd051c555616473b6f5fb4482ff30ef1f`, inspected with read-only `git show master:<path>`.

The TypeScript tool resolves followup ids through two live sources: `PrefixKVStore` for 10-character prefixes and `RALRegistry` for fallback scans and canonicalization. Rust resolves through the persisted per-project SQLite conversation store. This makes Rust's local route lookup restart-tolerant once the original route and messages are in `conversation.db`, but it lacks TypeScript's NDK fetch fallback for recipient discovery.

TypeScript `AgentPublisher.delegateFollowup()` already used the same wire contract Rust now uses: p-tag the recipient and add `["e", delegationEventId, "", "root"]`. The critical parity rule is that both runtimes treat the original delegation event as the root, not the latest followup event.

TypeScript registers the followup as a pending delegation record with `type: "followup"` and `followupEventId`. `DelegationRegistry` maps both the original delegation id and the followup event id to the same waiting RAL, so a completion that replies only to the followup id can still satisfy the canonical delegation.

Rust does not recreate TypeScript's parent RAL registry for followups. Instead, the original persisted `DelegationRoute` remains the only parent/child map. A followup is delivered to the child conversation, and the eventual child completion routes to the parent through that original route.

TypeScript's `ToolExecutionTracker` delays publishing all delegation-family tool-use events until the produced event ids are known. Rust mirrors this for `delegate_followup` by suppressing the hook's pre-tool tool-use event and letting the tool emit a `ToolUseIntent` with the followup event reference after publication.

The TypeScript path can fall back to fetching the original delegation event from Nostr and reading its `p` tag when local RAL state lacks a recipient. Rust currently requires an explicit recipient when the local persisted route is unavailable.

## Open Questions

There is no dedicated Rust end-to-end runtime probe that performs `delegate`, sends `delegate_followup` while the child is still active, and asserts the child receives both messages in the same child conversation. The unit tests cover the key contracts, and `delegation-basic` covers parent completion routing, but a followup-specific probe would catch process-boundary regressions.

Cross-project followup behavior is not proven by the local Rust source path. The current resolver is local to one project's `conversation.db`, so external followups require explicit recipient input and still depend on relay delivery to the target runtime.
