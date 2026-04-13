---
name: write-access
description: "Write new files and edit existing files within the sandboxed project directory. Supports path variables ($AGENT_HOME, $PROJECT_BASE, $USER_HOME) for portable paths and auto-creates parent directories on write. Use when creating files, modifying file content, updating configuration, or making targeted edits to existing project files."
tools:
  - fs_write
  - fs_edit
---

# Write Access

Provides sandboxed filesystem write and edit operations for the current project directory and agent home.

## Tools

### `fs_write`

Writes content to a file path. Creates parent directories automatically if they do not exist. Overwrites existing files.

- **Use when:** creating new files, replacing entire file contents, or writing generated output to disk.
- **Path variables:** `$PROJECT_BASE`, `$AGENT_HOME`, `$USER_HOME` are expanded before execution.

### `fs_edit`

Replaces a specific string in an existing file with new content, leaving the rest of the file unchanged.

- **Use when:** making targeted, surgical edits — fixing a line, updating a value, or patching a section without rewriting the whole file.
- **Prefer over `fs_write`** for partial modifications to preserve surrounding content.

## Constraints

- All paths are sandboxed to the project base directory and the agent home directory. Writes outside these roots are rejected.
- Use path variables instead of hardcoded absolute paths for portability across environments.

## Workflow

1. Identify the target file path (use `fs_read` or `fs_glob` from the `read-access` skill to verify the file exists first when editing).
2. For new files or full replacements, call `fs_write` with the complete content.
3. For partial edits, call `fs_edit` with the exact `old_string` to match and the `new_string` replacement.
4. Verify the result with `fs_read` if needed.
