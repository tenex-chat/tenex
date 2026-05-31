---
title: E2E Probe Validation
slug: e2e-probe-validation
summary: Any issue implementation MUST be validated by the e2e probe before landing.
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-30
updated: 2026-05-12
verified: 2026-05-30
compiled-from: conversation
sources:
  - session:c58ee191-f12e-42b3-a15f-43a0755ef5b7
  - session:e2340782-925b-416b-9438-a4fbcbe6e154
---

# E2E Probe Validation

## E2E Probe Validation Requirement

Any issue implementation MUST be validated by the e2e probe before landing. The e2e probe scenarios `file-modification-tracking` and `hooks-pre-tool` must both pass with 4/4 verdicts before landing.

Any issue implementation MUST be validated by the e2e probe before landing. The e2e probe scenarios `file-modification-tracking` and `hooks-pre-tool` must both pass with 4/4 verdicts before landing. The `delegation-basic` e2e probe fails 10/12 verdicts on master baseline, unrelated to the routing change. [^e2340-2]

<!-- citations: [^c58ee-1] [^c58ee-11] -->
## File System Implementation Detail

Path resolution and environment variable expansion are handled by `pub(crate)` functions `resolve_path` and `expand_env_vars` in `tools/fs.rs`, imported by `file_modifications.rs` rather than duplicated. [^c58ee-2]

## Error Reporting Requirements

DB errors encountered during `render_reminder` must be logged via `tracing::warn!` instead of silently returning `None`. [^c58ee-3]

## File Modification Reporting Requirements

Unreadable or deleted files encountered during `render_file_block` must be reported as modifications rather than silently skipped. [^c58ee-4]

## Doc Comment Style Requirement

Multi-paragraph doc comments must comply with the style guidelines specified in `CLAUDE.md`. [^c58ee-5]

## Pull Request Description Requirement

The pull request description must accurately reflect the implementation details. [^c58ee-6]

## Process Management Requirements

Orphaned child processes resulting from hook timeouts must be prevented by using `kill_on_drop(true)` on the spawned `Command`. [^c58ee-7]

## Pre-Tool Hook Failure Handling

Pre-tool hook spawn failures must block the tool call instead of silently continuing. [^c58ee-8]

## Record Access Pattern Requirement

The `records_before` index must be replaced with `records.last_mut()` for accessing the last element. [^c58ee-9]
## See Also

