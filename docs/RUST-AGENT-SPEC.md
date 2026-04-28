# tenex-agent: Standalone Rust Agent

A self-contained Rust binary that executes a TENEX-compatible AI agent. Receives a Nostr event on stdin, runs an iterative multi-tool LLM loop, and emits Nostr events on stdout. No relay connections.

## Invocation

```bash
TENEX_PROJECT_ID=<project-id> cargo run -p tenex-agent -- <agent.json> < triggering-event.json
```

`TENEX_PROJECT_ID` is mandatory — the daemon sets it before spawning the agent. It is used to open the project SQLite DB (agents, metadata, teams) and the conversation store (todo persistence).

## I/O Protocol

**stdin** — one JSON object: a complete Nostr event (id, pubkey, created_at, kind, tags, content, sig).

**stdout** — newline-delimited JSON objects (NDJSON):
- Zero or more `tool-use` events (kind:1111) emitted before and after each tool call.
- Zero or more intermediate `conversation` events (kind:1, no p-tag, no status tag) emitted after each LLM turn.
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

### Conversation event tags (intermediate)

```
["e", root_event_id, "", "root"]   ← same threading
```
No p-tag, no status tag.

## Agent Configuration (agent.json)

```json
{
  "name": "my-agent",
  "slug": "my-agent",
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
| `name`              | yes      | Human-readable agent name |
| `slug`              | no       | Identifier used in identity prompt and team resolution. Falls back to `name` |
| `nsec`              | yes      | bech32 private key for signing events |
| `role`              | no       | Human-readable role label |
| `category`          | no       | `worker` \| `orchestrator` \| `reviewer` \| `domain-expert` \| `generalist` |
| `instructions`      | no       | Agent-specific system prompt fragment |
| `description`       | no       | Short description shown to other agents |
| `working_directory` | no       | Base directory for file/shell tools. Defaults to process cwd |
| `default.model`     | no       | Model ID (named preset, `provider:model`, or bare Anthropic model). Defaults to the llms.json default or `claude-sonnet-4-6` |

## System Prompt

Built from fragments assembled inline by `prompt.rs`:

### Fragment 01 — Agent Identity
```xml
<agent-identity>
Your name: {slug|name} ({short_pubkey})
Your category: {category}
</agent-identity>
```

### Fragment 03 — System Reminders Explanation
```xml
<system-reminders-explanation>
Messages may include <system-reminder> tags. These are system-injected informational
context — not user speech. Absorb them silently; do not acknowledge or respond to them directly.
</system-reminders-explanation>
```

### Agent Instructions
```xml
<agent-instructions>
{instructions}
</agent-instructions>
```

### Fragment 08 — Project/Workspace Context
```xml
<project-context>
  <workspace>
    cwd: {working_directory}
    project: {project_title}
    owner: {owner_pubkey_short}
  </workspace>
</project-context>
```

### Available Agents
```xml
<available-agents>
  - {slug} ({name}): {description|role}
    Use when: {use_criteria}
</available-agents>
```
Emitted only when the project has registered agents. Read from project SQLite DB.

### Teams Context
```xml
<teams-context>
  ...
</teams-context>
```
Emitted when the agent belongs to one or more teams or the triggering event carries a `["team", ...]` tag. Read from `~/.tenex/teams.json` and `~/.tenex/projects/<id>/teams.json`.

### Fragment 06 — Todo Guidance
Instructs the agent to use `todo_write` proactively. Explains status lifecycle and the one-in-progress rule.

### Fragment 14 — Tool Description Guidance
```
When tools have a `description` parameter, write 5-10 words in active voice describing *what* and *why*.
```

### Proactive Context (dynamic)
If RAG is configured and the vector search returns results with score ≥ 0.65, a `<proactive-context>` block is appended to the system prompt with up to 5 relevant snippets (collections searched: `conversations`, `project_<id>`, `agent_<pubkey>`).

## Tools

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
| `todos[].description` | string? | Detailed description; preserved from existing item if omitted on update |
| `todos[].status` | string | `pending` \| `in_progress` \| `done` \| `skipped` |
| `todos[].skip_reason` | string? | Required when status=`skipped` |
| `force` | bool? | Allow removing existing items (default: false) |

Todos are persisted to the conversation SQLite store (`AgentContextState.todos`) and reloaded on the next invocation. A `<system-reminder>` with the current todo state is prepended to the user message when todos exist.

### `delegate`
Delegate a task to another agent by slug, or to a whole team by team name.

| Param | Type | Description |
|-------|------|-------------|
| `recipient` | string | Agent slug (e.g. `architect`) or team name (e.g. `design`) |
| `prompt` | string | Task and full context for the delegated agent |

Emits a `DelegationIntent` event on stdout, then a `ToolUseIntent` event referencing it. Returns a message instructing the agent to stop for the turn. Team names are resolved case-insensitively to the team lead agent.

### `rag_index`
Index content into the RAG vector store.

| Param | Type | Description |
|-------|------|-------------|
| `content` | string | Text to embed and store |
| `collection` | string | Collection name |
| `title` | string? | Optional document title |

Disabled (returns error message) when embedding is not configured (`~/.tenex/embed.json` absent).

### `rag_search`
Search the RAG vector store for relevant content.

| Param | Type | Description |
|-------|------|-------------|
| `query` | string | Natural-language search query |
| `collections` | string[]? | Collections to search (defaults to project + agent collections) |
| `limit` | integer? | Max results (default 5) |

Disabled (returns error message) when embedding is not configured.

## Iterative Loop

Uses `rig-core`'s `Agent::prompt()` with a `PromptHook` (`EmitHook`):

1. Build system prompt from fragments (including proactive RAG context if available).
2. Inject todo reminder into the user message if persisted todos exist.
3. Call `agent.prompt(user_message).with_hook(hook)`.
4. `rig` sends messages to the provider, receives tool calls, executes them, feeds results back — looping until the provider returns a final text response.
5. After each LLM turn: `EmitHook::on_completion_response` emits a `ConversationIntent` event with the turn text and token usage.
6. Before each tool call: `EmitHook::on_tool_call` emits a `ToolUseIntent` event (except `delegate`, which emits its own after the call with a reference to the delegation event).
7. Sign and emit the final `CompletionIntent` event with aggregated token usage.
8. Save the updated todo list to the conversation store.

The loop terminates when the provider returns a text response without tool calls. `rig` enforces `default_max_turns(25)`.

## Model Resolution

Resolution order:

1. Check `default.model` against named presets in `~/.tenex/llms.json`.
2. Parse `provider:model` or `provider/model` inline format.
3. Fall back to raw model string with `anthropic` as provider.

API keys are resolved from environment (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, etc.) then from `~/.tenex/providers.json`. Supported providers: `anthropic`, `openai`, `openrouter`, `ollama`.

## Dependencies

| Crate | Purpose |
|-------|---------|
| `rig-core` | LLM agent framework with tool loop and hook interface |
| `nostr` | Nostr event types and signing |
| `tokio` | Async runtime |
| `serde` + `serde_json` | JSON handling |
| `anyhow` + `thiserror` | Error handling |
| `glob` | File glob patterns |
| `walkdir` | Directory traversal for grep |
| `regex` | Regex support for grep |
| `dirs_next` | Home directory resolution |
| `tenex-protocol` | `Intent`, `Channel`, Nostr encoder, stdin source, stdout NDJSON sink |
| `tenex-project` | Project SQLite DB (agents, metadata, teams) |
| `tenex-conversations` | Conversation SQLite store (todo persistence via `AgentContextState`) |
| `tenex-rag` | RAG: SQLite vector store + embedding client |
| `tenex-llm-config` | Provider credential resolution |

## Future Work (not yet implemented)

- **Streaming intermediate events**: Emit conversation events as text chunks arrive, not just at LLM turn boundaries.
- **Conversation history**: Load prior turns from `tenex-conversations` so the agent has full message history across invocations. Currently each invocation is stateless from the LLM's perspective.
- **Context management**: Wire `tenex-context` strategies (compaction → tool-result decay → reminders) into the agent's message projection. Currently the agent has no token-budget enforcement or message compaction.
- **System prompt crate**: Replace inline `prompt.rs` with `tenex-system-prompt` for consistent assembly across binaries.
- **`no_response` tool**: Suppress the completion event when the agent decides no reply is needed.
- **`ask` tool**: Pause execution and emit an ask event; wait for a reply on stdin.
- **AGENTS.md injection**: Include the project's `AGENTS.md` in the project context fragment.
