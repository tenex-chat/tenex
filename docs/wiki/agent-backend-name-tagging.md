---
title: Agent Backend Name Tagging
slug: agent-backend-name-tagging
summary: "Agent kind:0 events include a `[\\\\\\\\\\"backend\\\\\\\\\\", \\\\\\\\\\"<backend-name>\\\\\\\\\\"]` tag when a backend name is configured"
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-04
updated: 2026-05-12
verified: 2026-05-04
compiled-from: conversation
sources:
  - session:d6e1583c-1ca8-42d5-bccd-f5bb51dc1e0f
  - session:2e44c93a-771f-49b7-a4bc-55e2acf55514
  - session:237f2283-8419-4745-b4b4-a4a5925d8099
---

# Agent Backend Name Tagging

## Backend Name Tagging

The agent must publish Nostr kind:0 (metadata/profile) events with a 'backend' tag. Agent kind:0 events include a `["backend", "<backend-name>"]` tag when a backend name is configured. Agent kind:0 events also include a `["use-criteria", "<use-criteria>"]` tag when the agent has non-empty use_criteria. Agent capability announcement events use kind:0 (Kind::Metadata) instead of kind:34011. The backend kind:0 event uses the `backendName` config value as the profile name, falling back to 'TENEX' if not set.

<!-- citations: [^d6e15-1] [^2e44c-1] [^237f2-2] -->
## Backend Name Data Flow

The backend_name is read from config.json's backendName field, threaded through daemon::config::Config → RuntimeShared → publish_one → build_event_for → build_agent_config_event. [^d6e15-2]

## Identity and Schema

IdentityView includes a backend_name field parsed from the `["backend", ...]` tag on kind:0 events. The identity cache schema is migrated to v3 to persist the backend_name field. The Agent struct includes a backend_name: Option<String> field. [^d6e15-3]
## See Also

