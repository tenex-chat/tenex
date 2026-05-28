# Single Source of Truth: Storage Is The Message Array

## Architecture Invariant

**Stored events are the immutable timeline. `messages[]` is the pure
deterministic output of `tenex_context::project(store, conv_id, agent_pubkey, …)`.**

Projection strategies (compaction, decay, reminders, proactive context, active
tool/shell reminders) produce overlays *as part of projection*. Overlays are
not a violation of the invariant; they are the projection layer doing its job.

The agent runner never bypasses the projection layer. There is no in-memory
tail, no splice, no walker. Every byte the LLM sees that is not the system
prompt comes from `project()` reading the conversation store.

System prompt is a pure function of `(agent config, project, conversation_id)`
and is *stable across invocations* so prompt cache works.

## Bugs This Fixes

| Bug | Symptom | Root cause |
| --- | --- | --- |
| A | Re-delegation infinite loop. On delegation callback agent re-runs `delegate(agent2)` after agent2's reply lands. | `step_start` splice puts in-memory `re_engage_tail` *before* prior-turn step rows. The agent reads its own stale tool calls as a response to the nudge. |
| B | "Your original task was: **Black**…" semantic nonsense in supervision nudge. | `triggering_message` on the delegation-callback envelope is the delegatee's reply, not the original task. |
| C | Cache hit rate 0 across 11 spans (~100K tokens reprocessed). | Proactive context (RAG output) appended to `system_prompt` invalidates the cacheable prefix. |
| D | `append_message` `MAX(sequence)+1` outside a transaction → sequence collision under concurrent writers. | Read-modify-write race in `store.rs:383`. |
| E | If supervision nudges become user-role rows, `apply_message_to_header` corrupts the conversation list's `last_user_message` header by overwriting it with internal supervision text. | `apply_message_to_header` updates the header on every `role=user` insert. |

## Back-Channels Being Deleted

Every in-memory artifact that bypasses projection today, with file:line citations:

1. **`re_engage_tail: Vec<CtxMessage>`** — `crates/tenex-agent/src/turn_loop/mod.rs:41`, populated at `mod.rs:509`, threaded into `run_step_loop` at `mod.rs:142,175,193,211,279,311`.
2. **`in_turn_tail`** assembled inside the step loop — `crates/tenex-agent/src/turn_loop/step.rs:73-76,94,121,144,168,202` and the matching params on `run_provider_step`.
3. **`step_start` splice** — `crates/tenex-context/src/projection.rs:47,54,122,134,200` (return value) and `crates/tenex-context/src/lib.rs:104-119` (the `split_off`/`extend`/`extend` block).
4. **`excluded_event_id`** filter — `crates/tenex-context/src/projection.rs:54,59` and threaded from `crates/tenex-agent/src/turn_loop/step/projection.rs:36` (`Some(boot.trigger_event_id.clone())`).
5. **`live_prompt_index` / `is_live_prompt` walker** — `crates/tenex-agent/src/turn_loop/step/projection.rs:51-69`. Locates the trigger user message that was *also* in the in-memory tail and overwrites it with the rig `turn_prompt` so multipart image content takes effect.
6. **`envelope_image_parts`** field on `AgentBootstrap` — `crates/tenex-agent/src/agent_bootstrap/mod.rs:55,507-509,524`. Fetched once at bootstrap and replayed as `RigMessage::User { multipart }` at `turn_loop/mod.rs:63-86`.
7. **`envelope_content`** field on `AgentBootstrap` — `agent_bootstrap/mod.rs:57,418,525`. Used as `triggering_message` for the supervisor (Bug B).
8. **`user_message`** field on `AgentBootstrap` — `agent_bootstrap/mod.rs:54,368-374,522`. The text the agent runner replays as the live prompt.
9. **`trigger_event_id`** field on `AgentBootstrap` — `agent_bootstrap/mod.rs:54,198-200,523`. Used as `excluded_event_id`.
10. **Proactive context concatenated onto `system_prompt`** — `agent_bootstrap/mod.rs:427-438` (`system_prompt.push_str(&block)`); also active-tool reminder at `:441-444` and active-shell-task reminder at `:446-451` (these last two are out of scope for this refactor — see §Out-of-scope).
11. **`current_message`** / `turn_message` / `turn_prompt` / `turn_text` plumbing — `turn_loop/mod.rs:40-86,142,175,193,211,279,311` and `turn_loop/step.rs:61-95,143,174,191,224,253,257-260`.
12. **`is_live_prompt` heuristic** — alias for the walker in §5.
13. **`conv_store.is_none()` branches** — `turn_loop/step.rs:79,154,167-169,188-203`. After this refactor, the agent runner always has a store (in-memory or on disk); these branches collapse.

`MessageInjectionTracker.take_new_messages()` (`turn_loop/mod.rs:52-57`) is preserved — the runtime already persists inbound mid-turn user messages before the tracker fires, so the next `project()` reads them naturally; the tracker's `take_new_messages()` call becomes a buffer-clear with no concatenation.

## New Shapes

### `tenex_context::project()` signature

`ProjectionOptions` is **deleted**. Compaction override becomes a direct parameter. One projection entry point.

```rust
pub async fn project(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    system_prompt: &str,
    model_profile: &ModelProfile,
    tool_defs: &[ToolDef],
    summarizer: Option<Arc<dyn CompactionSummarizer>>,
    name_resolver: Option<&dyn DisplayNameResolver>,
    proactive_context: Option<String>,     // NEW
    compaction_override: Option<CompactionOverride>,
) -> anyhow::Result<Projection>;
```

`project_with_options` is deleted.

### `projection::project_messages` signature

```rust
pub(crate) fn project_messages(
    store: &ConversationStore,
    conversation_id: &str,
    agent_pubkey: &str,
    system_prompt: &str,
    name_resolver: Option<&dyn DisplayNameResolver>,
) -> anyhow::Result<Vec<Message>>;   // no step_start, no excluded_event_id
```

The `step_start` return is deleted. The splice block in `lib.rs:104-119` is deleted.

### `Message::User` variant — carries attachments

```rust
pub enum Message {
    System { content: String },
    User {
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<ImageAttachment>,
    },
    Assistant { … },
    ToolResult { … },
}

pub struct ImageAttachment {
    pub media_type: String,
    pub data: Vec<u8>,
    pub source_url: Option<String>,
}
```

`ctx_msg_to_rig` reads `attachments` and emits multipart `RigMessage::User` content `[Image…, Text]` (matching today's order from `turn_loop/mod.rs:67-83`).

### New `ProactiveContext` strategy

```rust
// crates/tenex-context/src/strategies/proactive.rs
pub struct ProactiveContextStrategy;

#[async_trait]
impl Strategy for ProactiveContextStrategy {
    fn name(&self) -> &'static str { "proactive_context" }
    async fn apply(&self, ctx: &mut ProjectionContext<'_>) -> anyhow::Result<()> {
        let Some(block) = ctx.proactive_context.as_deref() else { return Ok(()); };
        if block.is_empty() { return Ok(()); }
        let Some(target) = ctx.messages.iter_mut().rev()
            .find(|m| !matches!(m, Message::System { .. })) else { return Ok(()); };
        match target {
            Message::User { content, .. }
            | Message::Assistant { content, .. }
            | Message::ToolResult { content, .. } => {
                content.push_str("\n\n");
                content.push_str(block);
            }
            _ => {}
        }
        ctx.telemetry.strategies_applied.push("proactive_context".to_string());
        Ok(())
    }
}
```

`ProjectionContext` gains `proactive_context: Option<&'a str>`.

Stack order: `compaction → decay → proactive_context → reminders`.

The block is computed **once at bootstrap**; the same string is threaded into every step's `project()` call. Same input → same overlay → cacheable for the duration of one invocation.

### Schema migration v2 — `message_attachments` sidecar table

```sql
CREATE TABLE message_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    data BLOB NOT NULL,
    source_url TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(message_id, ordinal),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX idx_message_attachments_message
    ON message_attachments(message_id);
```

`EXPECTED_SCHEMA_VERSION` bumps to 2.

`NewMessage` unchanged. New `record_attachment` and `list_attachments_by_message_ids` APIs on `ConversationStore`.

### `append_message` transaction wrapping

`BEGIN IMMEDIATE` claims the write lock; the `MAX(sequence)` read and the `INSERT` are now serialized.

### `last_user_message` header guard

Gate on `message_type == "text"`. Supervision nudges use `message_type = "supervision"`; the header update skips them. No author-pubkey or record_id matching needed.

### Deterministic `record_id` for step assistants

Agent owns the signing keys. Compute the Nostr event_id pre-publish via `EventBuilder::new(Kind::TextNote, &content).tags(...).build(pubkey).id`. Use that hex as both `record_id` and `nostr_event_id`. Outbound publish's later `append_message` becomes a no-op via the existing `find_message_id_by_event` idempotency check.

For non-terminal steps that never get a Nostr event, `record_id = format!("step:{}:{}:{}", boot.execution_id, agent_pubkey, step_index)` where `execution_id` comes from `TENEX_EXECUTION_ID`. Collision-safe across invocations (different execution_id) and within (different step_index).

### Supervision-nudge persistence

| Property | Value |
| --- | --- |
| Writer | `run_turn_loop` after `check_post_completion` returns `InjectMessage` or `ReEngage`. |
| `author_pubkey` | The agent's own pubkey. |
| `message_type` | `"supervision"` (new). |
| `role` | `"user"`. |
| `record_id` | `format!("supervision:{}:{}", execution_id, nudge_seq)` |
| `nostr_event_id` | `None`. Not published. |

Internal supervision mechanics stay internal. Other readers see the agent's response, not the loop's prod hooks.

### `AgentBootstrap` field changes

```diff
 pub(crate) struct AgentBootstrap {
     pub channel: Arc<dyn Channel>,
-    pub conv_store: Option<ConversationStore>,
+    pub conv_store: ConversationStore,
     pub conversation_id: String,
     pub pubkey_hex: String,
     pub agent_slug: String,
     pub project_id: String,
+    pub execution_id: String,
     pub base_dir: std::path::PathBuf,
     pub resolved: ResolvedModel,
     pub cassette_recorder: Option<CassetteRecorder>,
     pub system_prompt: String,
-    pub user_message: String,
-    pub trigger_event_id: String,
-    pub envelope_image_parts: Option<Vec<rig_core::completion::message::UserContent>>,
-    pub envelope_content: String,
+    pub original_task: String,
+    pub proactive_context: Option<String>,
     pub tool_set: ToolSet,
     ...
 }
```

`original_task` = content of the first `role=user` message in the conversation whose `record_id` matches the conversation-root event. Looked up once.

### Bootstrap responsibilities (new)

Runtime persists the trigger event before spawn (`dispatch_pipeline.rs:229,370`, `event_routing.rs:115`). Bootstrap does **not** write a trigger row. Sequence:

1. Read envelope from stdin (for routing metadata).
2. Open conversation store. Trigger row already exists.
3. `find_message_id_by_event(envelope.event_id)` → must be `Some` (runtime invariant).
4. If provider supports vision: scan content for image URLs, fetch, `record_attachment(trigger_row_id, ordinal, …)` for each.
5. Compute `proactive_context` block via RAG. Store on struct. Do not mutate `system_prompt`.
6. Compute `original_task` from conversation root. Store on struct.

### Turn loop (new)

```rust
pub(crate) async fn run_turn_loop(boot: &mut AgentBootstrap) -> Result<()> {
    let mut nudge_seq: u64 = 0;

    'agent_loop: loop {
        boot.suppress_response.store(false, Ordering::Release);
        boot.injection_tracker.lock().unwrap().take_new_messages();  // clear buffer

        let recorder = ToolRecorder::new();
        let tool_registry = boot.tool_set.build_for_turn(recorder.clone());
        let final_response = run_step_loop(boot, &tool_registry, recorder.clone()).await?;
        record_accounting(boot, &final_response).await;

        let outcome = {
            let mut sup = boot.supervisor_ref.lock().unwrap();
            sup.check_post_completion(
                snapshot_todos(boot),
                usize::from(boot.emit_state.has_pending_external_work()),
                boot.original_task.clone(),
            )
        };

        match outcome {
            PostCompletionOutcome::Accept => {
                emit_terminal(boot, final_response).await?;
                break 'agent_loop;
            }
            PostCompletionOutcome::InjectMessage { message }
            | PostCompletionOutcome::ReEngage { message } => {
                record_supervision_nudge(boot, &boot.conv_store, nudge_seq, &message)?;
                nudge_seq += 1;
                if matches!(outcome, PostCompletionOutcome::InjectMessage { .. }) {
                    emit_terminal(boot, final_response).await?;
                    break 'agent_loop;
                }
                // ReEngage: next iteration's project() reads the nudge as a normal user message.
            }
        }
    }
    Ok(())
}
```

`run_step_loop` no longer takes `turn_prompt`/`turn_text`/`prefix_tail`. Inside, every step calls `tenex_context::project()` directly.

## Order of Implementation

| Step | Description | Breaking? |
| --- | --- | --- |
| 1 | Schema v2: `message_attachments` table + index. Wrap `append_message` in `BEGIN IMMEDIATE`. Add `record_attachment`, `list_attachments_by_message_ids` APIs. No callers changed. | no — additive |
| 2 | Bootstrap fetches images and writes attachments. `envelope_image_parts` still threaded through `turn_prompt`. Dual write. | no |
| 3 | `Message::User` gains `attachments`. `project_messages` loads via `list_attachments_by_message_ids`. `ctx_msg_to_rig` builds multipart. Delete `live_prompt_index` walker (it's now a no-op because projection produces the same shape). | no |
| 4 | `apply_message_to_header` guards on `message_type == "text"`. | no — no `"supervision"` rows yet |
| 5 | Bootstrap reads `original_task` from conversation root. Supervisor call uses `boot.original_task` instead of `boot.envelope_content`. Fixes Bug B. | no |
| 6 | New `ProactiveContextStrategy`. `ProjectionContext.proactive_context`. `boot.proactive_context` computed at bootstrap. `agent_bootstrap` stops appending the block to `system_prompt`. Fixes Bug C. | no |
| 7 | `record_step_assistant` always writes; for terminal steps, compute deterministic event_id pre-publish and use as `record_id` + `nostr_event_id`. Outbound writeback becomes a no-op via idempotency. | no |
| 8 | Add `record_supervision_nudge`. Delete `re_engage_tail` and the `current_message = message` assignment on re-engagement. Keep `turn_prompt`/`turn_text` plumbing for the original trigger only. Fixes Bug A's wrong-position symptom. | no |
| 9 | Drop the splice: delete `in_turn_tail`, `step_start`, `excluded_event_id`. Collapse `project_with_options` into `project`. Trigger now comes from storage via projection. `conv_store` no longer `Option`. Delete `conv_store.is_none()` branches. | **yes** — projection sequence changes (no cassettes in repo, no impact) |
| 10 | Delete `user_message`, `trigger_event_id`, `envelope_content`, `envelope_image_parts`, `prepare_envelope_image_parts`, `compose_user_message`, `is_live_prompt`. Dead-code only. | no |

## Test Strategy

Integration tests at `crates/tenex-agent/tests/projection_integration.rs` (new). Use `ConversationStore::open_in_memory()` + `mock_llm`. No cassettes — assertions on exact `messages[]` arrays.

### Test 1 — single-agent multi-turn
Trigger `"What's 2+2?"`. Step 1 emits `"4"` terminal. Assert projections before/after step.

### Test 2 — delegation flow (Bug A repro)
Mirrors https://jaeger.f7z.io/trace/12fb7d2a1894bbdd6fd4ed6cc3aa3793. agent1 delegates → agent2 replies "Black" → agent1 callback.

After step 7 lands, the projection on agent1's callback invocation contains, in order:
```
[ System(SP_agent1),
  User { content: "my favourite colour?", attachments: [] },
  Assistant { content: "", tool_calls: [delegate(...)] },
  ToolResult { tool_name: "delegate", content: "Black — RGB(0,0,0)" },
  User { content: "Black — RGB(0,0,0)", attachments: [] } ]
```
Test asserts this exact sequence. **Load-bearing assertion** for Bug A.

### Test 3 — re-engagement flow
Trigger `"do A and B"`. agent does A only. Supervisor `ReEngage { "todo B is still pending" }`. agent does B. Assert projection on the second iteration contains the supervision nudge as a `Message::User` at the tail. Separately query `conversations.last_user_message`; should still be `"do A and B"`, not the nudge text (header guard works).

### Test 4 — `append_message` concurrency
Two threads append rows in tight loops. Without `BEGIN IMMEDIATE`, sequence-unique-index violation occurs probabilistically; with it, deterministic pass.

### Test 5 — header guard
Insert `text/user` "hello" → header = "hello". Insert `supervision/user` "nudge" → header still "hello".

### Test 6 — attachment idempotency
Bootstrap fetches one image, writes attachment `(42, 0)`. Re-bootstrap on the same trigger calls `record_attachment(42, 0, …)`. Assert no error, no duplicate.

## File-Level Change Inventory

### `tenex-conversations`
- `schema.rs`: bump `EXPECTED_SCHEMA_VERSION` to 2; add migration with `message_attachments` DDL.
- `model.rs`: add `AttachmentRecord` struct.
- `store.rs`:
  - Wrap `append_message` in `BEGIN IMMEDIATE`.
  - Header update: `last_user_message` only on `message_type == "text"`.
  - Add `record_attachment`, `list_attachments_by_message_ids`.
  - Ensure `find_message_id_by_event` is callable from agent crate.

### `tenex-context`
- `lib.rs`: collapse `project_with_options` into `project` (with `proactive_context` and `compaction_override` direct params).
- `projection.rs`: `project_messages` returns `Vec<Message>`; delete `step_start`, `excluded_event_id`; bulk-load attachments.
- `types.rs`: `Message::User.attachments`; new `ImageAttachment`; delete `ProjectionOptions`.
- `strategies/mod.rs`: add `ProactiveContextStrategy`; `ProjectionContext.proactive_context`; update stack order.
- `strategies/proactive.rs` (new).

### `tenex-agent`
- `agent_bootstrap/mod.rs`: `conv_store` non-optional; look up trigger row; write attachments; compute `proactive_context` and `original_task`; surface `execution_id`. Delete `user_message`, `trigger_event_id`, `envelope_image_parts`, `envelope_content`.
- `agent_bootstrap/stages.rs`: `proactive_context_block` return is consumed by `boot.proactive_context = block`.
- `agent_bootstrap/helpers.rs`: delete `compose_user_message`.
- `turn_loop/mod.rs`: delete `current_message`, `re_engage_tail`, `turn_message`, `turn_prompt`. On `ReEngage`/`InjectMessage`, call `record_supervision_nudge`. Pass `original_task` to supervisor.
- `turn_loop/step.rs`: delete `turn_prompt`/`turn_text`/`prefix_tail`. Delete `conv_store.is_none()` branches. Always call `record_step_assistant` with deterministic event_id for terminal.
- `turn_loop/step/projection.rs`: thin wrapper around `tenex_context::project`. Delete walker.
- `turn_loop/persistence.rs`: `record_step_assistant` always writes; add `record_supervision_nudge`.
- `context_rig.rs`: `ctx_msg_to_rig` builds multipart from `attachments`.

### `tenex-supervision`
- No change.

### `tenex` runtime
- No change. Outbound writeback already idempotent on `nostr_event_id`.

## Out-of-scope (explicit non-fixes)

1. Active-tool reminder (`agent_bootstrap/mod.rs:441-444`) and active-shell-task reminder (`:446-451`) still appended to `system_prompt`. Move into projection stack in a follow-up.
2. Mid-turn image messages without a bootstrap fetch. Runtime persists the row; no attachment fetch occurs. Document the limitation; the LLM sees URL only.

## Scope Estimate
- ~750 LOC deleted.
- ~350 LOC added (including tests).
- 1 SQLite migration.
- 0 cassettes to re-record (none in repo).
