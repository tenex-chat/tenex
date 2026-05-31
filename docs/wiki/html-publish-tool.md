---
title: HTML Publish Tool
slug: html-publish-tool
summary: The html_publish tool uploads HTML files or directories to a Blossom server
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-03
updated: 2026-05-06
verified: 2026-05-03
compiled-from: conversation
sources:
  - session:390d9f35-62c6-42aa-b14d-37c918dcd55b
  - session:7d47dcce-8af6-472b-a828-7cd72893d5ad
---

# HTML Publish Tool

## Overview

The html_publish tool uploads HTML files or directories to a Blossom server. Directories are zipped into a single zip file (which must contain an index.html at the archive root) and then uploaded, while single HTML files are uploaded directly. The Blossom server URL is read from config.json's `blossomServerUrl` field, defaulting to `https://blossom.primal.net`. The upload uses the BUD-02 protocol with a kind:24242 authorization event signed by the agent's keys. [^390d9-1]



The html_publish and report_publish tools are unconditionally available to all agent categories. The html_publish tool uploads HTML files or directories to a Blossom server. Directories are zipped into a single zip file (which must contain an index.html at the archive root) and then uploaded, while single HTML files are uploaded directly. The Blossom server URL is read from config.json's `blossomServerUrl` field, defaulting to `https://blossom.primal.net`. The upload uses the BUD-02 protocol with a kind:24242 authorization event signed by the agent's keys. [^7d47d-1]
## Invocation

The html_publish tool is called with `title`, `description`, and `path` arguments. The `path` argument supports `$VAR` and `${VAR}` environment variable expansion. [^390d9-2]

## ToolUse Event

The kind:1 ToolUse event for html_publish includes the following extra tags: `["url", uploaded-url]`, `["t", "html-report"]`, `["title", args.title]`, and `["m", content_type]`. The event's `content` field is set to `args.description`. Internally, `ToolUseIntent` has an `extra_tags: Vec<Vec<String>>` field that all existing call sites pass as `vec![]` by default, and the encoder emits those tags verbatim into the kind:1 event. [^390d9-3]

## Relative Links in Multi-File Bundles

The SKILL.md for html_publish documents that relative links work in multi-file bundles. Examples include relative references for links, stylesheets, scripts, and images. [^390d9-4]
## See Also

