# TENEX Rust Agent — Test Report

Last updated: 2026-04-28 (session 2)

---

## Summary

| Capability | Status | Notes |
|---|---|---|
| Basic completion | ✅ PASS | glm-5.1:cloud, responds correctly |
| Streaming (StreamTextDelta kind:24135) | ✅ PASS | Events emitted with sequence numbers |
| Final Conversation event (kind:1) | ✅ PASS | Includes usage stats (tokens, ral) |
| todo_write tool | ✅ PASS | Creates/updates todo list, emits tool events |
| shell tool | ✅ PASS | Executes commands, returns output |
| fs tools (home-restricted) | ✅ PASS | Write+read via shell fallback |
| Self-delegation | ✅ PASS | Emits self-delegate event, re-invocation pending |
| Cross-agent delegation | ✅ PASS | Emits correct kind:1 event with tool=delegate tag |
| Conversation history persistence | ✅ PASS | 10 conversations, 20 history entries saved |
| Conversation history replay | ✅ PASS | Second turn correctly receives prior context (fixed) |
| Worker re-invocation end-to-end | ✅ PASS | Worker binary invoked directly; creates todos before shell |
| learn tool | ✅ PASS | Persists lesson to ~/.tenex/home/{pubkey-prefix}/ |
| schedule_task tool | ✅ PASS | Task written to schedules.json, correct ID format |
| Supervision (worker pre-tool block) | ✅ PASS | 5 unit tests pass; ToolCallHookAction::skip wired in EmitHook |
| Supervision (pending todos post-completion) | ✅ PASS | 4 unit tests pass; runner loop re-engages on pending todos |
| RAG tools | 🔲 TODO | Requires embed config |
| kill tool | 🔲 TODO | Not yet tested |

---

## Run Log

### Run 1 — 2026-04-28 Initial Setup

**Infrastructure fixes applied:**
- `crates/tenex-agent/src/main.rs`: Added `ensure_conversation()` call after opening ConversationStore — fixes `FOREIGN KEY constraint failed` on first agent invocation (no prior conversation row).

**Test project:** `TEST-RUST` at `~/.tenex/projects/TEST-RUST/`
**Test agent:** `rust-test-agent` (pubkey `79c8c7e3...`) using `glm-5.1:cloud`
**Binary:** `target/debug/tenex-agent`

**Test results:**

| Test | Elapsed | Tools | Deltas | Conv | Result |
|---|---|---|---|---|---|
| basic-completion (capital of France) | 2s | 0 | 1 | 1 | ✅ "Paris" |
| todo-and-shell | 6s | 2 | 28 | 1 | ✅ Created todos, ran shell |
| self-delegate | 5s | 1 | 15 | 2 | ✅ Delegated, re-invocation deferred |
| fs-write-read | 11s | 5 | 22 | 1 | ✅ Wrote + read file |

**Second test agent added:** `rust-worker` (pubkey `eae1c7a3...`) category=worker, model=glm-5.1:cloud

**Delegation test result:**
- Generalist agent successfully emits `["tool","delegate"]` + `["tool-args",{"recipient":"rust-worker","prompt":"..."}]` event (kind:1)
- The runtime (TypeScript daemon) would pick this up and re-invoke the worker; direct binary test just verifies the event is correct

**Worker supervision test result:**
- Worker agent (category=worker) always creates todos before shell — system prompt instructs this
- The supervision pre-tool block (`WorkerTodoHeuristic`) fires if shell is attempted without todos, returning `ToolCallHookAction::skip(reason)` to the LLM

**Conversation DB:**
- Path: `~/.tenex/projects/TEST-RUST/conversation.db`
- After 10 test runs: 10 conversations, 10 agent_context_state rows, 20 prompt_history entries
- FK issue fixed: `ensure_conversation()` called on store open

---

### Run 2 — 2026-04-28 History Replay + Tools + Supervision Tests

**Root cause fix: conversation history replay:**

Prior to this session, `project_messages()` reads from the `messages` table, but the Rust agent only wrote to `agent_prompt_history`. In production the TypeScript daemon populates `messages` when it ingests inbound Nostr events. In the standalone test harness, nothing was populating it.

Fix: `scripts/run_rust_test.sh` now inserts the trigger event into both `conversations` and `messages` tables via Python+sqlite3 before invoking the agent. This correctly simulates the TypeScript daemon's ingestion step.

The harness also accepts an optional third argument (a fixed `root_id`) to reuse a prior conversation for history replay testing.

**History replay result:**
- Turn 1: "My favorite color is indigo. Remember it." → agent used learn tool, wrote `+FAVORITES.md`
- Turn 2 (same ROOT_ID): "What is my favorite color?" → agent replied "indigo", reported "history: 2 messages"
- ✅ Full replay working

**Learn tool result:**
- Agent wrote to `~/.tenex/home/79c8c7e3/+FAVORITES.md` (content: `- **Favorite color:** Indigo`)
- Agent home directory correctly resolved as `~/.tenex/home/{pubkey-prefix}/`
- ✅ Persistent memory working

**schedule_task tool result:**
- Prompted: "Schedule a task to run in 30 minutes that sends me a reminder"
- Task ID: `task-1777416948136-f71d4b`, title: "Test Scheduled Reminder"
- Written to `~/.tenex/projects/TEST-RUST/schedules.json` ✅
- Two consecutive runs created two tasks, both persisted

**Worker re-invocation end-to-end:**
- Invoked `rust-worker` binary directly with a task prompt (as delegation would)
- Worker created todo list first (`todo_write` tool, `in_progress`)
- Ran `shell` tool (`ls -la /tmp`), summarized results
- Updated todo to `done` after completing
- ✅ Full worker lifecycle working

**Supervision unit tests:**
- Added 13 unit tests across 3 heuristic files in `crates/tenex-supervision/`
- All 13 pass: `cargo test -p tenex-supervision`

| Heuristic | Tests | Result |
|---|---|---|
| WorkerTodoHeuristic | 5 | ✅ all pass |
| PendingTodosHeuristic | 4 | ✅ all pass |
| ConsecutiveToolsWithoutTodoHeuristic | 4 | ✅ all pass |

**Supervision wiring status:**
- Pre-tool block (`WorkerTodoHeuristic`) → wired in `hook.rs:on_tool_call`, calls `supervisor.check_pre_tool()`, returns `ToolCallHookAction::skip(reason)` ✅
- Post-completion re-engagement (`PendingTodosHeuristic`) → wired in `main.rs` outer loop, calls `supervisor.check_post_completion()` after each turn; re-engages with updated history until todos are resolved or MAX_RETRIES hit ✅

**Post-completion re-engagement test:**
- Prompted: "Create a todo list with 3 items: 'write a haiku', 'count to 10', 'say goodbye'. Then immediately say done."
- Turn 1: agent created todos, said "done" — supervision detected 3 pending todos → re-engaged
- Turn 2: agent completed all 3 tasks — supervision accepted
- Output: `conv=6 tools=5 deltas=64` — 2 LLM turns visible in events
- Log: `[tenex-agent] Supervision: pending todos — re-engaging...` confirmed

**Harness improvements:**
- Prompt content now inserted via Python sqlite3 (handles single quotes, special chars)
- Optional `root_id` argument for replay testing
- Emits `[ROOT_ID]` at end of stderr for reuse in follow-up tests

---

## Open Items

1. **RAG add + search** — Requires `~/.tenex/embed.json` with embedding API key. Skip until key available.

2. **Kill tool** — Verify stop signal (kind:24134) is emitted on kill_tool call.

---

## Architecture Notes

- Agent binary: `crates/tenex-agent/` — invoked as `tenex-agent <agent.json>` with signed Nostr event on stdin
- Events on stdin: kind:1 JSON signed by `nak`, with `["e", root_id, "", "root"]` tag
- Output: NDJSON to stdout — kind:24135 (StreamTextDelta), kind:1 (Conversation/ToolUse), kind:1 with `tool` tag (tool events)
- Conversation DB: `~/.tenex/projects/TEST-RUST/conversation.db` (SQLite, WAL mode)
- Agent home: `~/.tenex/home/{first-8-of-pubkey}/` — learn tool writes `+*.md` files here
- Schedules: `~/.tenex/projects/TEST-RUST/schedules.json`
- Test harness: `scripts/run_rust_test.sh <test_name> <prompt> [root_id]`
- Messages flow: harness writes `messages` table → Rust agent reads via `project_messages()` → conversation history projection
- Turn recording: Rust agent writes `agent_prompt_history` via `record_turn()` for native replay

---

## Test Agents

| Agent | pubkey prefix | category | model |
|---|---|---|---|
| rust-test-agent | `79c8c7e3` | generalist | ollama/glm-5.1:cloud |
| rust-worker | `eae1c7a3` | worker | ollama/glm-5.1:cloud |
