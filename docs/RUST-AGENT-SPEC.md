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
    "model": "claude-sonnet-4-6",
    "skills": ["rust-expert", "code-review"]
  }
}
```

| Field               | Required | Description |
|---------------------|----------|-------------|
| `name`              | yes      | Human-readable agent name |
| `slug`              | no       | Identifier used in identity prompt and team resolution. Falls back to `name` |
| `nsec`              | yes      | bech32 private key for signing events |
| `role`              | no       | Human-readable role label |
| `category`          | no       | `principal` \| `orchestrator` \| `worker` \| `reviewer` \| `domain-expert` \| `generalist` |
| `instructions`      | no       | Agent-specific system prompt fragment |
| `description`       | no       | Short description shown to other agents |
| `working_directory` | no       | Base directory for file/shell tools. Defaults to process cwd |
| `default.model`     | no       | Model ID (named preset, `provider:model`, or bare Anthropic model). Defaults to the llms.json default or `claude-sonnet-4-6` |
| `default.skills`    | no       | Array of skill IDs to preload on every invocation (always-on skills). Merged with conversation-scoped self-applied skills. |

## Agent Category Semantics

Category affects both delegation capability and system prompt guidance injected.

| Category | Can delegate | Prompt guidance |
|----------|-------------|-----------------|
| `principal` | yes | Delegation tips, todo-before-delegation, monitoring |
| `orchestrator` | yes | Orchestrator guidance, delegation tips, todo-before-delegation, monitoring |
| `worker` | no | Todo guidance only |
| `reviewer` | yes | Delegation tips, todo-before-delegation, monitoring |
| `domain-expert` | no | Domain-expert guidance (hard refuse on out-of-domain) |
| `generalist` | yes | Delegation tips, todo-before-delegation, monitoring |

Unrecognized or absent `category` is treated as "can delegate" for backwards compatibility.

## Agent Home Directory

Each agent gets a persistent private directory at `~/.tenex/home/<pubkey8>/`. On every invocation:

1. The directory is created if absent.
2. A `.env` file is written (if not already present, mode 0600) with `NSEC`, `PUBKEY`, and `NPUB`.
3. Files starting with `+` (e.g., `+NOTES.md`) are read and injected into the system prompt as `<memorized-files>` (up to 10 files, 1500 chars each, truncated with `truncated="true"` attribute).

Shell commands automatically see environment variables from the `.env` file plus computed vars (see Fragment 07 below). `~` in shell expands to the real `$HOME`; agents should use `$AGENT_HOME` to reference their home.

## System Prompt

Built from fragments assembled by `prompt.rs`:

### Fragment 01 — Agent Identity
```xml
<agent-identity>
Your name: {slug|name} ({short_pubkey})
Your category: {category}
</agent-identity>
```

### Fragment 02 — Home Directory
```xml
<home-directory>
You have a personal home directory at: `{agent_home}`. ...
Current contents: {file_count}
...
<memorized-files>
  <file name="+NOTES.md">...</file>   ← injected from + files
</memorized-files>
</home-directory>
```
Describes the agent home dir, `.env` semantics, `+` file auto-injection rules, and `$AGENT_HOME` vs `~` distinction.

### Fragment 03 — System Reminders Explanation
```xml
<system-reminders-explanation>
System messages may include `<system-reminders>` blocks, and tool results or user messages
may include `<system-reminder>` tags. These are system-injected informational context — not
user speech. Absorb them silently; do not acknowledge or respond to them.
</system-reminders-explanation>
```

### Agent Instructions
```xml
<agent-instructions>
{instructions}
</agent-instructions>
```
Omitted when `instructions` is absent.

### Preloaded Skills
```xml
<loaded-skills>
<skill-tool-permissions>
<!-- Aggregated across all active skills -->
...
</skill-tool-permissions>

The following skills have been loaded for this conversation. These provide additional context and capabilities:
<skill id="rust-expert">
...skill content...
</skill>
</loaded-skills>
```
Injected when any skills are preloaded (from `default.skills` in agent config or `self_applied_skills` from the conversation store). Omitted when no skills are active. Includes an aggregated `<skill-tool-permissions>` block when skills declare `only-tools`/`allow-tools`/`deny-tools` in their frontmatter (LLM-guidance only; not enforced at the tool-call level). Skills are discovered from five scope directories in precedence order: `builtIn` → `agent` → `agentProject` → `project` → `shared`.

### Fragment 07 — Environment Variables
```xml
<environment-variables>
These variables are available in shell commands and file tool path arguments.
- $USER_HOME, $AGENT_HOME, $PUBKEY, $NPUB
- $PROJECT_BASE, $PROJECT_ID
- $TENEX_BASE_DIR
...
</environment-variables>
```
Omitted for `orchestrator` category (adds noise with no benefit).

### Fragment 08 — Project/Workspace Context
```xml
<project-context>
  <workspace>
    cwd: {working_directory}
    project: {project_title}
    owner: {owner_pubkey_short}
  </workspace>

  <agents.md>
    {contents of AGENTS.md if ≤2000 chars}
  </agents.md>
</project-context>
```
`agents.md` block is omitted when `AGENTS.md` is absent or larger than 2000 chars.

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
<teams-context>...</teams-context>
```
Emitted when the agent belongs to teams or the triggering event carries a `["team", ...]` tag. Loaded from `~/.tenex/teams.json` and `~/.tenex/projects/<id>/teams.json`.

### Fragment 06 — Todo Guidance
Instructs the agent to use `todo_write` proactively, explains status lifecycle and the one-in-progress rule. Present for all categories.

### Fragment 14 — Tool Description Guidance
```
When tools have a `description` parameter, write 5-10 words in active voice.
```

### Category-Specific Fragments

- **Orchestrator**: Orchestrator guidance (coordinate, don't do everything yourself).
- **Domain expert**: Hard-refuse on out-of-domain requests; no delegation.
- **Non-worker, non-domain-expert**: Delegation tips, todo-before-delegation, and agent-directed monitoring guidance (how to use `conversation_get` + sleep to poll delegatees).

### Proactive Context (dynamic)
If RAG is configured and the vector search returns results with score ≥ 0.65, a `<proactive-context>` block is appended to the system prompt with up to 5 relevant snippets (collections searched: `conversations`, `project_<id>`, `agent_<pubkey>`).

## Tools

Implemented in Rust; semantics match the TypeScript originals.

### `shell`
Execute a shell command in the working directory. Shell sessions auto-load the agent `.env` file and have access to computed env vars (`$AGENT_HOME`, `$PUBKEY`, `$NPUB`, `$PROJECT_BASE`, `$PROJECT_ID`, `$TENEX_BASE_DIR`, `$USER_HOME`).

| Param | Type | Description |
|-------|------|-------------|
| `command` | string | Shell command |
| `description` | string | What this command does |
| `cwd` | string? | Override working directory |
| `timeout` | integer? | Timeout in seconds (default 30, max 600) |

Returns stdout + stderr on success. Returns a structured error string on failure.

### `fs_read`
Read a file's contents, or list a directory. Lines are numbered; output defaults to 250 lines. Pass `offset`/`limit` to paginate large files.

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | File or directory path (relative to working directory) |
| `description` | string | Brief reason for this read |
| `offset` | integer? | 1-based line number to start from (default 1) |
| `limit` | integer? | Maximum lines to return (default 250) |

### `fs_write`
Write content to a file (creates parent dirs automatically, overwrites existing).

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | File path |
| `content` | string | File content |
| `description` | string | Brief reason for this write |

### `fs_edit`
Find-and-replace in a file. When `replace_all` is false (default), `old_string` must appear exactly once; fails if not found or ambiguous.

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | File path |
| `description` | string | Brief reason for this edit |
| `old_string` | string | Exact text to replace |
| `new_string` | string | Replacement text |
| `replace_all` | bool? | Replace every occurrence instead of requiring a unique match (default false) |

### `fs_glob`
Find files matching a glob pattern. Returns matching paths relative to working directory, sorted, up to `head_limit` results.

| Param | Type | Description |
|-------|------|-------------|
| `pattern` | string | Glob pattern (e.g. `src/**/*.rs`) |
| `description` | string | Brief reason for this search |
| `head_limit` | integer? | Maximum results; 0 for unlimited (default 100) |
| `offset` | integer? | Skip the first N results (default 0) |

### `fs_grep`
Search file contents using ripgrep (falls back to grep). Pattern is always treated as a regex. Supports three output modes: `files_with_matches` (default), `content` (with line numbers), and `count`.

| Param | Type | Description |
|-------|------|-------------|
| `pattern` | string | Regex pattern to search for |
| `description` | string | Brief reason for this search |
| `path` | string? | File or directory to search (defaults to cwd) |
| `output_mode` | string? | `files_with_matches` \| `content` \| `count` (default: `files_with_matches`) |
| `glob` | string? | Glob filter for files (e.g. `*.ts`) |
| `-i` | bool? | Case-insensitive search |
| `-A` | integer? | Lines of trailing context (content mode) |
| `-B` | integer? | Lines of leading context (content mode) |
| `-C` | integer? | Lines of surrounding context (content mode) |
| `head_limit` | integer? | Maximum results; 0 for unlimited (default 100) |
| `offset` | integer? | Skip the first N results (default 0) |

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
Delegate a task to another agent by slug, or to a whole team by team name. **Only available to categories that allow delegation** (`principal`, `orchestrator`, `reviewer`, `generalist`). Absent for `worker` and `domain-expert`.

| Param | Type | Description |
|-------|------|-------------|
| `recipient` | string | Agent slug (e.g. `architect`) or team name (e.g. `design`) |
| `prompt` | string | Task and full context for the delegated agent |

Emits a `DelegationIntent` event on stdout, then a `ToolUseIntent` event referencing it. Returns a message instructing the agent to stop for the turn. Team names are resolved case-insensitively to the team lead agent.

### `rag_index`
Index content into the RAG vector store. The `audience` field determines which collection to store in: `"self"` → `agent_{pubkey}` (personal notes); `"project"` → `project_{id}` (shared project knowledge).

| Param | Type | Description |
|-------|------|-------------|
| `content` | string | Text to embed and store |
| `audience` | string | `"self"` (personal agent knowledge) \| `"project"` (shared project knowledge) |
| `title` | string? | Optional document title |

Disabled (returns error message) when embedding is not configured (`~/.tenex/embed.json` absent).

### `rag_search`
Search the RAG vector store for relevant content. Always searches across all three fixed collections: `conversations`, `project_{id}`, and `agent_{pubkey}`.

| Param | Type | Description |
|-------|------|-------------|
| `query` | string | Natural-language search query |
| `limit` | integer? | Max results (default 10) |

Disabled (returns error message) when embedding is not configured.

### `skill_list`
List all available skills grouped by scope. Returns a JSON object with `total` count, per-scope `counts`, and `scopes` map (keys: `builtIn`, `agent`, `agentProject`, `project`, `shared`). Each skill entry includes `identifier`, optional `name`, optional `description` (truncated at 150 chars), `hasTools`, and `scope`.

No parameters.

### `skills_set`
Add or remove skills for the current conversation. Newly-added skill content is returned in the `skillContent` field for immediate use. When `always=true`, persists the resulting set to `default.skills` in the agent config JSON (atomic write). Self-applied skills are also persisted to `AgentContextState.self_applied_skills` at conversation end.

| Param | Type | Description |
|-------|------|-------------|
| `add` | string[]? | Skill IDs to activate (merged into current set) |
| `remove` | string[]? | Skill IDs to deactivate. Pass `["*"]` to clear all before applying `add` |
| `always` | bool? | Persist the final skill set to agent config for all future invocations (default false) |

Returns JSON: `{ success, message, activeSkills, skillContent }`. Rejects if the same ID appears in both `add` and `remove`, or if any `add` ID is not resolvable from `skill_list`.

## Supervision Heuristics

`tenex-supervision` is wired into the hook layer. It runs two kinds of checks:

**Pre-tool (blocks tool calls):**
- `WorkerTodoHeuristic` — blocks non-todo tool calls for `worker` category agents when they have pending todos and haven't created a todo list yet.

**Post-completion (can re-engage the agent):**
- `PendingTodosHeuristic` — detects completions with unresolved pending todos.
- `ConsecutiveToolsWithoutTodoHeuristic` — detects agents making many tool calls without a todo list.

When a pre-tool heuristic fires, `ToolCallHookAction::skip(reason)` is returned and the tool call is cancelled with the reason injected as a system reminder. Post-completion detections are tracked but re-engagement is currently surfaced through the hook return value.

## Iterative Loop

Uses `rig-core`'s `Agent::stream_prompt()` with an `EmitHook`. The stream is consumed to completion; only the final `FinalResponse` item (containing the response text and aggregated token usage) is retained.

1. Build system prompt from fragments (preloaded skills → home dir → reminders → instructions → env vars → project context → agents → teams → todo guidance → category-specific → proactive RAG context).
2. Inject todo reminder into the user message if persisted todos exist.
3. Call `agent.stream_prompt(user_message).with_hook(hook)` and drain the stream.
4. `rig` sends messages to the provider, receives tool calls, executes them, feeds results back — looping until the provider returns a final text response.
5. **Before each tool call**: `EmitHook::on_tool_call` runs pre-tool supervision checks. If blocked, returns `skip(reason)`. Otherwise emits a `ToolUseIntent` event (except `delegate`, which emits its own).
6. **After each LLM turn**: `EmitHook::on_completion_response` emits a `ConversationIntent` event with the turn text and token usage.
7. Sign and emit the final `CompletionIntent` event with token usage from `FinalResponse`.
8. Save todos and self-applied skills atomically to the conversation store via `save_context_state`.

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
| `rig-core` | LLM agent framework with streaming tool loop and hook interface |
| `futures` | `StreamExt` for consuming the streaming response |
| `nostr` | Nostr event types and signing |
| `tokio` | Async runtime |
| `serde` + `serde_json` | JSON handling |
| `anyhow` + `thiserror` | Error handling |
| `glob` | File glob patterns (`fs_glob`) |
| `regex` | Regex for parsing ripgrep/grep output line format |
| `dirs_next` | Home directory resolution |
| `tenex-protocol` | `Intent`, `Channel`, Nostr encoder, stdin source, stdout NDJSON sink |
| `tenex-project` | Project SQLite DB (agents, metadata, teams) |
| `tenex-conversations` | Conversation SQLite store (todos + self-applied skills via `AgentContextState`) |
| `tenex-rag` | RAG: SQLite vector store + embedding client |
| `tenex-supervision` | Heuristic pre-tool and post-completion checks; `AgentCategory` enum |
| `tenex-llm-config` | Provider credential resolution |

## Future Work (not yet implemented)

- **Streaming intermediate events**: The agent now uses `stream_prompt` internally, but `ConversationIntent` events are still emitted once per LLM turn. Per-chunk streaming to the relay is not yet implemented.
- **Conversation history**: Load prior turns from `tenex-conversations` so the agent has full message history across invocations. Currently each invocation is stateless from the LLM's perspective.
- **Context management**: Wire `tenex-context` strategies (compaction → tool-result decay → reminders) into the agent's message projection. Currently the agent has no token-budget enforcement or message compaction.
- **System prompt crate**: Replace inline `prompt.rs` with `tenex-system-prompt` for consistent assembly across binaries.
- **`no_response` tool**: Suppress the completion event when the agent decides no reply is needed.
- **`ask` tool**: Pause execution and emit an ask event; wait for a reply on stdin.
