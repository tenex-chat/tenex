---
title: Agent Blocked Flag Lifecycle
slug: agent-blocked-flag-lifecycle
summary: When an agent is stopped via a 24134 stop command, the `is_blocked` flag is set to true and persisted to the database
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-11
updated: 2026-05-19
verified: 2026-05-11
compiled-from: conversation
sources:
  - session:192d96b0-1df4-47ac-8b4f-3fb080c9972f
  - session:809fecfb-f84b-4f6b-9ae7-5e04f97173da
---

# Agent Blocked Flag Lifecycle

## Agent Blocked Flag Lifecycle

When an agent is stopped via a 24134 stop command, the `is_blocked` flag is set to true and persisted to the database. Transport dispatch events (local CLI/control socket) always clear the agent's `is_blocked` flag before dispatching. When a whitelisted (trusted) pubkey p-tags a blocked agent in a conversation, the agent's `is_blocked` flag is cleared before dispatching the event. External dispatch events from non-whitelisted authors do not clear the agent's `is_blocked` flag. [^192d9-1]

handle_stop_command must clear or invalidate the rustRuntime.driver record from the conversation store after stopping an agent. A stale driver record causes persisted_driver_busy to return true for up to 10 minutes after an agent is stopped, because the stale record passes the same_agent && same_conversation && !stale check. If a new event arrives before finish_run cleanup completes while a stale driver record exists, active_runs > 0 && driver_busy == true will incorrectly queue the event instead of dispatching it.

<!-- citations: [^192d9-1] [^809fe-1] -->
## See Also

