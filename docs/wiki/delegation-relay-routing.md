---
title: Delegation Relay Routing
slug: delegation-relay-routing
summary: "Every delegation (delegate, delegate_crossproject, self_delegate) publishes to the relay and is received as a fresh RelayPoolNotification::Event; no in-process"
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-03
updated: 2026-05-12
verified: 2026-05-03
compiled-from: conversation
sources:
  - session:2335732d-023c-41c6-a0aa-c80a2cb164d5
  - session:0149dc43-0d5b-44fd-b432-426c3cbf45cf
  - session:0248a7ad-9abc-45ed-adce-658337e4591a
  - session:e2340782-925b-416b-9438-a4fbcbe6e154
---

# Delegation Relay Routing

## Delegation Routing

Every delegation (delegate, delegate_crossproject, self_delegate) publishes to the relay and is received as a fresh RelayPoolNotification::Event; no in-process fast-path exists. When a delegation originates from a remote agent, the daemon spawns the agent subprocess with the `TENEX_TRIGGER_FROM_REMOTE_AGENT=1` environment variable. The self_delegate tool (along with delegate_crossproject and delegate_followup) is only available to agents where allows_delegation is true. Agents with the principal, orchestrator, reviewer, or generalist category can use the self_delegate tool, while agents with the worker or domain-expert category cannot. Agents with no category set default to allows_delegation = true. When a delegated child agent replies in the delegation conversation and p-tags the parent agent, the daemon resumes the parent agent in the parent conversation — no `status: completed` tag required. Delegation routing uses a triple-identity check: (1) a delegation route exists for the conversation, (2) the event author matches the registered child agent pubkey, and (3) the parent agent pubkey appears in the event's p-tags. Every reply from the delegated child that p-tags the parent returns control to the parent conversation, meaning delegation is a call/return model — the parent must re-delegate if it needs further back-and-forth with the child. The `delegation_route_for_completion` function is renamed to `delegation_route_for_child_reply` and no longer gates on `is_completion_event`. The `is_completion_event` function and its `has_tag` helper are deleted as dead code from `event_routing.rs`. The `status: completed` tag is retained on `Intent::Completion` and `Intent::Error` for telemetry, telegram forwarder, decoder, and probe consumption — only its use as a routing gate is removed. A pre-existing persistence ordering bug exists for `is_external` + `routeUnauthorizedAuthors=true` child agents sending untagged replies; this is tracked separately rather than fixed in the routing change.

<!-- citations: [^23357-1] [^0149d-5] [^0248a-1] [^e2340-1] -->
## See Also

