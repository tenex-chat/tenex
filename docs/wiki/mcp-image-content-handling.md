---
title: MCP Image Content Handling
slug: mcp-image-content-handling
summary: "MCP tool results containing images must be emitted as structured image content blocks (rig's JSON image protocol) rather than stringified base64 text (`data:ima"
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-14
updated: 2026-05-14
verified: 2026-05-14
compiled-from: conversation
sources:
  - session:b6a248fc-4fb1-42d7-85e6-bcab91d3e6be
---

# MCP Image Content Handling

## Image Content Block Handling

MCP tool results containing images must be emitted as structured image content blocks (rig's JSON image protocol) rather than stringified base64 text (`data:image/png;base64,...`). [^b6a24-2]


For models without vision capability, McpProxyTool must replace image content blocks with a textual placeholder like `[image omitted: N bytes, <mime> — model has no vision capability]` so base64 bytes never enter the rig chat-history buffer. [^b6a24-3]

McpProxyTool must accept an `image_support: bool` constructor argument that gates whether image content blocks are passed through or downgraded to text placeholders. [^b6a24-4]

## Vision Capability Detection

ModelProfile.image_support must be populated from a model-capabilities lookup rather than hardcoded to `false`. [^b6a24-5]

The models.dev cache parser must include a `modalities` field (`{ input: Vec<String>, output: Vec<String> }`) on ModelsDevModel, defaulting to `None` for older cache files. [^b6a24-6]

A `detect_image_support(base_dir, provider, model)` helper must read the models-dev cache and resolve vision capability, returning `false` conservatively on cache miss or error. [^b6a24-7]

## Ollama Tag Resolution Edge Case

The existing ollama model tag `qwen3.5:397b-cloud` does not resolve to the models.dev entry for `qwen3.5-397b-a17b`, so detect_image_support returns false for it; vision requires either an explicit `image_support: true` override in llms.json or an ollama-tag-to-upstream-model alias table. [^b6a24-8]
## See Also

