---
title: Agent Locality and Signer
slug: agent-locality-and-signer
summary: An agent's locality is determined by whether its pubkey has a corresponding local JSON file with a `signer_ref` (nsec) on the backend.
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-04
updated: 2026-05-15
verified: 2026-05-04
compiled-from: conversation
sources:
  - session:0149dc43-0d5b-44fd-b432-426c3cbf45cf
  - session:232a6bfd-c4b7-476a-a178-d2194499486f
  - session:a61812a6-e975-45fd-aec7-744c41d8b722
  - session:3a9b289d-ae0a-43b5-971b-cbbe6bd1d290
---

# Agent Locality and Signer

## Agent Locality

An agent's locality is determined by whether its pubkey has a corresponding local JSON file with a `signer_ref` (nsec) on the backend. The `agent_pubkey_from_path` function validates that the filename stem is exactly a 64-character lowercase hex string before treating it as a pubkey; files with non-pubkey filename stems (e.g. `index.json`) are silently ignored at the path-parsing stage rather than triggering a publish warning. When no signer is configured, the agent creation flow skips the project prompt entirely and creates a local-only agent without publishing a kind:31933 event. The identity service cache (schema v2) stores `slug` and `use_criteria` columns extracted from kind:0 event tags via a `first_tag_value(event, name)` helper.

Project boot reads agent JSON files from `<base_dir>/agents/<pubkey>.json` and bails with 'project has no agents' if none exist for the project's p-tag members. Agent JSON files under `<base_dir>/agents/<pubkey>.json` come from the onboarding flow (tenex/src/onboard/) or out-of-band publication, not from the runtime. [^3a9b2-1]

<!-- citations: [^0149d-1] [^0149d-2] [^232a6-1] [^a6181-1] -->
## Signer-Dependent UI Behavior

When TENEX_NSEC (a signer) is not available, the 'Assign to projects' option is not presented. In the agent-detail manager actions menu, the 'Assign to projects' choice is also hidden when owner_keys is None. [^232a6-2]
## See Also

