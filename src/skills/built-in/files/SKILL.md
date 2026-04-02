---
name: Filesystem Access
description: Read, write, edit, search, and glob files in the project directory
tools:
  - fs_read
  - fs_write
  - fs_edit
  - fs_glob
  - fs_grep
---

# Filesystem Access

This skill provides tools for reading, writing, editing, and searching files within the project directory and agent home directory.

## Available Tools
- `fs_read` - Read a file or directory listing with line numbers
- `fs_write` - Write content to a file, creating parent directories automatically
- `fs_edit` - Edit a file by replacing a specific string with a new string
- `fs_glob` - Find files by glob pattern within the project
- `fs_grep` - Search file contents with ripgrep, supporting regex patterns
