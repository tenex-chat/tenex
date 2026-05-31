---
title: Agent Active Status Publishing
slug: agent-active-status-publishing
summary: When querying active agent pubkeys for a 24133 status event, the system filters by conversation ID so that agents running in other conversations do not appear a
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-03
updated: 2026-05-12
verified: 2026-05-03
compiled-from: conversation
sources:
  - session:91d7470a-8ed3-4b7a-bb01-10487857ef8f
  - session:aa2d20fb-d49b-45dd-a29a-a82bab36de0e
  - session:237f2283-8419-4745-b4b4-a4a5925d8099
---

# Agent Active Status Publishing

## Active Status Publishing

When querying active agent pubkeys for a 24133 status event, the system filters by conversation ID so that agents running in other conversations do not appear active in the signaled conversation. The `publish_active_status` function logs an info-level message containing the conversation ID and included agent pubkeys when publishing a 24133 cleanup event. The `handle_stop_command` for kind 24134 derives a single canonical conversation ID via `conversation_id_from_event` (root marker → first unmarked `e` → fallback), not by collecting all `e`-tag values. Its precheck for missing target tags tests whether any `e`-tag exists at all, rather than conflating tag count with content. The `set_agent_blocked` function calls `store.ensure_conversation(conversation_id)` before upserting the `agent_context_state` row. The `e_tag_event_ids` helper has been removed entirely with no comment or shim left behind.

Agents with `history.messages=0` are legitimate fresh sessions (not a bug), started with no prior Nostr conversation events to load. [^237f2-1]

<!-- citations: [^91d74-1] [^aa2d2-1] -->
## See Also

