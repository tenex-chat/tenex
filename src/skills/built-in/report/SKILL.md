---
name: report
description: Publish NIP-23 Long-form Articles (kind 30023) to Nostr, signed by this agent
tools:
  - report_publish
---

# Report Publishing

This skill provides a tool for publishing NIP-23 Long-form Articles (kind 30023) to Nostr.
Articles are signed using this agent's own keys and reference the current project.

## Tool: `report_publish`

Publish a markdown file or directory of markdown files as Nostr long-form articles.

- **Single file**: publishes one article; the filename becomes the article identifier
- **Directory**: recursively publishes all files; each file is identified by its relative path within the directory

Each published event includes an `a` tag referencing the kind:31933 project this agent belongs to.
