---
title: Project Status 24010 Event
slug: project-status-24010
summary: The daemon subscribes to kind 24010 events that p-tag any whitelisted user
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-06
updated: 2026-05-06
verified: 2026-05-06
compiled-from: conversation
sources:
  - session:5ba0d35a-dd66-4d5c-95a3-8bfdcd536e4f
---

# Project Status 24010 Event

## Event Subscription and Structure

The daemon subscribes to kind 24010 events that p-tag any whitelisted user. 24010 events include agent tags of the form ["agent", <pubkey>, <slug>] for each running agent, emitted between p-tags and skill tags. [^5ba0d-1]


## Auto-Boot Policy

When a backend receives a 24010 event for a project from another backend, it automatically boots up that project only if it has local signable agents with zero overlap against the remote backend's running agent set. If there is any overlap between local agents and agents already announced in the remote backend's 24010 event, the project must NOT be auto-booted. [^5ba0d-2]

## Deduplication and Self-Event Handling

The daemon deduplicates 24010 project status evaluations using a remote_status_seen set so that the same event does not trigger re-evaluation every 30 seconds. The daemon skips processing of its own 24010 events. [^5ba0d-3]

## Live Agent Snapshot and Reload

The 24010 status loop captures a live agent snapshot and reads the current agent list on each tick so the published event reflects the live agent state. On agent config reload, publish_project_status_now reads agents from the shared agent snapshot and passes them through to the event builder. [^5ba0d-4]
## See Also

