---
name: Task Scheduling
description: Schedule recurring and one-off tasks
tools:
  - schedule_task
---

# Task Scheduling

This skill provides the `schedule_task` tool for creating recurring or one-off scheduled tasks.

## Parameters

- **`prompt`** — The prompt to execute when the task runs.
- **`when`** — When to execute. Accepts a cron expression (e.g. `0 9 * * *` for daily at 9am) or a relative delay (e.g. `5m`, `2h`, `1d`).
- **`title`** _(optional)_ — A human-readable label for the task.
- **`targetAgent`** _(optional)_ — Agent slug to run the task. Defaults to self.
- **`targetChannel`** _(optional)_ — A conversation ID, Telegram channel, or other channel identifier where the task's output should be sent when it runs.

## Scheduling follow-ups within existing conversations

Use `targetChannel` to schedule a delayed action that continues inside the current conversation rather than opening a new one. This is useful when you only need to perform something at a specific future time — such as a reminder, a status check, or a deferred response — without fragmenting context across separate conversation threads.

Example: if an agent is mid-conversation and wants to circle back in 30 minutes, it can call `schedule_task` with `when: "30m"` and `targetChannel` set to the current conversation ID. When the task fires, the output is routed back into that same conversation.
