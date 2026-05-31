---
title: Shell Tool Timeout
slug: shell-tool-timeout
summary: The shell tool has a default timeout of 30 seconds (max 600 seconds), configurable via an explicit timeout argument
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-05
updated: 2026-05-05
verified: 2026-05-05
compiled-from: conversation
sources:
  - session:ec8c4859-ac31-4f72-ad1d-c99f67c86154
---

# Shell Tool Timeout

## Shell Tool Timeout

The shell tool has a default timeout of 30 seconds (max 600 seconds), configurable via an explicit timeout argument. Shell tool timeout errors must surface a descriptive message: "Command timed out after {N}s (default: 30s, max: 600s — pass a longer 'timeout' argument if needed)" instead of the opaque "Process killed by SIG15" / SIGTERM message. The implementation lives in control_shell.rs, tracking whether the exit was due to timeout and formatting it in format_shell_output. [^ec8c4-1]

## See Also

