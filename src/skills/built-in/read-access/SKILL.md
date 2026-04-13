---
name: read-access
description: "Read files, list directories, find files by glob pattern, and search file contents with regex within the sandboxed project directory. Supports path variables ($PROJECT_BASE, $AGENT_HOME, $USER_HOME) and pagination for large files. Use when reading file contents, listing directory structures, finding files by name pattern, or searching for text patterns across the project."
tools:
  - fs_read
  - fs_glob
  - fs_grep
---

# Read Access

Provides sandboxed, read-only filesystem operations for exploring and searching the current project directory and agent home.

## Tools

### `fs_read`

Reads a file's contents or lists a directory's entries.

- **Use when:** inspecting file contents, checking configuration values, or listing what files exist in a directory.
- Supports `offset` and `limit` parameters for paginating through large files.
- Returns content with line numbers for easy reference.

### `fs_glob`

Finds files matching a glob pattern within the allowed directories.

- **Use when:** locating files by name or extension (e.g. `**/*.ts`, `src/**/index.ts`).
- Returns matching file paths sorted by modification time.

### `fs_grep`

Searches for regex patterns across file contents within the allowed directories.

- **Use when:** finding specific code patterns, function definitions, configuration values, or text across multiple files.
- Uses ripgrep under the hood for fast searching.

## Constraints

- All paths are sandboxed to the project base and agent home directories.
- Path variables (`$PROJECT_BASE`, `$AGENT_HOME`, `$USER_HOME`) are expanded before execution for portable paths.

## Workflow

1. **Explore structure:** Use `fs_read` on a directory path to list its contents, or `fs_glob` with a broad pattern.
2. **Find specific files:** Use `fs_glob` with a targeted pattern (e.g. `**/*.config.ts`).
3. **Search content:** Use `fs_grep` with a regex to locate code or text across files.
4. **Read details:** Use `fs_read` on specific files found in prior steps, with `offset`/`limit` for large files.
