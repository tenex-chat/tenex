# tenex-agent: Standalone Rust Agent

A self-contained Rust binary that executes a TENEX-compatible AI agent. Receives a Nostr event on stdin, runs an iterative multi-tool LLM loop, and emits Nostr events on stdout. No relay connections.

## Invocation

```bash
TENEX_PROJECT_ID=<project-id> cargo run -p tenex-agent -- <agent.json> < triggering-event.json
```

`TENEX_PROJECT_ID` is mandatory — the daemon sets it before spawning the agent. It is used to open the file-backed project view (project event metadata plus global agent JSON records) and the conversation store (todo persistence).

`TENEX_MCP_MANIFEST` and `TENEX_MCP_SOCKET` are optional and set only by `tenex-runtime` when the selected agent has `default.mcp` access to project `.mcp.json` servers. The manifest contains tool definitions; the socket is the side channel for MCP tool calls so stdout remains reserved for signed Nostr NDJSON.

## I/O Protocol

**stdin** — one JSON object: a complete Nostr event (id, pubkey, created_at, kind, tags, content, sig).

**stdout** — newline-delimited JSON objects (NDJSON):
- Zero or more `tool-use` events (kind:1, `["tool", name]` tag) emitted before each tool call.
- Zero or more streaming text delta events (kind:24135) emitted per token chunk during each LLM turn.
- Zero or more intermediate `conversation` events (kind:1, no p-tag, no status tag) emitted after each LLM turn (multi-turn tool sequences only).
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
  "category": "worker",
  "instructions": "You are a helpful coding assistant. Work carefully and use tools liberally.",
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
| `category`          | no       | `principal` \| `orchestrator` \| `worker` \| `reviewer` \| `domain-expert` \| `generalist` |
| `instructions`      | no       | Agent-specific system prompt fragment |
| `working_directory` | no       | Base directory for file/shell tools. Defaults to process cwd |
| `default.model`     | no       | Model ID (named preset, `provider:model`, or bare Anthropic model). Defaults to the llms.json default or `claude-sonnet-4-6` |
| `default.skills`    | no       | Array of skill IDs to preload on every invocation (always-on skills). Merged with conversation-scoped self-applied skills. |

Note: `role` and `description` exist in the agent JSON files (written by `agents_write`) but are not read by `AgentConfig` — they are stored-only metadata consumed by other parts of the system (UI, discovery).

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

Built from fragments assembled by `tenex_system_prompt::build_system_prompt()`:

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
Emitted only when the project has registered agents. Read through `tenex-project` from the project event membership plus global installed-agent JSON records.

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
- **Non-worker, non-domain-expert**: Delegation tips, todo-before-delegation, and agent-directed monitoring guidance (async re-invocation model; use `delegate_followup` for mid-flight corrections).

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

Emits a `DelegationIntent` event on stdout, then a `ToolUseIntent` event referencing it. Returns a message with the delegation event ID instructing the agent to stop for the turn. Team names are resolved case-insensitively to the team lead agent.

### `delegate_followup`
Send a followup message to an agent already delegated to, referencing the original delegation event. Use for corrections or additional context before the delegatee finishes. **Only available to categories that allow delegation.**

| Param | Type | Description |
|-------|------|-------------|
| `recipient` | string | Agent slug — same as in the original `delegate` call |
| `delegation_event_id` | string | Hex event ID returned by the original `delegate` call |
| `message` | string | Additional instructions, corrections, or context |

### `delegate_crossproject`
Delegate a task to an agent in a different project. Use `project_list` first to discover available project IDs and agent slugs. **Only available to categories that allow delegation.**

| Param | Type | Description |
|-------|------|-------------|
| `project_id` | string | Target project ID (bare dTag) |
| `recipient` | string | Agent slug in the target project |
| `request` | string | Task and full context for the delegated agent |
| `branch` | string? | Optional git branch context |

### `self_delegate`
Schedule follow-on work for yourself as a new top-level task. Use to defer work to a future invocation or split a large task across turns. **Only available to categories that allow delegation.**

| Param | Type | Description |
|-------|------|-------------|
| `request` | string | The follow-on task to execute in the next invocation |
| `branch` | string? | Optional git branch context |

### `ask`
Ask the project owner a structured question and pause execution. Stop after calling this — the owner's reply arrives in a future invocation.

| Param | Type | Description |
|-------|------|-------------|
| `title` | string | Short title summarizing what you need to know |
| `context` | string | Background explaining why you're asking |
| `questions` | array | One or more structured questions |
| `questions[].type` | string | `single_select` or `multi_select` |
| `questions[].title` | string | Question label |
| `questions[].prompt` | string | Detailed question text |
| `questions[].options` | string[] | Available choices |

### `learn`
Persist a lesson learned. Publishes a Nostr lesson event and calls the current LLM to update `+INDEX.md` in the agent's home directory with a categorized summary. The `+INDEX.md` file is auto-injected into the system prompt on future invocations so lessons accumulate in the agent's working memory. Note: the Rust implementation intentionally diverges from the TypeScript version — TS stores lessons in a `lessons` RAG collection, Rust uses an LLM-maintained index file.

| Param | Type | Description |
|-------|------|-------------|
| `title` | string | Short title for the lesson |
| `lesson` | string | What was learned and why it matters |
| `category` | string? | Category for organization (e.g. `debugging`, `architecture`, `workflow`) |
| `hashtags` | string[]? | Optional hashtags without the `#` prefix |

### `project_list`
List all TENEX projects available on this system. Returns project IDs, titles, repo URLs, and agent slugs. Use before `delegate_crossproject` to discover project IDs.

No parameters.

### `rag_add_documents`
Embed and store a document for later semantic retrieval. The target collection is determined by `audience` rather than an explicit name — agents cannot create or address arbitrary collections.

| Param | Type | Description |
|-------|------|-------------|
| `content` | string | Text to embed and store |
| `audience` | string | `'self'` → `agent_{pubkey}` collection; `'project'` → `project_{id}` collection |
| `title` | string? | Short descriptive title |

Disabled (returns error message) when embedding is not configured (`~/.tenex/embed.json` absent). Note: the Rust implementation diverges from TypeScript — TS accepts a free-form `collection` name; Rust enforces `'self'` or `'project'` and resolves the collection internally.

### `rag_search`
Search the RAG vector store for relevant content. Always searches across all three fixed collections: `conversations`, `project_{id}`, and `agent_{pubkey}`.

| Param | Type | Description |
|-------|------|-------------|
| `query` | string | Natural-language search query |
| `limit` | integer? | Max results (default 10) |

Disabled (returns error message) when embedding is not configured.

### `kill`
Cancel a scheduled task by its task ID. Agent conversation kills and shell task kills are not available in this context — those require in-process TypeScript state (RALRegistry, CooldownRegistry, AgentDispatchService).

| Param | Type | Description |
|-------|------|-------------|
| `target` | string | Scheduled task ID (format: `task-{timestamp}-{random}`) |
| `reason` | string | Reason for cancellation |

Returns a success message on cancellation, or an error if the ID is not a scheduled task format or is not found.

### `schedule_task`
Schedule a task to run in the future. Writes to `schedules.json` via `tenex-scheduler`'s storage module using the canonical `ScheduledTask` format. The task is picked up by the `tenex-scheduler` daemon.

| Param | Type | Description |
|-------|------|-------------|
| `prompt` | string | Prompt to send to the agent when the task runs |
| `when` | string | Cron expression (e.g. `0 9 * * *`) for recurring, or relative delay (e.g. `5m`, `2h`, `1d`, `30s`) for one-off |
| `title` | string? | Human-readable title |
| `target_agent` | string? | Agent slug. Defaults to the current agent. |
| `target_channel` | string? | Conversation ID or channel for task output delivery |

Returns the task ID and execution time (one-off) or cron schedule (recurring).

### `change_model`
Override the LLM model for this agent in this conversation. Persists `meta_model_variant` to `AgentContextState` in the SQLite conversation store. Takes effect on the next invocation.

Accepts any model format: named preset from `~/.tenex/llms.json` (e.g. `fast`), `provider:model` (e.g. `anthropic:claude-haiku-4-5`), or `provider/model` (e.g. `openai/gpt-4o`). Note: unlike the TypeScript version which only accepts meta-model variant names, the Rust version accepts the full model resolution format.

| Param | Type | Description |
|-------|------|-------------|
| `model` | string | Model identifier: named preset, `provider:model`, or `provider/model` |

### `conversation_get`
Retrieve the message transcript for a conversation by ID. Reads from the project's SQLite conversation store.

| Param | Type | Description |
|-------|------|-------------|
| `conversation_id` | string | Conversation ID (64-char hex event ID) |
| `limit` | integer? | Maximum messages to return (default: all) |

Returns a plain-text transcript with `[role] author8: content` lines. Note: the TS version additionally supports `untilId`, `prompt` (LLM analysis), and `includeToolCalls` — these are not yet implemented in Rust.

### `conversation_list`
List conversations in the current project, sorted by most recent activity.

| Param | Type | Description |
|-------|------|-------------|
| `limit` | integer? | Maximum conversations to return (default: 20) |
| `from_time` | integer? | Filter: activity after this Unix timestamp (ms) |
| `to_time` | integer? | Filter: activity before this Unix timestamp (ms) |

Returns a plain-text list with short ID, title, last activity, and preview of the last user message. Note: the TS version additionally supports `projectId` (cross-project), `with` (participant filter), and returns a hierarchical tree of delegation chains — the Rust version is single-project, flat list.

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

### `no_response`
Request a silent completion for the current turn. Use only when the user's message explicitly asks for no reply (note-to-self, counting-aloud, or similar cases where an acknowledgement would be unwanted).

No parameters.

Uses `Arc<AtomicBool>::swap(true)` — idempotent: a second call detects the flag was already set and returns a "STOP — do not call this tool again" advisory instead of silently no-op'ing. After the inner rig loop ends, `main.rs` checks the flag before emitting the final `ConversationIntent` — if set, no event is published and the turn ends silently. Note: the TS implementation (in `no_response.ts`) uses a similar early-exit pattern; the Rust version is behaviorally equivalent.

### `report_publish`
Publish markdown files as NIP-23 long-form articles (kind:30023) to Nostr, signed with the agent's keys. Accepts a single file or a directory (directory walk is recursive). Path may be absolute or relative to the project root.

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | Absolute or project-relative path to a markdown file or directory |

For a single file: `d_tag` = filename, `document_tag` = file stem. For a directory: `d_tag` = `dirName/relative/path`, `document_tag` = directory name. Path-traversal protection via `canonicalize() + starts_with(project_root)`. Returns `{ success, published: [d_tags], summary }`. Each file emits a `PublishArticleIntent` (→ `Intent::PublishArticle`) over the standard NDJSON-stdout channel with tags `[d]`, `[document]`, `[a]` (project link).

### `agents_write`
Create or update a backend-local agent identity stored at `~/.tenex/agents/<pubkey>.json` through `tenex-agent-registry`. There is no SQLite and no network. The shared registry crate preserves the TS `StoredAgent` JSON shape (`nsec`, `slug`, `name`, `role`, `instructions`, `useCriteria`, `status`, `default.model`) plus unknown fields.

| Param | Type | Description |
|-------|------|-------------|
| `slug` | string | Agent slug identifier (used as the lookup key) |
| `name` | string | Display name |
| `role` | string | Role/function label |
| `instructions` | string | System instructions |
| `useCriteria` | string | Criteria for when this agent should be selected |
| `llmConfig` | string \| null | Optional model identifier; written to `default.model` |

Behavior: opens `tenex-agent-registry`, finds an existing record whose `slug` matches, and saves the normalized `AgentDoc` through the shared mutation API. If found, `nsec`, the `<pubkey>.json` filename, and unknown fields (e.g. `category`, `eventId`, `mcpServers`, `telegram`) are preserved across read-modify-write. If not found, the registry crate generates a fresh nsec, derives the pubkey, and writes `<pubkey_hex>.json` with `status = "active"`. Writes are atomic via temp-file + rename and update the installed-agent index. Returns `{ success, agent: { slug, name, pubkey } }`. Newly created agents are not assigned to the current project — that requires a 31933 event p-tagging the new pubkey.

## Supervision Heuristics

`tenex-supervision` is wired into the hook layer. It runs two kinds of checks:

**Pre-tool (blocks tool calls):**
- `WorkerTodoHeuristic` — blocks non-todo tool calls for `worker` category agents when they have pending todos and haven't created a todo list yet.

**Post-completion (can re-engage the agent):**
- `PendingTodosHeuristic` — detects completions with unresolved pending todos.
- `ConsecutiveToolsWithoutTodoHeuristic` — detects agents making many tool calls without a todo list.

When a pre-tool heuristic fires, `ToolCallHookAction::skip(reason)` is returned and the tool call is cancelled with the reason injected as a system reminder. When a post-completion heuristic fires, `Supervisor::check_post_completion` returns `PostCompletionOutcome::ReEngage { message }` — the outer `'agent_loop` in `main.rs` injects the message as a new user turn and re-runs the agent with extended history. The loop is guarded by `MAX_RETRIES = 3` in `tenex-supervision`; after that threshold it returns `Accept` unconditionally.

## Iterative Loop

Uses `rig-core`'s `Agent::stream_chat()` with projected history and an `EmitHook`. There are two loops:

**Outer loop (`'agent_loop`)** — post-completion supervision re-engagement:
1. Build system prompt from fragments via `tenex_system_prompt::build_system_prompt()` (identity → home dir → system reminders → instructions → preloaded skills → env vars → project context → agents → teams → todo guidance → category-specific → proactive RAG context).
2. Inject todo reminder into the user message if persisted todos exist.
3. Combine projected history with any `re_engage_history` accumulated from prior outer iterations.
4. Call `agent.stream_chat(current_message, history).with_hook(hook)` and drain the stream (inner loop).
5. After the inner loop completes, call `Supervisor::check_post_completion` with the current todo state.
   - `Accept` → break the outer loop normally.
   - `ReEngage { message }` → append the current user+assistant exchange to `re_engage_history`, set `current_message = message`, and repeat from step 4. Guards: `MAX_RETRIES = 3` in `tenex-supervision`.
6. Drain `recorder.take_records()` — write each captured `ToolCallRecord` to `tool_messages` via `store.record_tool_message()`. Build the matching `Vec<CtxToolCall>` slice for the assistant `TurnRecord`.
7. Save todos and self-applied skills atomically via `save_context_state`.
8. Call `tenex_context::record_turn()` to persist the user message + assistant response (assistant entry includes the captured `tool_calls` slice so projection can reconstruct paired `tool_use`→`tool_result` sequences).
9. Sign and emit the final `CompletionIntent` event with token usage from `FinalResponse`.

**Inner loop (inside `rig`)** — tool call iteration:
- `rig` sends messages to the provider, receives tool calls, executes them, feeds results back — looping until the provider returns a final text response.
- `rig` enforces `default_max_turns(25)`.
- All tools are wrapped in `RecordingTool` (via `RecordingTool::wrap_dyn`) before being handed to the agent. Every call to a wrapped tool captures `(call_id, tool_name, args_json, result_json, is_error, timestamp_ms)` into a shared `Arc<ToolRecorder>` before returning the result to `rig`. The `call_id` is a minted UUID; `rig`'s internal provider-assigned tool-use ID is not surfaced at the `ToolDyn::call` boundary.
- **Per token chunk**: `EmitHook::on_text_delta` accumulates text and emits a `StreamTextDeltaIntent` (kind:24135) per chunk with a monotonic `sequence` counter.
- **Before each tool call**: `EmitHook::on_tool_call` runs pre-tool supervision checks. If blocked, returns `skip(reason)`. Otherwise emits a `ToolUseIntent` event (except `delegate`, which emits its own).
- **After each LLM turn**: `EmitHook::on_stream_completion_response_finish` resets the delta counter and swaps the pending `ConversationIntent` — intermediate turns are emitted immediately; the final turn is held and emitted by `main.rs` after the stream ends (with `FinalResponse` usage attached).

## Model Resolution

Resolution order (applied after reading any `meta_model_variant` override from `AgentContextState`):

1. If raw model is absent, `"default"`, or `""` — use the `default` key from `~/.tenex/llms.json`, falling back to `anthropic/claude-sonnet-4-6`.
2. Look up raw model in the named `configurations` map in `~/.tenex/llms.json`.
3. Parse `provider/model` inline format (slash). Recognized providers: `anthropic`, `openai`, `openrouter`, `ollama`, `groq`, `mistral`. **Checked before colon format** to correctly handle Ollama IDs like `ollama/mistral:latest`.
4. Parse `provider:model` inline format (colon, legacy TENEX style).
5. Fall back: treat the whole string as a model name with `anthropic` as provider.

API keys are resolved from provider-specific env vars (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, etc.) then from `~/.tenex/providers.json`. Ollama uses `OLLAMA_API_BASE_URL` or the `baseUrl`/`apiKey` field in `providers.json` as the base URL (no API key).

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
| `tenex-project` | File-backed project view: project event metadata plus member-agent JSON projections |
| `tenex-agent-registry` | Global installed-agent registry JSON records and indexes |
| `tenex-conversations` | Conversation SQLite store (todos + self-applied skills via `AgentContextState`) |
| `tenex-context` | Conversation history projection (compaction/decay/reminders); `record_turn` write-back |
| `tenex-mcp` | Runtime-provided MCP tool manifest and call frame types |
| `tenex-system-prompt` | System prompt assembly (`build_system_prompt`); `InjectedFile`, `HomeDirectoryInfo` types |
| `tenex-rag` | RAG: SQLite vector store + embedding client |
| `tenex-supervision` | Heuristic pre-tool and post-completion checks; `AgentCategory` enum |
| `tenex-llm-config` | Provider credential resolution |

## Future Work (not yet implemented)

- **TS-only tools**: `send_message`, MCP resource/subscription tools (`mcp_list_resources`, `mcp_resource_read`, `mcp_subscribe`, `mcp_subscription_stop`), RAG subscription tools (`rag_subscription_create/delete/get/list`), RAG collection management tools (`rag_collection_create/delete/list`).
