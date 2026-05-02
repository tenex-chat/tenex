//! `ConversationStore` is the single open handle on a project's
//! `conversation.db`. Read methods serve all consumers (catalog, agent
//! runner, summarizer, intervention watcher, and project runtime); write
//! methods are used by the runtime and agent runner.
//!
//! Writes are idempotent on `nostr_event_id` where the schema enforces a
//! partial unique index, and idempotent on `(conversation_id, record_id)`
//! for messages and `(conversation_id, tool_call_id)` for tool messages.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};

use crate::error::{ConversationsError, Result};
use crate::model::{
    AgentContextState, Completion, CompletionStatus, ConversationRow, MessageRecord, NewCompletion,
    NewMessage, NewPromptHistoryEntry, NewToolMessage, PromptHistoryEntry, ToolMessage,
};
use crate::schema;

#[derive(Debug, Clone, Default)]
pub struct ConversationListFilter {
    pub from_time: Option<i64>,
    pub to_time: Option<i64>,
    pub participant_pubkey: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct MessageQuery {
    pub agent_pubkey: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

pub struct ConversationStore {
    conn: Connection,
    path: PathBuf,
}

impl ConversationStore {
    /// Open (or create) the conversation database at `path` and run
    /// pending migrations. Caller is responsible for the parent directory
    /// existing.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(path)?;
        schema::configure_connection(&conn)?;
        schema::migrate(&mut conn)?;
        Ok(Self {
            conn,
            path: path.to_path_buf(),
        })
    }

    /// Open an in-memory database, primarily for tests.
    pub fn open_in_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        schema::configure_connection(&conn)?;
        schema::migrate(&mut conn)?;
        Ok(Self {
            conn,
            path: PathBuf::from(":memory:"),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Direct connection access for advanced consumers (vacuum, integrity
    /// checks, custom queries). Prefer the typed methods.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    pub fn connection_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    // ==========================================================================
    // Conversations: read
    // ==========================================================================

    pub fn get_conversation(&self, conversation_id: &str) -> Result<Option<ConversationRow>> {
        self.conn
            .query_row(
                "SELECT id, title, summary, last_user_message, status_label,
                        status_current_activity, owner_pubkey, created_at, last_activity,
                        metadata_json, runtime_state_json, updated_at
                   FROM conversations
                  WHERE id = ?1",
                [conversation_id],
                row_to_conversation,
            )
            .optional()
            .map_err(ConversationsError::from)
    }

    /// Author of the lowest-sequence message in the conversation — i.e. the
    /// pubkey that opened the conversation. Returns `Ok(None)` when the
    /// conversation is unknown locally or has no messages yet.
    pub fn root_author_pubkey(&self, conversation_id: &str) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT author_pubkey FROM messages
                  WHERE conversation_id = ?1
                  ORDER BY sequence ASC
                  LIMIT 1",
                [conversation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(ConversationsError::from)
    }

    /// Conversations whose `messages.author_pubkey` (or `targeted_pubkeys`)
    /// includes `pubkey`. Joins through `messages`.
    pub fn list_by_participant(
        &self,
        pubkey: &str,
        limit: Option<i64>,
    ) -> Result<Vec<ConversationRow>> {
        let limit = limit.unwrap_or(i64::MAX);
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT c.id, c.title, c.summary, c.last_user_message, c.status_label,
                    c.status_current_activity, c.owner_pubkey, c.created_at, c.last_activity,
                    c.metadata_json, c.runtime_state_json, c.updated_at
               FROM conversations c
               JOIN messages m ON m.conversation_id = c.id
              WHERE m.author_pubkey = ?1
                 OR EXISTS (
                       SELECT 1 FROM json_each(COALESCE(m.targeted_pubkeys_json, '[]'))
                        WHERE json_each.value = ?1
                    )
              ORDER BY COALESCE(c.last_activity, 0) DESC, c.id ASC
              LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![pubkey, limit], row_to_conversation)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn list_recent(&self, filter: ConversationListFilter) -> Result<Vec<ConversationRow>> {
        let limit = filter.limit.unwrap_or(i64::MAX);
        let from_time = filter.from_time;
        let to_time = filter.to_time;
        let participant = filter.participant_pubkey;

        let mut stmt = self.conn.prepare(
            "SELECT id, title, summary, last_user_message, status_label,
                    status_current_activity, owner_pubkey, created_at, last_activity,
                    metadata_json, runtime_state_json, updated_at
               FROM conversations c
              WHERE (?1 IS NULL OR COALESCE(c.last_activity, 0) >= ?1)
                AND (?2 IS NULL OR COALESCE(c.last_activity, 0) <= ?2)
                AND (
                     ?3 IS NULL OR EXISTS (
                         SELECT 1 FROM messages m
                          WHERE m.conversation_id = c.id
                            AND (
                                  m.author_pubkey = ?3
                                  OR EXISTS (
                                       SELECT 1 FROM json_each(COALESCE(m.targeted_pubkeys_json, '[]'))
                                        WHERE json_each.value = ?3
                                     )
                                 )
                     )
                )
              ORDER BY COALESCE(c.last_activity, 0) DESC, c.id ASC
              LIMIT ?4",
        )?;
        let rows = stmt
            .query_map(
                params![from_time, to_time, participant, limit],
                row_to_conversation,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ==========================================================================
    // Conversations: write
    // ==========================================================================

    /// Insert or update the conversation header. Existing JSON sidecar
    /// columns are left untouched if `None` is passed in their slot — call
    /// `set_runtime_state` / `set_metadata_json` for partial JSON updates.
    pub fn upsert_conversation(&self, row: &ConversationRow) -> Result<()> {
        self.conn.execute(
            "INSERT INTO conversations (
                id, title, summary, last_user_message, status_label,
                status_current_activity, owner_pubkey, created_at, last_activity,
                metadata_json, runtime_state_json, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                summary = excluded.summary,
                last_user_message = excluded.last_user_message,
                status_label = excluded.status_label,
                status_current_activity = excluded.status_current_activity,
                owner_pubkey = excluded.owner_pubkey,
                created_at = COALESCE(conversations.created_at, excluded.created_at),
                last_activity = excluded.last_activity,
                metadata_json = excluded.metadata_json,
                runtime_state_json = excluded.runtime_state_json,
                updated_at = excluded.updated_at",
            params![
                row.id,
                row.title,
                row.summary,
                row.last_user_message,
                row.status_label,
                row.status_current_activity,
                row.owner_pubkey,
                row.created_at,
                row.last_activity,
                row.metadata.to_string(),
                row.runtime_state.to_string(),
                row.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Merge generated metadata into the conversation header and metadata JSON.
    pub fn update_metadata(
        &self,
        conversation_id: &str,
        title: Option<&str>,
        summary: Option<&str>,
        status_label: Option<&str>,
        status_current_activity: Option<&str>,
    ) -> Result<()> {
        self.ensure_conversation(conversation_id)?;
        let raw: String = self.conn.query_row(
            "SELECT metadata_json FROM conversations WHERE id = ?1",
            [conversation_id],
            |row| row.get(0),
        )?;
        let mut metadata = serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}));
        if !metadata.is_object() {
            metadata = serde_json::json!({});
        }
        let metadata_obj = metadata.as_object_mut().expect("object just created");

        if let Some(value) = title {
            metadata_obj.insert(
                "title".to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }
        if let Some(value) = summary {
            metadata_obj.insert(
                "summary".to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }
        if let Some(value) = status_label {
            metadata_obj.insert(
                "statusLabel".to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }
        if let Some(value) = status_current_activity {
            metadata_obj.insert(
                "statusCurrentActivity".to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }

        let now = now_ms();
        self.conn.execute(
            "UPDATE conversations
                SET title = COALESCE(?2, title),
                    summary = COALESCE(?3, summary),
                    status_label = COALESCE(?4, status_label),
                    status_current_activity = COALESCE(?5, status_current_activity),
                    metadata_json = ?6,
                    updated_at = ?7
              WHERE id = ?1",
            params![
                conversation_id,
                title,
                summary,
                status_label,
                status_current_activity,
                metadata.to_string(),
                now,
            ],
        )?;
        Ok(())
    }

    /// Ensure a row exists for `conversation_id` so foreign keys on
    /// downstream inserts succeed. Used by migration paths and callers
    /// that have a conversation id before any header data.
    pub fn ensure_conversation(&self, conversation_id: &str) -> Result<()> {
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO conversations (id, metadata_json, runtime_state_json, updated_at)
             VALUES (?1, '{}', '{}', ?2)
             ON CONFLICT(id) DO NOTHING",
            params![conversation_id, now],
        )?;
        Ok(())
    }

    /// Replace the opaque per-conversation runtime state blob.
    pub fn set_runtime_state(
        &self,
        conversation_id: &str,
        runtime_state: &serde_json::Value,
    ) -> Result<()> {
        self.ensure_conversation(conversation_id)?;
        let now = now_ms();
        self.conn.execute(
            "UPDATE conversations
                SET runtime_state_json = ?2,
                    updated_at = ?3
              WHERE id = ?1",
            params![conversation_id, runtime_state.to_string(), now],
        )?;
        Ok(())
    }

    /// Atomically read, mutate, and replace the opaque runtime state blob.
    pub fn update_runtime_state<T>(
        &mut self,
        conversation_id: &str,
        f: impl FnOnce(&mut serde_json::Value) -> T,
    ) -> Result<T> {
        self.ensure_conversation(conversation_id)?;
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut runtime_state = tx.query_row(
            "SELECT runtime_state_json
               FROM conversations
              WHERE id = ?1",
            [conversation_id],
            |row| {
                let raw: String = row.get(0)?;
                Ok(serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({})))
            },
        )?;
        let result = f(&mut runtime_state);
        let now = now_ms();
        tx.execute(
            "UPDATE conversations
                SET runtime_state_json = ?2,
                    updated_at = ?3
              WHERE id = ?1",
            params![conversation_id, runtime_state.to_string(), now],
        )?;
        tx.commit()?;
        Ok(result)
    }

    // ==========================================================================
    // Messages
    // ==========================================================================

    /// Append a message to the conversation. Idempotent on
    /// `(conversation_id, record_id)` and on `nostr_event_id` when
    /// present. On conflict, returns the existing row's id and does not
    /// modify the row.
    pub fn append_message(&self, conversation_id: &str, msg: &NewMessage) -> Result<i64> {
        self.ensure_conversation(conversation_id)?;
        if let Some(existing) = self.find_message_id_by_record(conversation_id, &msg.record_id)? {
            return Ok(existing);
        }
        if let Some(event_id) = &msg.nostr_event_id {
            if let Some(existing) = self.find_message_id_by_event(event_id)? {
                return Ok(existing);
            }
        }

        let next_sequence: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(sequence), -1) + 1 FROM messages WHERE conversation_id = ?1",
            [conversation_id],
            |row| row.get(0),
        )?;

        let now = now_ms();
        self.conn.execute(
            "INSERT INTO messages (
                conversation_id, record_id, nostr_event_id, sequence,
                author_pubkey, sender_pubkey, ral, message_type, role, content,
                timestamp, targeted_pubkeys_json, sender_principal_json,
                targeted_principals_json, tool_data_json, delegation_marker_json,
                human_readable, transcript_tool_attributes_json, created_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
             )",
            params![
                conversation_id,
                msg.record_id,
                msg.nostr_event_id,
                next_sequence,
                msg.author_pubkey,
                msg.sender_pubkey,
                msg.ral,
                msg.message_type,
                msg.role,
                msg.content,
                msg.timestamp,
                msg.targeted_pubkeys
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                msg.sender_principal.as_ref().map(|v| v.to_string()),
                msg.targeted_principals.as_ref().map(|v| v.to_string()),
                msg.tool_data.as_ref().map(|v| v.to_string()),
                msg.delegation_marker.as_ref().map(|v| v.to_string()),
                msg.human_readable,
                msg.transcript_tool_attributes
                    .as_ref()
                    .map(|v| v.to_string()),
                now,
            ],
        )?;
        let row_id = self.conn.last_insert_rowid();
        self.apply_message_to_header(conversation_id, msg)?;
        Ok(row_id)
    }

    fn apply_message_to_header(&self, conversation_id: &str, msg: &NewMessage) -> Result<()> {
        let last_user_message = if msg.message_type == "text" && msg.role.as_deref() == Some("user")
        {
            let trimmed = msg.content.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        } else {
            None
        };
        let now = now_ms();
        self.conn.execute(
            "UPDATE conversations
                SET owner_pubkey = COALESCE(owner_pubkey, ?2),
                    created_at = CASE
                        WHEN ?3 IS NULL THEN created_at
                        WHEN created_at IS NULL OR ?3 < created_at THEN ?3
                        ELSE created_at
                    END,
                    last_activity = CASE
                        WHEN ?3 IS NULL THEN last_activity
                        WHEN last_activity IS NULL OR ?3 >= last_activity THEN ?3
                        ELSE last_activity
                    END,
                    last_user_message = CASE
                        WHEN ?4 IS NOT NULL
                         AND (?3 IS NULL OR last_activity IS NULL OR ?3 >= last_activity)
                        THEN ?4
                        ELSE last_user_message
                    END,
                    updated_at = ?5
              WHERE id = ?1",
            params![
                conversation_id,
                msg.author_pubkey,
                msg.timestamp,
                last_user_message,
                now,
            ],
        )?;
        Ok(())
    }

    pub fn list_messages(
        &self,
        conversation_id: &str,
        query: MessageQuery,
    ) -> Result<Vec<MessageRecord>> {
        let limit = query.limit.unwrap_or(i64::MAX);
        let offset = query.offset.unwrap_or(0);
        let rows: Vec<MessageRecord> = match query.agent_pubkey {
            Some(pubkey) => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, conversation_id, record_id, nostr_event_id, sequence,
                            author_pubkey, sender_pubkey, ral, message_type, role, content,
                            timestamp, targeted_pubkeys_json, sender_principal_json,
                            targeted_principals_json, tool_data_json, delegation_marker_json,
                            human_readable, transcript_tool_attributes_json, created_at
                       FROM messages
                      WHERE conversation_id = ?1 AND author_pubkey = ?2
                      ORDER BY sequence ASC
                      LIMIT ?3 OFFSET ?4",
                )?;
                let mapped = stmt
                    .query_map(
                        params![conversation_id, pubkey, limit, offset],
                        row_to_message,
                    )?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                mapped
            }
            None => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, conversation_id, record_id, nostr_event_id, sequence,
                            author_pubkey, sender_pubkey, ral, message_type, role, content,
                            timestamp, targeted_pubkeys_json, sender_principal_json,
                            targeted_principals_json, tool_data_json, delegation_marker_json,
                            human_readable, transcript_tool_attributes_json, created_at
                       FROM messages
                      WHERE conversation_id = ?1
                      ORDER BY sequence ASC
                      LIMIT ?2 OFFSET ?3",
                )?;
                let mapped = stmt
                    .query_map(params![conversation_id, limit, offset], row_to_message)?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                mapped
            }
        };
        Ok(rows)
    }

    pub fn set_message_event_id(&self, message_id: i64, nostr_event_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE messages SET nostr_event_id = ?1 WHERE id = ?2",
            params![nostr_event_id, message_id],
        )?;
        Ok(())
    }

    fn find_message_id_by_record(
        &self,
        conversation_id: &str,
        record_id: &str,
    ) -> Result<Option<i64>> {
        self.conn
            .query_row(
                "SELECT id FROM messages WHERE conversation_id = ?1 AND record_id = ?2",
                params![conversation_id, record_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(ConversationsError::from)
    }

    fn find_message_id_by_event(&self, event_id: &str) -> Result<Option<i64>> {
        self.conn
            .query_row(
                "SELECT id FROM messages WHERE nostr_event_id = ?1",
                [event_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(ConversationsError::from)
    }

    // ==========================================================================
    // Tool messages
    // ==========================================================================

    /// Insert a tool call/result row. Idempotent on
    /// `(conversation_id, tool_call_id)` — re-inserts overwrite the
    /// result fields (so a "call" insert followed by a "result" insert
    /// upgrades the row in place).
    pub fn record_tool_message(&self, conversation_id: &str, tool: &NewToolMessage) -> Result<i64> {
        let call_input_bytes = serde_json::to_vec(&tool.call_input)?;
        let result_bytes = match &tool.result_output {
            Some(v) => Some(serde_json::to_vec(v)?),
            None => None,
        };
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO tool_messages (
                conversation_id, tool_call_id, parent_message_id, agent_pubkey, tool_name,
                call_input, result_output, is_error, timestamp, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(conversation_id, tool_call_id) DO UPDATE SET
                parent_message_id = COALESCE(excluded.parent_message_id, tool_messages.parent_message_id),
                tool_name = excluded.tool_name,
                call_input = excluded.call_input,
                result_output = COALESCE(excluded.result_output, tool_messages.result_output),
                is_error = excluded.is_error,
                timestamp = COALESCE(excluded.timestamp, tool_messages.timestamp)",
            params![
                conversation_id,
                tool.tool_call_id,
                tool.parent_message_id,
                tool.agent_pubkey,
                tool.tool_name,
                call_input_bytes,
                result_bytes,
                tool.is_error as i64,
                tool.timestamp,
                now,
            ],
        )?;
        let id = self.conn.query_row(
            "SELECT id FROM tool_messages WHERE conversation_id = ?1 AND tool_call_id = ?2",
            params![conversation_id, tool.tool_call_id],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(id)
    }

    pub fn list_tool_messages(&self, conversation_id: &str) -> Result<Vec<ToolMessage>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, conversation_id, tool_call_id, parent_message_id, agent_pubkey,
                    tool_name, call_input, result_output, is_error, timestamp, created_at
               FROM tool_messages
              WHERE conversation_id = ?1
              ORDER BY id ASC",
        )?;
        let rows = stmt
            .query_map([conversation_id], row_to_tool_message)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_tool_message(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
    ) -> Result<Option<ToolMessage>> {
        self.conn
            .query_row(
                "SELECT id, conversation_id, tool_call_id, parent_message_id, agent_pubkey,
                        tool_name, call_input, result_output, is_error, timestamp, created_at
                   FROM tool_messages
                  WHERE conversation_id = ?1 AND tool_call_id = ?2",
                params![conversation_id, tool_call_id],
                row_to_tool_message,
            )
            .optional()
            .map_err(ConversationsError::from)
    }

    // ==========================================================================
    // Agent prompt history
    // ==========================================================================

    pub fn append_prompt_history(
        &self,
        conversation_id: &str,
        entry: &NewPromptHistoryEntry,
    ) -> Result<i64> {
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO agent_prompt_history (
                conversation_id, agent_pubkey, prompt_id, sequence, role,
                source_kind, source_message_id, source_record_id, source_event_id,
                overlay_type, content_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(conversation_id, agent_pubkey, prompt_id) DO UPDATE SET
                sequence = excluded.sequence,
                role = excluded.role,
                source_kind = excluded.source_kind,
                source_message_id = excluded.source_message_id,
                source_record_id = excluded.source_record_id,
                source_event_id = excluded.source_event_id,
                overlay_type = excluded.overlay_type,
                content_json = excluded.content_json",
            params![
                conversation_id,
                entry.agent_pubkey,
                entry.prompt_id,
                entry.sequence,
                entry.role,
                entry.source_kind,
                entry.source_message_id,
                entry.source_record_id,
                entry.source_event_id,
                entry.overlay_type,
                entry.content.to_string(),
                now,
            ],
        )?;
        let id = self.conn.query_row(
            "SELECT id FROM agent_prompt_history
              WHERE conversation_id = ?1 AND agent_pubkey = ?2 AND prompt_id = ?3",
            params![conversation_id, entry.agent_pubkey, entry.prompt_id],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(id)
    }

    pub fn list_prompt_history(
        &self,
        conversation_id: &str,
        agent_pubkey: &str,
    ) -> Result<Vec<PromptHistoryEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, conversation_id, agent_pubkey, prompt_id, sequence, role,
                    source_kind, source_message_id, source_record_id, source_event_id,
                    overlay_type, content_json, created_at
               FROM agent_prompt_history
              WHERE conversation_id = ?1 AND agent_pubkey = ?2
              ORDER BY sequence ASC, id ASC",
        )?;
        let rows = stmt
            .query_map(
                params![conversation_id, agent_pubkey],
                row_to_prompt_history,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ==========================================================================
    // Agent context state
    // ==========================================================================

    pub fn get_agent_context_state(
        &self,
        conversation_id: &str,
        agent_pubkey: &str,
    ) -> Result<Option<AgentContextState>> {
        self.conn
            .query_row(
                "SELECT conversation_id, agent_pubkey, next_prompt_sequence, cache_anchored,
                        seen_message_ids_json, compaction_state_json, reminder_state_json,
                        reminder_delta_state_json, todos_json, self_applied_skills_json,
                        meta_model_variant, is_blocked, todo_nudged, updated_at
                   FROM agent_context_state
                  WHERE conversation_id = ?1 AND agent_pubkey = ?2",
                params![conversation_id, agent_pubkey],
                row_to_agent_context_state,
            )
            .optional()
            .map_err(ConversationsError::from)
    }

    pub fn upsert_agent_context_state(&self, state: &AgentContextState) -> Result<()> {
        let seen_json = serde_json::to_string(&state.seen_message_ids)?;
        self.conn.execute(
            "INSERT INTO agent_context_state (
                conversation_id, agent_pubkey, next_prompt_sequence, cache_anchored,
                seen_message_ids_json, compaction_state_json, reminder_state_json,
                reminder_delta_state_json, todos_json, self_applied_skills_json,
                meta_model_variant, is_blocked, todo_nudged, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(conversation_id, agent_pubkey) DO UPDATE SET
                next_prompt_sequence = excluded.next_prompt_sequence,
                cache_anchored = excluded.cache_anchored,
                seen_message_ids_json = excluded.seen_message_ids_json,
                compaction_state_json = excluded.compaction_state_json,
                reminder_state_json = excluded.reminder_state_json,
                reminder_delta_state_json = excluded.reminder_delta_state_json,
                todos_json = excluded.todos_json,
                self_applied_skills_json = excluded.self_applied_skills_json,
                meta_model_variant = excluded.meta_model_variant,
                is_blocked = excluded.is_blocked,
                todo_nudged = excluded.todo_nudged,
                updated_at = excluded.updated_at",
            params![
                state.conversation_id,
                state.agent_pubkey,
                state.next_prompt_sequence,
                state.cache_anchored as i64,
                seen_json,
                state.compaction_state.as_ref().map(|v| v.to_string()),
                state.reminder_state.as_ref().map(|v| v.to_string()),
                state.reminder_delta_state.as_ref().map(|v| v.to_string()),
                state.todos.as_ref().map(|v| v.to_string()),
                state.self_applied_skills.as_ref().map(|v| v.to_string()),
                state.meta_model_variant,
                state.is_blocked as i64,
                state.todo_nudged as i64,
                state.updated_at,
            ],
        )?;
        Ok(())
    }

    // ==========================================================================
    // Completions
    // ==========================================================================

    pub fn record_completion(
        &self,
        conversation_id: &str,
        completion: &NewCompletion,
    ) -> Result<i64> {
        if let Some(event_id) = &completion.nostr_event_id {
            if let Some(existing) = self.find_completion_by_event(event_id)? {
                return Ok(existing);
            }
        }

        self.conn.execute(
            "INSERT INTO completions (
                conversation_id, root_event_id, completed_by_pubkey, recipient_pubkey,
                status, abort_reason, nostr_event_id, completed_at, metadata_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(conversation_id, completed_by_pubkey, completed_at, status) DO UPDATE SET
                recipient_pubkey = COALESCE(excluded.recipient_pubkey, completions.recipient_pubkey),
                root_event_id = COALESCE(excluded.root_event_id, completions.root_event_id),
                abort_reason = COALESCE(excluded.abort_reason, completions.abort_reason),
                nostr_event_id = COALESCE(excluded.nostr_event_id, completions.nostr_event_id),
                metadata_json = COALESCE(excluded.metadata_json, completions.metadata_json)",
            params![
                conversation_id,
                completion.root_event_id,
                completion.completed_by_pubkey,
                completion.recipient_pubkey,
                completion.status.as_str(),
                completion.abort_reason,
                completion.nostr_event_id,
                completion.completed_at,
                completion.metadata.as_ref().map(|v| v.to_string()),
            ],
        )?;
        let id = self.conn.query_row(
            "SELECT id FROM completions
              WHERE conversation_id = ?1 AND completed_by_pubkey = ?2
                AND completed_at = ?3 AND status = ?4",
            params![
                conversation_id,
                completion.completed_by_pubkey,
                completion.completed_at,
                completion.status.as_str(),
            ],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(id)
    }

    pub fn list_completions(&self, conversation_id: &str) -> Result<Vec<Completion>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, conversation_id, root_event_id, completed_by_pubkey, recipient_pubkey,
                    status, abort_reason, nostr_event_id, completed_at, metadata_json
               FROM completions
              WHERE conversation_id = ?1
              ORDER BY completed_at ASC, id ASC",
        )?;
        let rows = stmt
            .query_map([conversation_id], row_to_completion)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn find_completion_by_event(&self, nostr_event_id: &str) -> Result<Option<i64>> {
        self.conn
            .query_row(
                "SELECT id FROM completions WHERE nostr_event_id = ?1",
                [nostr_event_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(ConversationsError::from)
    }

    // ==========================================================================
    // Delegation
    // ==========================================================================

    /// Returns `true` when the given conversation has at least one child
    /// delegation that has not yet received a completion record.
    ///
    /// Child conversations store their delegation route in
    /// `runtime_state_json -> $.rustRuntime.delegation.parent_conversation_id`.
    /// A child is considered still in flight when no row exists in `completions`
    /// for it.
    pub fn has_active_delegation(&self, conversation_id: &str) -> Result<bool> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*)
               FROM conversations c
              WHERE json_extract(c.runtime_state_json,
                        '$.rustRuntime.delegation.parent_conversation_id') = ?1
                AND NOT EXISTS (
                        SELECT 1 FROM completions cmp
                         WHERE cmp.conversation_id = c.id
                    )",
            [conversation_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    // ==========================================================================
    // Maintenance
    // ==========================================================================

    pub fn vacuum(&self) -> Result<()> {
        self.conn.execute_batch("VACUUM")?;
        Ok(())
    }

    pub fn integrity_check(&self) -> Result<String> {
        let result: String = self
            .conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        Ok(result)
    }
}

// ==========================================================================
// Row mappers
// ==========================================================================

fn parse_json_column(s: &str) -> std::result::Result<serde_json::Value, rusqlite::Error> {
    serde_json::from_str(s).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
    })
}

fn parse_optional_json_column(
    s: Option<String>,
) -> std::result::Result<Option<serde_json::Value>, rusqlite::Error> {
    s.map(|raw| parse_json_column(&raw)).transpose()
}

fn parse_blob_json(blob: Vec<u8>) -> std::result::Result<serde_json::Value, rusqlite::Error> {
    serde_json::from_slice(&blob).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, Box::new(err))
    })
}

fn row_to_conversation(row: &Row<'_>) -> rusqlite::Result<ConversationRow> {
    let metadata_raw: String = row.get(9)?;
    let runtime_raw: String = row.get(10)?;
    Ok(ConversationRow {
        id: row.get(0)?,
        title: row.get(1)?,
        summary: row.get(2)?,
        last_user_message: row.get(3)?,
        status_label: row.get(4)?,
        status_current_activity: row.get(5)?,
        owner_pubkey: row.get(6)?,
        created_at: row.get(7)?,
        last_activity: row.get(8)?,
        metadata: parse_json_column(&metadata_raw)?,
        runtime_state: parse_json_column(&runtime_raw)?,
        updated_at: row.get(11)?,
    })
}

fn row_to_message(row: &Row<'_>) -> rusqlite::Result<MessageRecord> {
    let targeted_pubkeys_raw: Option<String> = row.get(12)?;
    let targeted_pubkeys = match targeted_pubkeys_raw {
        Some(raw) => Some(serde_json::from_str::<Vec<String>>(&raw).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
        })?),
        None => None,
    };
    Ok(MessageRecord {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        record_id: row.get(2)?,
        nostr_event_id: row.get(3)?,
        sequence: row.get(4)?,
        author_pubkey: row.get(5)?,
        sender_pubkey: row.get(6)?,
        ral: row.get(7)?,
        message_type: row.get(8)?,
        role: row.get(9)?,
        content: row.get(10)?,
        timestamp: row.get(11)?,
        targeted_pubkeys,
        sender_principal: parse_optional_json_column(row.get(13)?)?,
        targeted_principals: parse_optional_json_column(row.get(14)?)?,
        tool_data: parse_optional_json_column(row.get(15)?)?,
        delegation_marker: parse_optional_json_column(row.get(16)?)?,
        human_readable: row.get(17)?,
        transcript_tool_attributes: parse_optional_json_column(row.get(18)?)?,
        created_at: row.get(19)?,
    })
}

fn row_to_tool_message(row: &Row<'_>) -> rusqlite::Result<ToolMessage> {
    let call_input_blob: Vec<u8> = row.get(6)?;
    let result_output_blob: Option<Vec<u8>> = row.get(7)?;
    let result_output = match result_output_blob {
        Some(b) => Some(parse_blob_json(b)?),
        None => None,
    };
    let is_error_int: i64 = row.get(8)?;
    Ok(ToolMessage {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        tool_call_id: row.get(2)?,
        parent_message_id: row.get(3)?,
        agent_pubkey: row.get(4)?,
        tool_name: row.get(5)?,
        call_input: parse_blob_json(call_input_blob)?,
        result_output,
        is_error: is_error_int != 0,
        timestamp: row.get(9)?,
        created_at: row.get(10)?,
    })
}

fn row_to_prompt_history(row: &Row<'_>) -> rusqlite::Result<PromptHistoryEntry> {
    let content_raw: String = row.get(11)?;
    Ok(PromptHistoryEntry {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        agent_pubkey: row.get(2)?,
        prompt_id: row.get(3)?,
        sequence: row.get(4)?,
        role: row.get(5)?,
        source_kind: row.get(6)?,
        source_message_id: row.get(7)?,
        source_record_id: row.get(8)?,
        source_event_id: row.get(9)?,
        overlay_type: row.get(10)?,
        content: parse_json_column(&content_raw)?,
        created_at: row.get(12)?,
    })
}

fn row_to_agent_context_state(row: &Row<'_>) -> rusqlite::Result<AgentContextState> {
    let seen_raw: String = row.get(4)?;
    let seen_message_ids = serde_json::from_str::<Vec<String>>(&seen_raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
    })?;
    let cache_anchored: i64 = row.get(3)?;
    let is_blocked: i64 = row.get(11)?;
    let todo_nudged: i64 = row.get(12)?;
    Ok(AgentContextState {
        conversation_id: row.get(0)?,
        agent_pubkey: row.get(1)?,
        next_prompt_sequence: row.get(2)?,
        cache_anchored: cache_anchored != 0,
        seen_message_ids,
        compaction_state: parse_optional_json_column(row.get(5)?)?,
        reminder_state: parse_optional_json_column(row.get(6)?)?,
        reminder_delta_state: parse_optional_json_column(row.get(7)?)?,
        todos: parse_optional_json_column(row.get(8)?)?,
        self_applied_skills: parse_optional_json_column(row.get(9)?)?,
        meta_model_variant: row.get(10)?,
        is_blocked: is_blocked != 0,
        todo_nudged: todo_nudged != 0,
        updated_at: row.get(13)?,
    })
}

fn row_to_completion(row: &Row<'_>) -> rusqlite::Result<Completion> {
    let status_raw: String = row.get(5)?;
    let status = CompletionStatus::parse(&status_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown completion status: {status_raw}"),
            )),
        )
    })?;
    Ok(Completion {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        root_event_id: row.get(2)?,
        completed_by_pubkey: row.get(3)?,
        recipient_pubkey: row.get(4)?,
        status,
        abort_reason: row.get(6)?,
        nostr_event_id: row.get(7)?,
        completed_at: row.get(8)?,
        metadata: parse_optional_json_column(row.get(9)?)?,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
