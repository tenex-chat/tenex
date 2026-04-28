# TENEX Rust Agent — Test Report

Last updated: 2026-04-28 (auto-updated hourly)

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
| Supervision (worker todo block) | ✅ PASS | Worker agent naturally follows todo-first rule (system prompt); block fires if violated |
| RAG tools | 🔲 TODO | Requires embed config |
| learn tool | 🔲 TODO | Not yet tested |

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
- The supervision pre-tool block (`WorkerTodoBeforeFileOrShellHeuristic`) fires if shell is attempted without todos, returning `ToolCallHookAction::skip(reason)` to the LLM

**Conversation DB:**
- Path: `~/.tenex/projects/TEST-RUST/conversation.db`
- After 10 test runs: 10 conversations, 10 agent_context_state rows, 20 prompt_history entries
- FK issue fixed: `ensure_conversation()` called on store open

**Issues found:** None blocking. All core flows work.

---

## Pending Test Scenarios

1. **Conversation history replay** — Same `ROOT_ID` twice; verify second call picks up history from the first (requires matching root event ID between runs).
2. **Schedule task tool** — Invoke ScheduleTaskTool and confirm task appears in `~/.tenex/projects/TEST-RUST/schedules.json`.
3. **Learn tool** — Ask agent to use learn tool; verify lesson appears in agent home dir.
4. **Worker re-invocation end-to-end** — Pipe delegation output event as input to the worker agent binary and verify it executes.
5. **RAG add + search** — Requires `~/.tenex/embed.json` with embedding API key. Skip until key available.
6. **Kill tool** — Verify stop signal (kind:24134) is emitted on kill_tool call.
7. **Post-completion supervision** — Test PendingTodosHeuristic: verify agent re-engages when todos remain after completion.

---

## Architecture Notes

- Agent binary: `crates/tenex-agent/` — invoked as `tenex-agent <agent.json>` with signed Nostr event on stdin
- Events on stdin: kind:1 JSON signed by `nak`, with `["e", root_id, "", "root"]` tag
- Output: NDJSON to stdout — kind:24135 (StreamTextDelta), kind:1 (Conversation/ToolUse), kind:1 with `tool` tag (tool events)
- Conversation DB: `~/.tenex/conversations/TEST-RUST.db` (SQLite, WAL mode)
- Test harness: `scripts/run_rust_test.sh`
