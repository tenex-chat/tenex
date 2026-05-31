---
title: Project Access and NIP-29 Groups
slug: project-access-nip29-groups
summary: The project access model uses NIP-29 groups instead of custom p-tag ACL scraping
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-04
updated: 2026-05-04
verified: 2026-05-04
compiled-from: conversation
sources:
  - session:1e7fc0ce-59a5-41fc-b799-6beac6934b16
  - session:f10c5a61-5a43-4c9f-b8f9-90996206b692
  - session:36d46279-0e9e-4aa1-a567-0f80701db14c
  - session:0149dc43-0d5b-44fd-b432-426c3cbf45cf
---

# Project Access and NIP-29 Groups

## NIP-29 Group-Based Access Model

The project access model uses NIP-29 groups instead of custom p-tag ACL scraping. Projects are represented as NIP-29 groups identified by an h-tag instead of an a-tag. [^1e7fc-1]



`Project::all_project_agents()` returns every member from the 31933 p-tags, with local members having full metadata and remote members represented as stubs with `is_local = false`. `Project::agents()` retains its original local-only semantics for daemon-side code that needs to spawn or sign-as agents. [^0149d-6]
## Access Modes

Projects can have one of four access modes:

- **Public-open:** Anyone can read and anyone can join.
- **Public-closed:** Anyone can read, but joining requires admin approval.
- **Private-open:** Reading is restricted to members only, but anyone can request to join.
- **Private-closed:** Both reading and writing are restricted to members only, with membership controlled by admins. [^1e7fc-2]

## Enforcement and Discovery

When booting a project, the daemon publishes kind 9000 events to add agent pubkeys to the NIP-29 group. Clients subscribe using an h-tag filter combined with NIP-42 authentication. Group metadata via kind 39000 is publicly discoverable regardless of the project's access mode.

Private projects are identified by a `["scope", "private"]` tag on kind 31933 events. Querying 31933 events returns private events only if the requesting user is the author of or p-tagged in that 31933; all non-private 31933 events are visible. Querying by #a-tag on a private project returns only events published by the requester unless the requester is p-tagged in the project's 31933, in which case they see all events in that project. Any user can publish events a-tagging any project regardless of its privacy status.

For all events beyond kind 31933, if the event carries any a-tag pointing to a known private project, the viewer must be a member of every such project; events with no private-project a-tags are visible to all authenticated viewers. Events with multiple a-tags to mixed public and private projects are visible only if the viewer has access to every private a-tag referenced. A viewer can see any event whose e-tag references an event authored by the viewer, even inside a private project they do not belong to.

Active non-backend subscriptions are tracked and removed automatically when their context completes, enabling replay of newly visible events upon ACL changes. When a user is added as a member to a private project mid-session, their open subscriptions backfill the project's events they previously could not see.

The live broadcast PreventBroadcastHook enforces the e-tag-own-events rule, allowing non-members to receive live replies or reposts to events they authored within a private project. The e-tag ownership broadcast check queries BadgerDB for referenced event IDs and verifies authorship in-process, with a 2-second timeout cap.

<!-- citations: [^1e7fc-3] [^f10c5-1] [^36d46-1] -->
## Transition from Legacy ACL Model

The NIP-29 transition replaces kind 31933 with kind 39000, a-tags with h-tags, and p-tag scraping with native group enforcement. The fiatjaf croissant relay is the target relay implementation for NIP-29 group handling. [^1e7fc-4]
## See Also

