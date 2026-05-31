---
title: Progress Monitor
slug: progress-monitor
summary: A ProgressMonitor periodically samples the agent's recent tool calls and asks an LLM whether the agent is making progress or is stuck
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-19
updated: 2026-05-19
verified: 2026-05-19
compiled-from: conversation
sources:
  - session:c4218724-1fde-432e-b6b4-9c84e86e7c57
---

# Progress Monitor

## Progress Monitor

A ProgressMonitor periodically samples the agent's recent tool calls and asks an LLM whether the agent is making progress or is stuck. The implementation lives in crates/tenex-agent/src/progress_monitor.rs. [^c4218-1]

## See Also

