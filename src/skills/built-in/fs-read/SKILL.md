---
name: Read access
description: Read files, search by pattern, and grep file contents in the project directory
tools:
  - fs_read
  - fs_glob
  - fs_grep
  - home_fs_read
  - home_fs_glob
  - home_fs_grep
---

# Read access

This skill provides read-only filesystem tools for the project and the agent's home directory.

## Available Tools
- `fs_read` - Read a file or directory listing from the project
- `fs_glob` - Find files by glob pattern within the project
- `fs_grep` - Search for patterns in files within the project
- `home_fs_read` - Read a file or directory listing from the agent's home directory
- `home_fs_glob` - Find files by glob pattern within the agent's home directory
- `home_fs_grep` - Search for patterns in files within the agent's home directory
