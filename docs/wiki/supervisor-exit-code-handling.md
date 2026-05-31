---
title: Supervisor Exit Code Handling
slug: supervisor-exit-code-handling
summary: The supervisor treats exit code 0 as a clean exit that should not trigger a restart, rather than restarting all exited services identically.
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-03
updated: 2026-05-03
verified: 2026-05-03
compiled-from: conversation
sources:
  - session:2f8d7bc1-7b78-4167-98eb-7a6f581196d6
---

# Supervisor Exit Code Handling

## Exit Code Handling

The supervisor treats exit code 0 as a clean exit that should not trigger a restart, rather than restarting all exited services identically. [^2f8d7-9]

## See Also

