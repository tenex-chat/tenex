---
title: Daemon Heartbeat Publishing
slug: daemon-heartbeat-publishing
summary: "The daemon publishes kind:24012 backend heartbeat events every 30 seconds, alongside the existing kind:24011 inventory publishes"
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-03
updated: 2026-05-05
verified: 2026-05-03
compiled-from: conversation
sources:
  - session:2bb7b8ee-5386-4998-b3d1-e8842f41e901
  - session:2e44c93a-771f-49b7-a4bc-55e2acf55514
---

# Daemon Heartbeat Publishing

## Heartbeat Publishing

The daemon publishes kind:24012 backend heartbeat events every 30 seconds, alongside the existing kind:24011 inventory publishes. Kind:24012 heartbeat events contain empty content and one ["p", <pubkey>] tag per whitelisted owner, signed by the backend signer. [^2bb7b-1]



The backend publishes its own kind:0 event upon startup. [^2e44c-2]

The backend profile publish is spawned at daemon startup, before the existing agent profile republish. [^2e44c-3]

The backend profile publish uses the same connect-publish-disconnect pattern as the backend heartbeat. [^2e44c-4]
## Protocol Constants

The BACKEND_HEARTBEAT constant with value 24012 is defined in the canonical kinds list in crates/tenex-protocol/src/nostr/kinds.rs. [^2bb7b-2]
## See Also

