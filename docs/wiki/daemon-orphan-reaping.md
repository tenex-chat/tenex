---
title: Daemon Orphan Reaping
slug: daemon-orphan-reaping
summary: The TENEX supervisor reaps orphan companion daemon processes before starting fresh ones
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-04
updated: 2026-05-13
verified: 2026-05-04
compiled-from: conversation
sources:
  - session:cc7b39b5-6e21-4d21-9048-22bff4a22da2
  - session:5e917ebf-3e5f-41b1-a797-ce5c77ac2a6b
---

# Daemon Orphan Reaping

## Orphan Reaping

The TENEX supervisor reaps orphan companion daemon processes before starting fresh ones. The reaper only acts after the new supervisor has acquired its own daemon lockfile, guaranteeing no other authoritative daemon exists. For each companion pid file in ~/.tenex/ that is still flock-held, the reaper reads the pid and sends SIGTERM with a 5-second grace period. If SIGTERM fails to release the flock, the reaper escalates to SIGKILL with a 2-second grace period, polling the flock until released. If both SIGTERM and SIGKILL fail to release the flock, daemon startup aborts and reports the pid and lockfile path. If the daemon's stored current_exe path no longer exists on disk, cmd.spawn() returns ENOENT for new runtime boot attempts, preventing the runtime from starting. This ENOENT error is not caused by a missing project directory, because the supervisor builds the runtime command without calling cmd.current_dir(...).

<!-- citations: [^cc7b3-1] [^cc7b3-2] [^cc7b3-3] [^5e917-1] -->
## See Also

