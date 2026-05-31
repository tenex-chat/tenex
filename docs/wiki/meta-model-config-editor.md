---
title: Meta Model Config Editor
slug: meta-model-config-editor
summary: Pressing Enter on a meta model in the `tenex config llm` list opens an editor for that model
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-12
updated: 2026-05-12
verified: 2026-05-12
compiled-from: conversation
sources:
  - session:8d450f52-4921-4dc8-9094-012238b3e31f
---

# Meta Model Config Editor

## Enter Key Behavior

Pressing Enter on a meta model in the `tenex config llm` list opens an editor for that model. Standard configs keep the existing silent re-render behavior when Enter is pressed. [^8d450-1]


## Routing and Shared Logic

`llm_editor.rs::route()` branches on whether the config is meta or standard, routing meta configs to `add_multi_modal::edit()`. The variant loop logic is extracted into a shared `run_variant_loop()` helper called by both `run()` (create) and `edit()`. [^8d450-2]

## Edit Initialization and Persistence

The `add_multi_modal::edit()` function pre-populates `VariantListState` from the existing on-disk config before running the variant loop. On completion of meta model editing, changes are saved using `set_meta_config`. [^8d450-3]

## Production Types

`MetaVariantEntry`, `LlmConfigEntry::variant()`, and `LlmConfigEntry::meta_default_variant()` are available in production code (not gated behind `#[cfg(test)]`). [^8d450-4]
## See Also

