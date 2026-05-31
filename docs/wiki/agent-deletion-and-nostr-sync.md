---
title: Agent Deletion and Nostr Sync
slug: agent-deletion-and-nostr-sync
summary: Local agent deletion never requires an nsec prompt; `ensure_owner_signer` is not called before delete actions.
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-01
updated: 2026-05-03
verified: 2026-05-01
compiled-from: conversation
sources:
  - session:864db20e-5425-4440-8ff6-dcce7a98f64b
  - session:2f8d7bc1-7b78-4167-98eb-7a6f581196d6
---

# Agent Deletion and Nostr Sync

## Local Deletion

Local agent deletion never requires an nsec prompt; `ensure_owner_signer` is not called before delete actions. [^864db-1]


`confirm_and_delete` and `bulk_delete_agents` take `Option<&Keys>` so that Nostr membership sync is silently skipped when keys are absent, leaving the kind:31933 relay copy unchanged. [^864db-2]

If owner keys are already cached in the session from a prior action, they are used for the post-delete Nostr sync; otherwise the sync is skipped. [^864db-3]

## Error Reporting

When an agent exits with a non-zero code, the runtime publishes a kind:1 Nostr reply event containing the error, signed with the backend key and tagged with the triggering event ID and user pubkey. [^2f8d7-1]
## See Also

