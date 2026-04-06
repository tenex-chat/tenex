---
name: read-access
description: Read files, search by pattern, and grep file contents in the project directory
tools:
  - fs_read
  - fs_glob
  - fs_grep
---

# Read access

This skill provides read-only filesystem tools for the project directory. You can use your environment variables (e.g. `$PROJECT_BASE`) as part of path arguments.
