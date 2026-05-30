# Track File Modifications and Notify Agents of External Changes

Implements GitHub issue [#113](https://github.com/pablof7z/TENEX/issues/113):
when an agent modifies a file in a conversation, subsequent runs of *that same
agent in that same conversation* receive a system reminder if the file has
been externally modified since the agent last wrote it.

## Context

### What exists today

- The agent's project-scoped file writers live in
  `crates/tenex-agent/src/tools/fs.rs`:
  - `FsWriteTool::call` at `crates/tenex-agent/src/tools/fs.rs:281` — full
    overwrite, creates parent dirs.
  - `FsEditTool::call` at `crates/tenex-agent/src/tools/fs.rs:341` — exact
    string replacement, reads-then-writes.
  - Both are constructed in
    `crates/tenex-agent/src/tools/agent_tool_set.rs:173-179` from inside
    `ToolSet::build_for_turn`. They currently only depend on `working_dir`.
- Home-scoped writers (`HomeFsWriteTool`, `HomeFsEditTool`,
  `crates/tenex-agent/src/tools/fs.rs:880-1006`) write into the agent's
  *private* `agent_home` directory; no external party touches those.
- Shell-driven writes (`ShellTool`,
  `crates/tenex-agent/src/tools/shell.rs`) and ACP-backend writes
  (`tenex-agent-acp` MCP bridge) are not interceptable from inside this
  crate's tool surface.
- Per-(agent, conversation) bookkeeping already lives in
  `crates/tenex-conversations/src/schema.rs:132` (`agent_context_state`),
  which is the model for "data scoped to a single agent in a single
  conversation." It uses an `(conversation_id, agent_pubkey)` composite
  primary key.
- The existing system-reminder pattern that this feature mirrors:
  - `AgentsMdReminderState` (`crates/tenex-agent/src/tools/agents_md.rs:14`)
    — tracks "what I have shown to the agent" in-memory and emits a
    `<system-reminder type="agents-md">` block only when something new is
    encountered. Same dedup shape we need, but our state must be persisted
    so it survives across one-shot agent invocations.
  - `RuntimeStateHandle::render_active_tools_reminder`
    (`crates/tenex-agent/src/runtime_state.rs:100`) — reads cross-execution
    state from `conversations.runtime_state_json`, emits a
    `<system-reminder type="active-tool-executions">` block, and gets
    appended onto `system_prompt` in
    `crates/tenex-agent/src/agent_bootstrap/mod.rs:466-471`.
  - `render_active_shell_tasks_reminder`
    (`crates/tenex-agent/src/shell_task_reminder.rs`) — same shape,
    appended to `system_prompt` at `agent_bootstrap/mod.rs:472-477`.
- Sister precedent that we deliberately *do not* follow:
  `proactive_context` was moved off `system_prompt` into a projection
  overlay (`agent_bootstrap/mod.rs:442-464`, comment on lines 442-452)
  because appending it on every invocation produced a 0% prompt-cache hit
  rate. See "Approach" for why this feature lands on `system_prompt`
  anyway.
- Column-scoped atomic upsert precedent: `patch_agent_context_todos`
  (`crates/tenex-conversations/src/store.rs:1005`) — writes only the
  columns it owns so concurrent writers on orthogonal fields don't lose
  updates. Our store API follows the same pattern.
- No diff/unified-diff crate is currently in the workspace
  (`Cargo.toml` greps clean for `similar`/`TextDiff`/`unified_diff`).
  `sha2 = "0.10"` is already a `tenex-agent` dependency
  (`crates/tenex-agent/Cargo.toml:60`) — reused for content hashing.
- Conversation-store schema is forward-only (`schema.rs:198-200`,
  `EXPECTED_SCHEMA_VERSION = 2`). New tables land as a new migration
  entry; existing migrations are never altered.

### Why this change

Agents working on configuration files, code, or documentation today have
no way to know that the file they touched in a previous run has since been
edited by the user or another agent. Without a notification, the agent may
re-do superseded work, overwrite manual fixes, or build on a stale view of
the file's contents. The issue asks for a per-agent, per-conversation,
seamless notification that a file the agent touched in *this* conversation
has been externally modified since.

## Approach

Persist, per `(conversation_id, agent_pubkey, canonical_path)`, the
content snapshot the agent wrote to disk. On each bootstrap, compare every
tracked file's current disk state to its stored snapshot; emit a
`<system-reminder type="external-file-modifications">` block for the
differences and **advance the stored snapshot to match disk** so the next
invocation is quiet unless a *new* external change happens. Tools update
the snapshot atomically after each successful `fs_write`/`fs_edit`.

This is the persisted analogue of `AgentsMdReminderState`'s in-memory
`visible_paths` dedup
(`crates/tenex-agent/src/tools/agents_md.rs:46-56`): emit on first
observation, then mark seen.

### Why a new dedicated table, not a JSON column on `agent_context_state`

- One row per file (one-to-many vs the row's PK), which fits relational
  storage and lets us read/update rows independently.
- Holds a BLOB snapshot of the file content (up to a cap; see below) — a
  JSON blob is the wrong shape for binary content.
- Lets two concurrent agent executions write *different* tracked files
  without contending on a single JSON cell.

### Why append to `system_prompt`, given the cache-bust lesson

`proactive_context` (`agent_bootstrap/mod.rs:442-452`) was moved to a
projection overlay because it fired on every invocation and busted the
prompt cache 100% of the time. The other two `system_prompt` appenders —
`active_tools` (`mod.rs:466-471`) and `active_shell_tasks`
(`mod.rs:472-477`) — stayed on `system_prompt` because they only render
*when something is actually present* (`render_active_tools_reminder`
returns `Option<String>`); on the common path they emit nothing and the
prompt is identical across invocations, so the cache stays warm.

This reminder follows the conditional appenders: render only when the
tracked-file scan finds drift, and crucially the snapshot-advance step in
the approach makes the reminder *one-shot per external change* rather
than recurring forever. The cache miss is bounded to the one invocation
that first observes the drift. Same shape as `active_tools` and
`active_shell_tasks` — appropriate to land in the same place.

### Tracking boundary (false positives the agent must understand)

The snapshot only advances when the agent writes via `fs_write` /
`fs_edit`. If the same agent later modifies the file through `shell`
(`echo > file`, `sed -i …`, code generators it runs, etc.) the next
bootstrap will report the shell-driven change as "external." Out of scope
to fix in v1; this plan does *not* claim "seamless" coverage of every
write path. Document the limitation in the reminder text so the agent can
tell what kind of mismatch it is staring at. The shell-write path can be
covered in a follow-up by adding a post-shell file scan (deferred — needs
its own design because shell commands can touch arbitrary paths).

Also out of scope, by design:
- `home_fs_write` / `home_fs_edit` — the agent's home is private; nobody
  else writes there. No tracking needed.
- ACP variant (`tenex-agent-acp`) — file writes there go through the ACP
  backend (e.g. Claude Code), which provides its own filesystem tooling
  outside this crate's interception surface. A separate proposal.

### Snapshot storage cap

Store the full content snapshot for files **≤ 1 MiB**; for larger files
record the SHA-256 hash and byte size only. When the bootstrap scan
detects drift on a large-file row, the reminder reports
"externally modified — file too large to diff (was N bytes, now M
bytes)." Cap chosen as a sane default consistent with `MAX_LINE_LENGTH =
2000` (`fs.rs:125`) and `MAX_CONTENT_SIZE = 50_000` (`fs.rs:502`) order
of magnitudes — large enough to cover normal source files, small enough
to keep `conversation.db` bounded.

### Diff rendering

Add the `similar` crate (the de facto Rust unified-diff library) as a
direct `tenex-agent` dependency. Render `TextDiff::from_lines(...).
unified_diff().context_radius(3)` for files where *both* snapshots are
present and the produced diff is ≤ 4 KiB. Above that, fall back to a
summary line: `+N -M lines (Δ K bytes)`. Binary detection: if either
snapshot contains a NUL byte in the first 8 KiB, skip line-diff and
report bytes-only.

### Alternatives considered

- **In-memory only (no DB).** Rejected: an agent invocation is one-shot;
  there is no in-memory state across runs. The notification needs to fire
  on the *next* run, which means it must persist.
- **JSON column on `agent_context_state`.** Rejected for the reasons in
  "Why a new dedicated table" above (BLOB content, one-to-many, write
  contention).
- **Hash-only storage, no snapshot, no diff.** Rejected: the issue
  explicitly asks for "a diff (if small)" not just a binary "changed/not
  changed" signal. Storing the snapshot is what enables the diff.
- **Detect drift via git only.** Rejected: not every project is git-init'd,
  conversation-scoped tracking doesn't map cleanly onto commits, and
  uncommitted user edits would not be observable.
- **Snapshot at LLM-call time, not at write time.** Rejected: the agent's
  intent is "I wrote this content"; the snapshot must reflect what the
  agent put on disk, not whatever the disk happens to hold later in the
  turn.

## File Changes

### `crates/tenex-conversations/src/schema.rs`

- **Action**: modify
- **What**:
  - Bump `EXPECTED_SCHEMA_VERSION` from `2` to `3`.
  - Add `MIGRATION_V3` constant with the new table:
    ```sql
    CREATE TABLE agent_file_modifications (
        conversation_id TEXT NOT NULL,
        agent_pubkey    TEXT NOT NULL,
        path            TEXT NOT NULL,        -- canonicalized absolute path
        content_hash    TEXT NOT NULL,         -- SHA-256 hex
        byte_size       INTEGER NOT NULL,
        snapshot        BLOB,                  -- NULL when byte_size > cap
        snapshot_capped INTEGER NOT NULL DEFAULT 0,
        wrote_at        INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, agent_pubkey, path),
        FOREIGN KEY (conversation_id)
            REFERENCES conversations(id)
            ON DELETE CASCADE
    );

    CREATE INDEX idx_agent_file_modifications_agent
        ON agent_file_modifications(conversation_id, agent_pubkey);
    ```
  - Append `(3, MIGRATION_V3)` to the `migrations()` array.
- **Why**: forward-only schema addition that gives us per-(conversation,
  agent, path) snapshot storage with the same composite-key shape as the
  existing `agent_context_state`.

### `crates/tenex-conversations/src/model.rs`

- **Action**: modify
- **What**: add two public structs near the existing `AgentContextState`
  block (around `model.rs:240`):
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize)]
  pub struct FileModificationRecord {
      pub conversation_id: String,
      pub agent_pubkey:    String,
      pub path:            String,
      pub content_hash:    String,
      pub byte_size:       i64,
      pub snapshot:        Option<Vec<u8>>,
      pub snapshot_capped: bool,
      pub wrote_at:        i64,
  }

  #[derive(Debug, Clone)]
  pub struct NewFileModification {
      pub path:         String,
      pub content_hash: String,
      pub byte_size:    i64,
      pub snapshot:     Option<Vec<u8>>,
      pub wrote_at:     i64,
  }
  ```
  `snapshot_capped` is derived (`snapshot.is_none()`); stored explicitly so
  the row is self-describing without computing from the BLOB length.
- **Why**: typed read/write models that match the schema row shape.

### `crates/tenex-conversations/src/store.rs`

- **Action**: modify
- **What**: add a new section below "Agent context state"
  (`store.rs:975`) with three methods on `ConversationStore`:
  - `list_file_modifications(&self, conversation_id: &str, agent_pubkey: &str) -> Result<Vec<FileModificationRecord>>`
  - `upsert_file_modification(&self, conversation_id: &str, agent_pubkey: &str, new: &NewFileModification) -> Result<()>` —
    column-scoped atomic upsert in the style of
    `patch_agent_context_todos` (`store.rs:1005`):
    ```sql
    INSERT INTO agent_file_modifications
      (conversation_id, agent_pubkey, path, content_hash, byte_size,
       snapshot, snapshot_capped, wrote_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id, agent_pubkey, path) DO UPDATE SET
      content_hash    = excluded.content_hash,
      byte_size       = excluded.byte_size,
      snapshot        = excluded.snapshot,
      snapshot_capped = excluded.snapshot_capped,
      wrote_at        = excluded.wrote_at;
    ```
  - `delete_file_modification(&self, conversation_id: &str, agent_pubkey: &str, path: &str) -> Result<()>` —
    used when an agent intentionally deletes a tracked file (future
    work) or when a tombstone needs to be cleared. Not used by v1
    runtime code but kept for symmetry with the table's `DELETE`
    statement and for tests.
  - Private `row_to_file_modification` helper following
    `row_to_agent_context_state`.
- **Why**: typed, idempotent, column-scoped writes; concurrent invocations
  of the same agent writing different files never contend on a single row.

### `crates/tenex-conversations/src/lib.rs`

- **Action**: modify
- **What**: re-export `FileModificationRecord` and `NewFileModification`
  from `model` (mirror the existing `AgentContextState` re-export).
- **Why**: keeps the public surface flat; consumers don't import from
  `tenex_conversations::model`.

### `crates/tenex-conversations/tests/integration.rs`

- **Action**: modify
- **What**: add two tests next to the existing `agent_context_state`
  tests:
  1. `upsert_then_list_file_modifications_returns_inserted_row` —
     idempotent upsert: insert, upsert again with new hash/snapshot,
     read back the new values.
  2. `file_modification_rows_cascade_on_conversation_delete` —
     delete the conversation row, confirm rows in
     `agent_file_modifications` are removed (`ON DELETE CASCADE`).
- **Why**: prove the new storage contract before any agent code depends
  on it.

### `crates/tenex-agent/Cargo.toml`

- **Action**: modify
- **What**: add `similar = "2"` to `[dependencies]`. `sha2` is already
  present (line 60).
- **Why**: unified-diff rendering for the reminder body.

### `crates/tenex-agent/src/file_modification_tracker.rs` (new)

- **Action**: create
- **What**: new module that owns
  1. canonical-path resolution at write time,
  2. SHA-256 hashing,
  3. snapshot-cap policy,
  4. tracker handle that wraps the conv store, and
  5. bootstrap-time detection + reminder rendering.

  Public surface:
  ```rust
  pub struct FileModificationTracker {
      db_path:         std::path::PathBuf,
      conversation_id: String,
      agent_pubkey:    String,
  }

  impl FileModificationTracker {
      pub fn new(db_path: PathBuf, conversation_id: String, agent_pubkey: String) -> Self;

      /// Called by `FsWriteTool` / `FsEditTool` *after* a successful write.
      /// `path` must be the post-write canonical absolute path
      /// (`std::fs::canonicalize`). `content` is what the agent just wrote
      /// to disk.
      pub fn record_write(&self, path: &Path, content: &[u8]);

      /// Bootstrap-time scan: compare every tracked row for
      /// `(conversation_id, agent_pubkey)` against current disk state,
      /// produce a system-reminder body, and advance snapshots to match
      /// disk so the next run is quiet on these same drifts.
      pub fn render_and_advance_reminder(&self) -> Option<String>;
  }

  pub const SNAPSHOT_CAP_BYTES: usize = 1 << 20; // 1 MiB
  pub const INLINE_DIFF_BYTES: usize = 4096;
  ```

  Implementation notes:
  - `record_write` failures (canonicalize, store insert) log to stderr
    in the same style as `runtime_state.rs:48` and do not propagate;
    tracking is best-effort.
  - `render_and_advance_reminder` iterates `list_file_modifications`:
    - File missing on disk → reminder entry `"deleted externally"`;
      delete the row (`delete_file_modification`) since there is no
      longer anything to track.
    - File present, hash matches stored `content_hash` → no entry; skip.
    - File present, hash differs → diff against `snapshot` if both
      sides fit (`!snapshot_capped`, current bytes ≤ cap, neither
      contains NUL in first 8 KiB, generated unified-diff length ≤
      `INLINE_DIFF_BYTES`); otherwise emit summary line; then
      `upsert_file_modification` with the new disk hash/snapshot.
  - Reminder XML shape matches the rest of the codebase
    (`<system-reminder type="external-file-modifications">…</system-reminder>`),
    one `<file path="…" status="modified|deleted">` child per entry,
    diff or summary inside.
  - Includes a one-line trailer noting the boundary: shell-driven and
    other-tool writes will appear as external. Lifts the false-positive
    surface from "silent surprise" to "labeled limitation."
- **Why**: keeps hashing/diffing/canonicalization out of the tools and
  the bootstrap, matching the one-concern pattern of
  `runtime_state.rs` / `injections.rs`.

### `crates/tenex-agent/src/lib.rs`

- **Action**: modify
- **What**: add `pub(crate) mod file_modification_tracker;`.
- **Why**: register the new module.

### `crates/tenex-agent/src/tools/fs.rs`

- **Action**: modify
- **What**:
  - Add an optional `tracker: Option<Arc<crate::file_modification_tracker::FileModificationTracker>>`
    field to `FsWriteTool` (`fs.rs:249`) and `FsEditTool` (`fs.rs:307`).
  - Extend their `::new` constructors to accept the tracker
    (passed by `agent_tool_set.rs` — `None` in unit tests).
  - In `FsWriteTool::call` (after successful `fs::write` at
    `fs.rs:288`): canonicalize `path` (already absolute after
    `resolve_path`); on success call
    `tracker.record_write(&canonical, args.content.as_bytes())`. On
    canonicalize failure (rare; file just written), fall back to the
    pre-canonicalized `path` so tracking still happens.
  - In `FsEditTool::call` (after successful `fs::write` at
    `fs.rs:374`): same — `tracker.record_write(&canonical, new_content.as_bytes())`.
  - `HomeFsWriteTool` / `HomeFsEditTool` are *not* changed — home is
    private (`fs.rs:90`).
- **Why**: the tracker has to see the *post-write* content the agent
  authored; the tool is the only place that owns that buffer.

### `crates/tenex-agent/src/tools/agent_tool_set.rs`

- **Action**: modify
- **What**:
  - Add `pub file_modification_tracker: Option<Arc<FileModificationTracker>>`
    field to `ToolSet` (the struct defined in the file).
  - In `ToolSet::build_for_turn`
    (`agent_tool_set.rs:138`), thread
    `self.file_modification_tracker.clone()` into the new
    `FsWriteTool::new` and `FsEditTool::new` constructor calls
    (`agent_tool_set.rs:173`, `:178`).
- **Why**: ToolSet is where every per-turn tool gets its dependencies;
  this is the canonical wiring point.

### `crates/tenex-agent/src/agent_bootstrap/mod.rs`

- **Action**: modify
- **What**:
  1. Construct the tracker right after `runtime_state` is built
     (`mod.rs:155`):
     ```rust
     let file_modification_tracker = Some(Arc::new(
         crate::file_modification_tracker::FileModificationTracker::new(
             conv_db_path.clone(),
             conversation_id.clone(),
             pubkey_hex.clone(),
         ),
     ));
     ```
  2. After the existing `active_tools` and `active_shell_tasks` blocks
     (`mod.rs:466-477`), add the symmetric reminder append:
     ```rust
     if let Some(tracker) = file_modification_tracker.as_deref() {
         if let Some(reminder) = tracker.render_and_advance_reminder() {
             system_prompt.push_str("\n\n");
             system_prompt.push_str(&reminder);
         }
     }
     ```
  3. Pass the tracker into the `ToolSet` literal (`mod.rs:485-523`)
     via the new `file_modification_tracker` field.
- **Why**: `agent_bootstrap::build` is the single place that owns
  per-invocation wiring; both the bootstrap-time scan and the
  per-turn tracker dependency belong here.

### `crates/tenex-agent/src/file_modification_tracker.rs` — unit tests

- **Action**: covered by the file's `#[cfg(test)]` module created above
- **What**: cover the three core cases with `tempfile::tempdir` + an
  in-memory or temp-file `ConversationStore`:
  1. `record_write_then_no_external_change_emits_no_reminder` — write
     a file via the tracker, do nothing else, scan → returns `None`.
  2. `external_modification_emits_reminder_then_quiet_on_second_scan` —
     write via tracker, mutate the file outside the tracker, first
     scan returns `Some(...)`, second scan returns `None` (proves
     snapshot-advance).
  3. `large_file_reports_summary_not_diff` — write a file larger than
     `SNAPSHOT_CAP_BYTES`, mutate externally, scan reports
     "too large to diff" with byte sizes.
  4. `deleted_file_reports_deletion_and_drops_row` — write, delete on
     disk, scan reports deletion; second scan is empty (row was
     dropped from the store).

### `MODULE_INVENTORY.md`

- **Action**: modify
- **What**: under `### tenex-agent` (line 64), add a row for
  `file_modification_tracker.rs`:
  `| `file_modification_tracker.rs` | Per-(conversation, agent) file-write snapshots + bootstrap-time external-modification detection. |`
- **Why**: the inventory is the canonical map; new modules belong in it.

### `crates/tenex-agent/AGENTS.md`

- **Action**: modify
- **What**: under "Critical invariants", append to the existing
  `Tools in src/tools/` bullet (the line that enumerates fs writes) a
  reference to `file_modification_tracker.rs`: "Project-fs writes
  (`fs_write`, `fs_edit`) also update a per-(conversation, agent)
  snapshot used to notify the agent on its next run if the file has
  been externally modified."
- **Why**: per CLAUDE.md "Keep AGENTS.md up to date — if you add… new
  modules… update the relevant AGENTS.md".

## Execution Order

Each step ends in `cargo build -p <crate> && cargo test -p <crate>` for
the touched crate, so each is independently verifiable.

1. **Schema + model + store** (foundations, no callers yet).
   - Bump `EXPECTED_SCHEMA_VERSION` to 3, add `MIGRATION_V3`,
     `agent_file_modifications` table.
   - Add `FileModificationRecord` / `NewFileModification` types and
     re-export them from `lib.rs`.
   - Add `list_file_modifications`, `upsert_file_modification`,
     `delete_file_modification`, `row_to_file_modification` to
     `ConversationStore`.
   - Add the two integration tests in
     `crates/tenex-conversations/tests/integration.rs`.
   - Verify: `cargo test -p tenex-conversations` — both new tests
     pass, all existing tests still pass.

2. **Add `similar` dependency** to `crates/tenex-agent/Cargo.toml`.
   Verify: `cargo build -p tenex-agent` succeeds (proves the crate
   resolves).

3. **Create `file_modification_tracker` module** with the public
   surface and the four unit tests described above. Wire it into
   `lib.rs`.
   Verify: `cargo test -p tenex-agent --lib file_modification_tracker`
   — all four cases pass.

4. **Wire the tracker into `FsWriteTool` and `FsEditTool`**
   (`crates/tenex-agent/src/tools/fs.rs`). Update existing call sites
   in `agent_tool_set.rs` to pass the tracker (or `None`).
   Verify: `cargo test -p tenex-agent` — pre-existing `fs::tests`
   pass unchanged (the new field is `Option<...>` and defaults to
   `None` in tests).

5. **Wire the tracker into `ToolSet` and `agent_bootstrap::build`**:
   construct the tracker, pass to `ToolSet`, append the reminder onto
   `system_prompt` after `active_tools` / `active_shell_tasks`.
   Verify: `cargo build -p tenex-agent` succeeds; a manual smoke test
   (run an agent that does `fs_write`, mutate the file out of band, run
   the same agent in the same conversation again) shows the reminder
   in stderr-mirrored prompt logs (`TENEX_LOG_PROMPT=1` or similar
   inspection path; otherwise add a one-off `eprintln!` during the
   smoke test).

6. **Documentation**: update `MODULE_INVENTORY.md` and
   `crates/tenex-agent/AGENTS.md` per the file-changes list.
   Verify: `git diff` shows only the documented additions.

7. **Workspace-wide check**:
   `cargo build --workspace && cargo test --workspace` — every
   crate that opens `conversation.db` (catalog, agent runner,
   summarizer, intervention watcher, embedder) tolerates the V3
   migration. Per `crates/tenex-conversations/AGENTS.md`: "Confirm
   every Rust consumer that opens `conversation.db` can tolerate the
   new migration before landing schema changes."

## Verification

- `cargo test -p tenex-conversations` — schema migration + new
  store methods pass.
- `cargo test -p tenex-agent` — tracker unit tests + the pre-existing
  `fs::tests` block (`fs.rs:1127`) all pass.
- `cargo build --workspace && cargo test --workspace` — no consumer
  breakage from the schema bump.
- Manual end-to-end:
  1. In a fresh project, send a message asking an agent to write
     `/tmp/tenex-mod-test.txt` via `fs_write`.
  2. After the agent completes, edit the file externally
     (`echo "user edit" >> /tmp/tenex-mod-test.txt`).
  3. Send a follow-up message in the same conversation to the same
     agent. Verify (via prompt-capture / cassette / `eprintln!`) that
     `system_prompt` now contains
     `<system-reminder type="external-file-modifications">` with a
     unified diff showing the "user edit" addition.
  4. Send a third follow-up *without* further external edits. Verify
     the reminder is absent on this third run (proves
     snapshot-advance / one-shot semantics).
  5. Replace step 1 with a file > 1 MiB and verify the third bullet
     reports byte-size summary, not a unified diff.
  6. Delete the file externally between two runs and verify the
     reminder reports `status="deleted"` and the row is dropped
     (subsequent run is quiet).
- Edge cases worth a manual probe:
  - Re-running the *same* agent in a *different* conversation must
    not see notifications about files touched in the first
    conversation (privacy / composite-key correctness).
  - Two agents in the same conversation: agent A writes file X,
    agent B writes file X. On A's next run, A sees B's write as
    external — correct, because from A's snapshot's perspective the
    content did change between A's writes.
  - An agent writes file X via `fs_write`, then in the same turn
    modifies it via `shell` (`sed -i …`). Next run will report the
    shell change as external — labeled limitation, documented in the
    reminder body.
