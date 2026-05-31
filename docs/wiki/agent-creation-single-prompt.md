---
title: Agent Creation Single-Prompt Wizard
slug: agent-creation-single-prompt
summary: Agent creation uses a single description prompt that the LLM fills with name, slug, role, description, use_criteria, category, and system prompt, rather than a
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-01
updated: 2026-05-09
verified: 2026-05-01
compiled-from: conversation
sources:
  - session:2bc3a90c-4eb3-4857-a727-712e810a532e
  - session:30876dd8-e23a-48de-b3d5-a31af9f23882
---

# Agent Creation Single-Prompt Wizard

## Single-Prompt Agent Creation

Agent creation uses a single description prompt that the LLM fills with name, slug, role, description, use_criteria, category, and system prompt, rather than a multi-step field-by-field wizard. The supervision LLM role is used automatically without requiring the user to select a role. When a supervision LLM is configured, the description prompt displays a hint that pressing Esc allows manual field entry; pressing Esc at this prompt falls through to a manual field-entry flow. When no supervision LLM is configured, agent creation jumps directly to the manual field-entry flow. After LLM generation, the user reviews the results via a summary display and a system prompt editor before proceeding to model configuration and project selection. Both the LLM-generated and manual entry paths converge into a shared downstream pipeline that validates slug uniqueness, opens the editor, sets the model, assigns projects, confirms, and saves.

<!-- citations: [^2bc3a-1] [^30876-1] -->
## Slug Generation and Conflict Resolution

The LLM-generated slug is normalized through slug_from_name to handle invalid characters like uppercase and spaces. Slug conflicts are resolved by appending a numeric suffix such as -2 or -3. [^2bc3a-2]

## Error Handling and Fallbacks

If the LLM returns invalid JSON or is missing required fields, the system returns an error rather than proceeding. If the LLM generates an unknown agent category, the system treats it as None rather than failing. If the supervision model is missing, the command displays a hint and exits gracefully rather than falling back to the old wizard. Pressing Esc on any manual field prompt aborts the agent creation process.

<!-- citations: [^2bc3a-3] [^30876-2] -->

## Navigation and Entry Point

The agent manager menu includes a 'Create new agent' action bound to the 'c' key. [^30876-3]

## Manual Field Entry

The editor label displays 'System prompt' when the buffer starts empty (manual mode) and 'Review system prompt' when prefilled (LLM mode). The create_prompts module provides prompt_required_with_default, prompt_optional, and prompt_category helpers for manual field entry. [^30876-4]
## See Also

