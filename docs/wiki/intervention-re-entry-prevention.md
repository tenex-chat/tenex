---
title: Intervention Re-entry Prevention
slug: intervention-re-entry-prevention
summary: Conversation interventions do not trigger further conversation interventions in a loop
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-01
updated: 2026-05-01
verified: 2026-05-01
compiled-from: conversation
sources:
  - session:ef718c1f-8ef0-4f58-bd04-f2ef2584461b
---

# Intervention Re-entry Prevention

## Intervention Re-Entry Prevention

Conversation interventions do not trigger further conversation interventions in a loop. The completion handler skips processing when the completing agent is the intervention agent, preventing re-entry. The publish_review_request function p-tags the intervention agent's pubkey rather than the user pubkey, preventing the review-request event from re-entering the pipeline. A notified dedup map with a TTL prevents the same conversation from triggering an intervention twice within the TTL window. [^ef718-2]

## See Also

