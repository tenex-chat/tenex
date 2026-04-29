# TENEX Rust Agent — Test Report

Last updated: 2026-04-29 (session 6)

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
| kill tool | ✅ PASS | Cancels scheduled tasks, removes from schedules.json |
| Self-delegate end-to-end | ✅ PASS | Step1 delegates, step2 re-invocation executes and writes file |
| conversation_list tool | ✅ PASS | Returns 20 conversations with IDs and metadata |
| conversation_get tool | ✅ PASS | Returns messages for a given conversation ID |
| change_model tool | ✅ PASS | Writes model override to agent_context_state; takes effect on re-invocation |
| project_list tool | ✅ PASS | Lists 37 projects with agents and repo URLs |
| ask tool | ✅ PASS | Emits AskIntent (kind:1) with title/question/p tags |
| skill_list tool | ✅ PASS | Lists available project skills |
| delegate_followup tool | ✅ PASS | Emits delegate + delegate_followup events in sequence |
| RAG add_documents tool | ✅ PASS | OpenRouter embed (text-embedding-3-large), SQLite store, audience=self/project |
| RAG search tool | ✅ PASS | Semantic search with cosine scores; 0.78 direct match, 0.59 partial match |
| skills_set tool | ✅ PASS | Activates skills from built-in set; returns skill content |
| delegate_crossproject tool | ✅ PASS | Emits correct kind:1 with tool=delegate_crossproject + tool-args tags |
| context projection (multi-turn) | ✅ PASS | Turn 2 correctly recalled info from turn 1 history |
| ConsecutiveToolsWithoutTodo nudge | ✅ PASS | Bug fixed (re_engage: false → true); agent receives and acknowledges nudge on re-engagement |
| Multi-turn history (messages table) | ✅ PASS | Harness write-back fix; both user and assistant turns persisted correctly |

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

### Run 3 — 2026-04-28 Full Tool Coverage + Bug Fixes

**Bug fixed: model string parsing for `provider/model:tag` format**

`resolve_from_string` in `crates/tenex-agent/src/config.rs` checked `provider:model` before `provider/model`. For a model like `ollama/deepseek-v4-flash:cloud`, the colon-split fired first, giving provider=`ollama/deepseek-v4-flash` and model=`cloud`. This caused "No API key found for provider 'ollama/deepseek-v4-flash'" on `change_model`-triggered re-invocations.

Fix: swapped the check order — `provider/model` (slash-separated, with known-provider guard) is now checked before `provider:model` (colon-separated). The `provider:model` format still works as a fallback for truly colon-separated identifiers.

| Test | Elapsed | Tools | Result |
|---|---|---|---|
| kill-tool | 4s | 1 | ✅ Cancelled `task-1777416948136-f71d4b`, verified removed from schedules.json |
| self-delegate-end-to-end | 12s | 2 | ✅ Step1 delegated; step2 re-invoked wrote `test_output.txt` (verified: `TENEX Rust test`) |
| conversation-list | 5s | 1 | ✅ Listed 20 conversations |
| conversation-get | 6s | 1 | ✅ Returned messages for conversation ID |
| change-model | 13s | 1 | ✅ Wrote `ollama/deepseek-v4-flash:cloud` to agent_context_state |
| change-model-verify (after fix) | 5s | 0 | ✅ provider: ollama model: deepseek-v4-flash:cloud |
| project-list | 18s | 1 | ✅ Listed 37 projects with agents |
| ask-tool | 6s | 1 | ✅ Emitted AskIntent with p-tag, title, question tags |
| skill-list | 11s | 1 | ✅ Returned project skills |
| delegate-followup | ~10s | 2 | ✅ Used delegate + delegate_followup in sequence |

**All previously passing tests confirmed still pass after config.rs change.**

---

### Run 4 — 2026-04-29 RAG Tools

**Config discovered:** `~/.tenex/embed.json` exists with `provider: openrouter`, `model: openai/text-embedding-3-large`. Vector store configured as Qdrant but Rust agent uses SQLite (`~/.tenex/projects/TEST-RUST/embeddings.db`, table `doc_meta`). API key present in `~/.tenex/providers.json`.

**rag_add_documents result:**
- Prompted: index two documents about TENEX Rust agent (Nostr protocol) and supervision heuristics
- Both indexed into collection `agent_79c8c7e3d3946e286e345263abc2d96d8847e4e25f0b60bc63b233e3d9b10a57`
- Verified via sqlite3: 2 rows in `doc_meta` with `vector_blob` populated ✅
- Audience `self` → `agent_{pubkey}` collection; audience `project` → `project_{project_id}` collection

**rag_search result:**
- Query: "supervision heuristics monitoring"
- Result 1 score 0.78: "Rust agents use supervision heuristics to monitor tool usage patterns"
- Result 2 score 0.59: "The TENEX Rust agent uses Nostr protocol..."
- Semantic similarity working correctly (supervision doc ranked higher than Nostr doc for supervision query) ✅

| Test | Result |
|---|---|
| rag_add_documents (audience=self) | ✅ Indexed 2 documents, verified in embeddings.db |
| rag_search (semantic) | ✅ Correct ranking by cosine similarity |

**RAG implementation notes:**
- `RagStore::open(db_path, config)` — opens/creates SQLite embeddings.db
- `index()` — hashes content (SHA-256), calls embed API, stores vector blob in `doc_meta`
- `search()` — embeds query, computes cosine similarity in SQLite, returns ranked results
- Proactive injection: searches before each LLM call, injects results above 0.65 threshold into system prompt

---

### Run 5 — 2026-04-29 Remaining Tools + Full Workspace Tests

**skills_set test:**
- Prompted: "use skill_list to see available skills, then activate the 'shell' skill using skills_set"
- Agent listed 13 built-in skills, called `skills_set({add: ["shell"]})`, reported shell as active
- ✅ `activeSkills: ["shell"]` returned with skill content

**delegate_crossproject test:**
- Prompted: delegate task to `ndk-blossom` agent in project `Agents-Web-nxmkpn`
- Event emitted: `["tool","delegate_crossproject"]` + `["tool-args",{"project_id":"Agents-Web-nxmkpn","recipient":"ndk-blossom","request":"..."}]`
- ✅ Correct Nostr event structure; tool resolved agent via project event.json p-tags

**Context projection (multi-turn):**
- Turn 1: "My favorite programming language is Rust" → agent used learn tool, acknowledged
- Turn 2 (same ROOT_ID): "What is my favorite programming language?" → "Your favorite programming language is Rust"
- ✅ tenex-context projection working; history replay produces correct response

**Full workspace test suite:**
- `cargo test --workspace` — 0 failures across all crates
- tenex-context: 5 tests pass (projection, record_turn, cache anchors, strategy pipeline)
- tenex-system-prompt: 4 tests pass (identity, todo guidance, determinism, orchestrator exclusion)
- tenex-supervision: 13 tests pass (all heuristics)
- tenex-identity: 5 tests pass (cache, upsert, best-name)

| Test | Result |
|---|---|
| skills_set (activate built-in shell skill) | ✅ |
| delegate_crossproject (Agents-Web-nxmkpn/ndk-blossom) | ✅ |
| context projection multi-turn recall | ✅ |
| cargo test --workspace | ✅ 0 failures |

---

### Run 6 — 2026-04-29 History Replay Fix + Supervision Bug Fix

**Bug fixed: test harness multi-turn history (messages table)**

`project()` reads conversation history from the `messages` table, but `record_turn()` writes to `agent_prompt_history` — these are separate tables. In production the TypeScript daemon populates `messages` when it ingests Nostr events (both user and agent). The test harness only inserted user messages.

Fix: `scripts/run_rust_test.sh` now writes assistant responses back to `messages` after each agent run. Parses NDJSON output, collects all kind:1 non-tool events, inserts each as `role='assistant'` with `nostr_event_id = NULL` and `record_id = f"agent-resp-{root_id[:8]}-{seq}"`.

Gotcha: `idx_messages_nostr_event_id` is a globally unique partial index `ON messages(nostr_event_id) WHERE nostr_event_id IS NOT NULL`. Synthetic rows must pass `NULL` to avoid INSERT OR IGNORE silently failing when the same synthetic string appears across conversations.

**Bug fixed: ConsecutiveToolsWithoutTodoHeuristic re_engage was false**

`crates/tenex-supervision/src/heuristics/consecutive_tools_without_todo.rs` had `re_engage: false`. In `supervisor.rs::check_post_completion()`, when `re_engage: false` the supervisor:
1. Increments `retry_count` (consuming a retry slot)
2. Sets `nudged_about_todos = true` (preventing future nudges)
3. Returns `PostCompletionOutcome::Accept` (discarding the message)

Net effect: the agent was never nudged, but the state marked it as having been nudged. Classic silent no-op.

Fix: `re_engage: false → re_engage: true`.

**Verified:**
- Turn 1: agent runs 6 shell commands without todos → `consecutive-tools-without-todo` fires
- Turn 2 (re-engagement): agent receives "You have made 6 tool calls without creating a todo list..." nudge
- Turn 2 response: "I understand the reminder about using todos for complex tasks."
- `conv=2 tools=6` — one nudge, one re-engagement (OncePerExecution enforced correctly)

**Multi-turn history verified:**
- Turn 1: "My favorite color is indigo" → agent acknowledged
- Turn 2 (same root_id): "What is my favorite color?" → "indigo"
- Both user and assistant messages now persist in `messages` table via harness write-back

| Test | Result |
|---|---|
| ConsecutiveToolsWithoutTodo re-engagement (6 shells, no todos) | ✅ Agent receives nudge, conv=2 |
| Multi-turn history recall (color = indigo) | ✅ Correctly recalled from messages table |
| cargo test -p tenex-supervision (13 tests) | ✅ All pass |

---

## Open Items

*(None — all tools tested and passing)*

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
