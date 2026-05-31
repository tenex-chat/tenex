---
title: Relay Access Control
slug: relay-access-control
summary: The relay access control hierarchy grants always-trusted operator status to admin_pubkeys from config, allows REQ access for any pubkey listed as a p-tag in a u
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-04
updated: 2026-05-04
verified: 2026-05-04
compiled-from: conversation
sources:
  - session:1e7fc0ce-59a5-41fc-b799-6beac6934b16
  - session:f10c5a61-5a43-4c9f-b8f9-90996206b692
  - session:36d46279-0e9e-4aa1-a567-0f80701db14c
  - session:68bc5ef2-6c87-41bf-9b5e-efb393e968c4
---

# Relay Access Control

## Relay Access Control

The relay access control system uses a two-layer model. Layer 1 (backend whitelist) is sourced exclusively from p-tags in kind 14199 events, populated at startup and updated live via OnEventSavedHook. Layer 2 (project registry) is sourced from kind 31933 events and governs event-by-event delivery via CanDeliver for authenticated, non-backend-whitelisted viewers. Filters that exclusively target kind:0 bypass the NIP-42 auth requirement, while all other REQs still require auth. A viewer always receives their own events regardless of other access rules (event.PubKey == viewer). Note: config.AdminPubkeys and ~/.tenex/daemon/whitelist.txt are not used as sources for relay access control. (Previously: admin_pubkeys from config and whitelist.txt were used.)

<!-- citations: [^f10c5-3] [^36d46-3] [^36d46-4] [^1e7fc-5] [^f10c5-2] [^68bc5-1] -->
## See Also

