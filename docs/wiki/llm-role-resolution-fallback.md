---
title: LLM Role Resolution and Default Fallback
slug: llm-role-resolution-fallback
summary: Unset LLM roles (e.g
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-04
updated: 2026-05-04
verified: 2026-05-04
compiled-from: conversation
sources:
  - session:17cf84d1-42a5-4825-ae20-27ec39aeccac
---

# LLM Role Resolution and Default Fallback

## Role Resolution & Default Fallback

Unset LLM roles (e.g. supervision) must resolve to the default role rather than producing an error, consolidating the fallback logic into a single canonical helper. The `ConfigStore::resolve_role_or_default(role, key_health)` helper in `tenex-llm-config` provides this logic: it falls back to the default role when the requested role is unset, and errors only when neither the requested role nor a default is configured. [^17cf8-1]


Callers delegate to `resolve_role_or_default` rather than implementing their own inline fallback: `ResolvedModel::resolve_role` in `tenex-agent/src/config.rs`, `LlmSelection::resolve` in `tenex-summarizer/src/config.rs`, and `resolve_role_model` in `tenex/src/agent_cmd/create_llm.rs` (which fixes the agent create failure when supervision is unset). [^17cf8-2]

The firewall crate (`tenex-firewall`) intentionally uses strict `resolve_role` with no default fallback, so a missing firewall role causes the feature to fail closed. [^17cf8-3]

The role-assignment TUI menu displays fallback-to-default values for unset roles, but those fallbacks are only persisted to `llms.json` if the user selects Done to exit the menu. [^17cf8-4]
## See Also

