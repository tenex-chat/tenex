# tenex-agent: Standalone Rust Agent

A self-contained Rust binary that executes a TENEX-compatible AI agent. Receives a Nostr event on stdin, runs an iterative multi-tool LLM loop, and emits Nostr events on stdout. No relay connections.

## Invocation

```bash
cargo run -p tenex-agent -- <agent.json> < triggering-event.json
```

## I/O Protocol

**stdin** — one JSON object: a complete Nostr event (id, pubkey, created_at, kind, tags, content, sig).

**stdout** — newline-delimited JSON objects (NDJSON):
- Zero or more intermediate `conversation` events (kind:1, no p-tag, no status tag) emitted as the agent works.
- Exactly one `completion` event (kind:1, with p-tag and `status=completed`) as the final line.

**stderr** — human-readable progress/debug output. Never parsed.

## Event Tagging

### Determining root_event_id from the triggering event

1. Find the first tag matching `["e", id, _, "root"]` → `root_event_id = id`
2. Else find the first `["e", id, ...]` tag → `root_event_id = id`
3. Else → `root_event_id = triggering_event.id` (event is its own root)

### Completion event tags

```
["e", root_event_id, "", "root"]   ← conversation threading
["p", triggering_event.pubkey]     ← routes response / triggers notification
["status", "completed"]            ← marks final turn
```

### Conversation event tags (intermediate, optional)

```
["e", root_event_id, "", "root"]   ← same threading
```
No p-tag, no status tag.

## Agent Configuration (agent.json)

```json
{
  "name": "my-agent",
  "nsec": "nsec1...",
  "role": "worker",
  "category": "worker",
  "instructions": "You are a helpful coding assistant. Work carefully and use tools liberally.",
  "description": "Optional human-readable description",
  "working_directory": "/optional/path/to/project",
  "default": {
    "model": "claude-sonnet-4-6"
  }
}
```

| Field               | Required | Description |
|---------------------|----------|-------------|
| `name`              | yes      | Agent slug used in identity prompt |
| `nsec`              | yes      | bech32 private key for signing events |
| `role`              | no       | Human-readable role label |
| `category`          | no       | `worker` \| `orchestrator` \| `reviewer` \| `domain-expert` \| `generalist` |
| `instructions`      | no       | Agent-specific system prompt fragment |
| `description`       | no       | Short description shown to other agents |
| `working_directory` | no       | Base directory for file/shell tools. Defaults to process cwd |
| `default.model`     | no       | Anthropic model ID. Defaults to `claude-sonnet-4-6` |

## System Prompt

Built from fragments in priority order, mirroring TENEX's `FragmentRegistry` pattern:

### Fragment 01 — Agent Identity
```xml
<agent-identity>
Your name: {name} ({short_pubkey})
Your category: {category}
</agent-identity>

<agent-instructions>
{instructions}
</agent-instructions>
```

### Fragment 08 — Project/Workspace Context
```xml
<project-context>
  <workspace>
    cwd: {working_directory}
  </workspace>
</project-context>
```

### Fragment 06 — Todo Guidance
Verbatim copy of TENEX's `06-todo-usage-guidance.ts` content, instructing the agent to use `todo_write` proactively.

### Fragment 14 — Tool Description Guidance
```
When tools have a `description` parameter, write 5-10 words in active voice describing *what* and *why*.
```

## Tools (v1)

Implemented in Rust; semantics match the TypeScript originals.

### `shell`
Execute a shell command in the working directory.

| Param | Type | Description |
|-------|------|-------------|
| `command` | string | Shell command |
| `description` | string | What this command does |
| `cwd` | string? | Override working directory |
| `timeout` | integer? | Timeout in seconds (default 30, max 600) |

Returns stdout + stderr on success. Returns a structured error string on failure.

### `fs_read`
Read a file's contents. Path relative to working directory.

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | File path |

### `fs_write`
Write content to a file (creates or overwrites).

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | File path |
| `content` | string | File content |

### `fs_edit`
Find-and-replace in a file. Fails if old_string not found or found multiple times.

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | File path |
| `old_string` | string | Exact text to replace |
| `new_string` | string | Replacement text |

### `fs_glob`
Find files matching a glob pattern.

| Param | Type | Description |
|-------|------|-------------|
| `pattern` | string | Glob pattern (e.g. `src/**/*.rs`) |

### `fs_grep`
Search for a string or regex in files.

| Param | Type | Description |
|-------|------|-------------|
| `pattern` | string | Search pattern (literal string or regex) |
| `path` | string? | File or directory to search (defaults to cwd) |
| `use_regex` | bool? | Treat pattern as regex (default false) |

### `todo_write`
Replace the agent's in-memory todo list. Full state replacement on every call.

| Param | Type | Description |
|-------|------|-------------|
| `todos` | array | Complete list of todos |
| `todos[].id` | string? | Auto-generated from title if omitted |
| `todos[].title` | string | Short description |
| `todos[].status` | string | `pending` \| `in_progress` \| `done` \| `skipped` |
| `todos[].skip_reason` | string? | Required when status=`skipped` |

## Iterative Loop

Uses `rig-core`'s `Agent::prompt()` which handles multi-turn tool use internally:

1. Build system prompt from fragments.
2. Call `agent.prompt(triggering_event.content)`.
3. rig sends messages to Claude, receives tool calls, executes them, feeds results back — looping until Claude produces a final text response.
4. Sign and emit the completion Nostr event to stdout.

The loop terminates when Claude returns a text response without tool calls (`stop_reason = "end_turn"`). rig enforces a default turn limit to prevent infinite loops.

## Dependencies

| Crate | Purpose |
|-------|---------|
| `rig-core` | LLM agent framework with tool loop |
| `nostr` | Nostr event types and signing |
| `tokio` | Async runtime |
| `serde` + `serde_json` | JSON handling |
| `anyhow` + `thiserror` | Error handling |
| `glob` | File glob patterns |
| `walkdir` | Directory traversal for grep |
| `regex` | Regex support for grep |

## Future Work (not in v1)

- **Streaming intermediate events**: Emit conversation events as text chunks arrive, not just at completion.
- **Conversation history**: Pass prior messages so the agent has context across turns.
- **`no_response` tool**: Suppress the completion event when the agent decides no reply is needed.
- **`delegate` tool**: Forward work to another agent via a new stdin event.
- **`ask` tool**: Pause and emit an ask event; wait for a reply on stdin.
- **Token budgeting**: Compact long conversations before sending to the LLM.
- **AGENTS.md injection**: Include project's AGENTS.md in the project context fragment.
