---
title: Project Event Backfill
slug: project-event-backfill
summary: "When a project runtime boots up, it backfills kind:1 Nostr events that were published while the daemon was offline (events the project has not yet seen)"
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-06
updated: 2026-05-20
verified: 2026-05-06
compiled-from: conversation
sources:
  - session:4eed3414-ce4c-4e24-9130-c5a20a7697fd
  - session:78412668-e590-4838-a9d6-3b4cb9877eb2
---

# Project Event Backfill

## Project Event Backfill

When a project runtime boots up, it backfills kind:1 Nostr events that were published while the daemon was offline (events the project has not yet seen). backfill_missed_events is called from run() after startup_publish_missing_agent_configs.

The backfill window is bounded by since: last_seen_event_timestamp and until: startup_ts to avoid overlapping with the live subscription.

The backfill fetches both project-scoped (#a tag) and directed (#p tag) kind:1 filter shapes in separate fetch_events calls, then deduplicates by event ID.

Already-processed backfill events are seeded into the in-memory seen set to prevent re-dispatch from the live subscription; new events go through handle_relay_event in chronological order.

ConversationStore provides last_seen_event_timestamp() returning the maximum timestamp of messages with a nostr_event_id, used as the lower bound of the backfill window.

ConversationStore provides has_seen_event(event_id) to check whether a relay event was already processed in a prior session, preventing re-dispatch during backfill.

accept_dispatch is not idempotent and will queue a new agent run even if the event was already processed in a prior session, which is why has_seen_event checks are required before dispatching backfill events.

The daemon's boot-trigger subscription intentionally uses since: startup_ts to avoid replaying historical kind:1/24000 events and warm-booting the entire fleet. The project runtime's live subscription also uses since: Timestamp::now() at boot, meaning it only receives events published after startup.

The tenex doctor conversations backfill subcommand fetches and ingests historical kind:1 Nostr events for a project. It accepts a --since <UNIX_TIMESTAMP> argument that defaults to 30 days ago, overriding the store's anchor point for the offline window. The command filters events by #a = 31933:<owner>:<d-tag> (the project's Nostr coordinate), skips events already present in the store via has_seen_event (making it idempotent), and is safe to run concurrently with the daemon because both use SQLite WAL mode with busy_timeout to serialize writes. The command paginates through relay responses to fetch all events beyond the initial cap of 100 and prints a count of ingested vs already-present events upon completion.

Backfilled conversations appear in conversation_list with correct last_activity timestamps and message previews derived from the event's timestamp and content. They do not have a title set and display as '(untitled)' because title assignment is handled by the agent's summarization logic rather than raw event ingestion.

<!-- citations: [^4eed3-1] [^4eed3-2] [^4eed3-3] [^4eed3-4] [^4eed3-5] [^4eed3-6] [^4eed3-7] [^4eed3-8] [^78412-1] -->
## See Also

