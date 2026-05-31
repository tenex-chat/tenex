---
title: Cross-Platform Errno Retrieval
slug: cross-platform-errno-retrieval
summary: "Errno values are read via `std::io::Error::last_os_error().raw_os_error()` rather than `libc::__errno_location()` to ensure cross-platform compatibility (macOS"
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-01
updated: 2026-05-01
verified: 2026-05-01
compiled-from: conversation
sources:
  - session:b8cfe578-56d1-4e3c-838b-f296eefea905
  - session:e7d99388-4ebd-4df6-837a-41fa35a449a5
  - session:bb16efcc-cdd4-4c84-b469-491d287ef37f
---

# Cross-Platform Errno Retrieval

## Cross-Platform Errno Retrieval

The tenex codebase uses `std::io::Error::last_os_error().raw_os_error().unwrap_or(0)` rather than `libc::__errno_location()` to retrieve errno values, ensuring cross-platform compatibility (macOS and Linux) and avoiding unsafe blocks. Direct errno access uses `libc::__errno()` instead of `libc::__errno_location()`. This approach applies to both `tenex/src/daemon/lockfile.rs` and `tenex/src/runtime_cmd/mod.rs`. An alternative approach for frequent errno retrieval uses the `errno` crate (version 0.3) with the expression `errno::errno().0`.

<!-- citations: [^b8cfe-1] [^e7d99-1] [^bb16e-1] -->
## See Also

