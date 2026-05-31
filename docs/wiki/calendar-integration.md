---
title: Calendar Integration
slug: calendar-integration
summary: "Calendar integration provides two independently toggleable settings: 'Show calendar events' (read) and 'Sync tasks to Calendar' (write)"
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-06
updated: 2026-05-06
verified: 2026-05-06
compiled-from: conversation
sources:
  - session:c6a12a66-56f2-49b4-9910-b669544fe250
---

# Calendar Integration

## Settings & Permissions

Calendar integration provides two independently toggleable settings: 'Show calendar events' (read) and 'Sync tasks to Calendar' (write). Toggling either setting immediately triggers the EventKit permission prompt; denial springs the toggle back off with an inline 'Open Settings' link (no modal, no nag). [^c6a12-1]


## Read Integration

Calendar integration reads existing events live from Apple Calendar via EventKit each time a day is viewed — events are display-only overlays, never imported as app items. [^c6a12-2]

## Today View Display

In the Today view, Apple Calendar events interleave inline with tasks sorted by time, displayed as demoted half-height rows with a colored 2pt left stripe and no checkbox; all-day events collapse to a single pill at the top; tapping an event opens a detail sheet with an 'Open in Calendar' deep link. [^c6a12-3]

## Week View Display

In the Week view, calendar events render as thin 4pt tinted ribbons behind day cells, positioned proportionally on a 6am–11pm scale. [^c6a12-4]

## Write Sync

Calendar write sync creates a dedicated 'Rocking Life' calendar; only timed tasks (those with startsAt set) are pushed with a 25-minute default duration; auto-syncs on any task mutation; completing a task deletes its calendar event; toggling write off triggers a confirmation alert then deletes all events and the calendar. [^c6a12-5]
## See Also

