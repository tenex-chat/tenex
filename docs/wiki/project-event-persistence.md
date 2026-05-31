---
title: Project Event Persistence
slug: project-event-persistence
summary: When a project is discovered via a 31933 event, handle_project persists the event to disk at ~/.tenex/projects/<d_tag>/event.json so the runtime can find it at
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-03
updated: 2026-05-15
verified: 2026-05-03
compiled-from: conversation
sources:
  - session:2f8d7bc1-7b78-4167-98eb-7a6f581196d6
  - session:2bb7b8ee-5386-4998-b3d1-e8842f41e901
  - session:1b06fb1c-76a7-4640-8f80-f96a117df221
  - session:36d46279-0e9e-4aa1-a567-0f80701db14c
  - session:e59600bd-f909-405a-872b-34799e400297
  - session:7a333250-a22a-4b6f-b358-af6a8cd99f74
  - session:5e917ebf-3e5f-41b1-a797-ce5c77ac2a6b
  - session:3a9b289d-ae0a-43b5-971b-cbbe6bd1d290
---

# Project Event Persistence

## Project Event Persistence

The daemon maintains an always-on subscription for kind 31933 events from whitelisted authors, filtered by the user's whitelisted pubkeys from config. This subscription omits the `since` timestamp so the relay returns the latest replaceable event per d-tag on connect, and it runs for the lifetime of the daemon process to drive project discovery. When a project is discovered via a 31933 event, handle_project persists the event to disk at ~/.tenex/projects/<d_tag>/event.json so the runtime can find it at startup. event.json is written only by handle_project() when a kind:31933 event for that d_tag arrives from a relay; the runtime never fetches or writes it. The runtime subcommand does not initialize a project on boot — it assumes initialization already happened and bails if required state files are missing. Specifically, project boot reads event.json via project.metadata() and bails with 'project has no event.json — has it been received from a relay?' if missing. The tenex runtime creates the project working directory lazily on spawn via std::fs::create_dir_all, which only creates the empty working-tree directory; it does not clone, scaffold, or fetch agents. Persistence to event.json runs before the per-session inserted dedupe check, so republished events with a newer created_at always overwrite the file. The duplicate current user event bug is fixed by excluding the triggering Nostr event from projected history before sending it as a live prompt. The project registry Upsert compares created_at timestamps and refuses to replace a newer 31933 with an older one, preventing stale sync data from clobbering current state. NIP-9 deletion of a kind 31933 event removes the corresponding entry from the project registry. The project loads MCP server configuration from `.mcp.json` in the project root directory.

<!-- citations: [^2f8d7-8] [^2bb7b-3] [^1b06f-6] [^36d46-2] [^e5960-1] [^7a333-4] [^5e917-2] [^3a9b2-2] -->
## See Also

