//! Per-conversation processing: events → transcript → chunks → diff
//! against existing → embed only what's new.

use std::sync::Arc;

use anyhow::{Context, Result};
use nostr::event::Event;
use serde_json::json;
use tenex_protocol::transcript::{render_events, IdentityResolver};

use crate::chunking::{window, Chunk};
use crate::pacing::Pacer;
use crate::state::{ConversationState, StateStore};
use crate::target::EmbedTarget;
use crate::transcript::adopt;
use crate::tuning::MIN_INTERVAL_MS;

#[derive(Debug, Default, Clone)]
pub struct ConversationPassResult {
    pub chunks_embedded: usize,
    pub events_seen: usize,
    pub skipped_rate_limited: bool,
}

pub struct Processor {
    pub state: Arc<StateStore>,
    pub pacer: Arc<Pacer>,
    /// `true` only for `backfill --reset`. Disables the
    /// no-new-events short-circuit so old conversations get re-embedded
    /// even if their event set hasn't changed.
    pub force_reembed: bool,
}

impl Processor {
    pub fn new(state: Arc<StateStore>, pacer: Arc<Pacer>) -> Self {
        Self {
            state,
            pacer,
            force_reembed: false,
        }
    }

    /// Process one conversation: render transcript, chunk, diff, embed.
    /// `events` is the full set of events known for this conversation
    /// (deduped by the accumulator).
    pub async fn process_conversation(
        &self,
        conversation_id: &str,
        events: &[Event],
        project_ids: &[String],
        resolver: &dyn IdentityResolver,
        target: &EmbedTarget<'_>,
    ) -> Result<ConversationPassResult> {
        let prior = self.state.get(conversation_id)?;
        let now_ms = now_ms();

        // Rate limit.
        if prior.visited_at_ms != 0 && (now_ms - prior.visited_at_ms) < MIN_INTERVAL_MS {
            return Ok(ConversationPassResult {
                skipped_rate_limited: true,
                events_seen: events.len(),
                ..Default::default()
            });
        }

        // No-op short-circuit: same event count and same max created_at
        // means we've already embedded the current state.
        let max_secs = events
            .iter()
            .map(|e| e.created_at.as_secs() as i64)
            .max()
            .unwrap_or(0);
        let count_i64 = events.len() as i64;
        if !self.force_reembed
            && prior.event_count == count_i64
            && prior.last_event_secs == max_secs
            && count_i64 > 0
        {
            return Ok(ConversationPassResult {
                events_seen: events.len(),
                ..Default::default()
            });
        }

        // Render to transcript items.
        let lines = render_events(events, resolver);
        let items = adopt(lines);
        if items.is_empty() {
            // Nothing transcript-worthy. Mark visited so we don't retry every tick.
            let new_state = ConversationState {
                last_event_secs: max_secs,
                event_count: count_i64,
                visited_at_ms: now_ms,
            };
            self.state.put(conversation_id, &new_state)?;
            return Ok(ConversationPassResult {
                events_seen: events.len(),
                ..Default::default()
            });
        }

        let chunks = window(&items);
        if chunks.is_empty() {
            return Ok(ConversationPassResult {
                events_seen: events.len(),
                ..Default::default()
            });
        }

        // Diff against existing chunks.
        let existing = target.list_existing_chunks(conversation_id).await?;
        let mut existing_by_index: std::collections::HashMap<i64, _> =
            std::collections::HashMap::new();
        for r in &existing {
            if let Some(i) = r.chunk_index {
                existing_by_index.insert(i, r);
            }
        }

        let new_highest_index = chunks.last().map(|c| c.chunk_index).unwrap_or(-1);
        let mut embedded = 0usize;

        for chunk in &chunks {
            let want_hash = chunk.content_hash();
            let needs_embed = match existing_by_index.get(&chunk.chunk_index) {
                Some(existing) => {
                    let existing_hash = existing
                        .meta_json
                        .as_ref()
                        .and_then(|j| j.get("content_hash"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    existing_hash != want_hash.as_str() || self.force_reembed
                }
                None => true,
            };

            if needs_embed {
                self.pacer.await_slot().await;
                let title = chunk_title(conversation_id, chunk);
                let body = render_chunk_body(conversation_id, chunk);
                let primary_project_id = if project_ids.len() == 1 {
                    Some(project_ids[0].clone())
                } else {
                    None
                };
                let meta = json!({
                    "conversation_id": conversation_id,
                    "project_id": primary_project_id,
                    "project_ids": project_ids,
                    "content_hash": want_hash,
                    "chunk_index": chunk.chunk_index,
                    "seq_start": chunk.seq_start,
                    "seq_end": chunk.seq_end,
                    "start_ts_secs": chunk.start_ts_secs,
                    "end_ts_secs": chunk.end_ts_secs,
                });
                target
                    .put_chunk(
                        conversation_id,
                        chunk.chunk_index,
                        Some(&title),
                        &body,
                        chunk.seq_start,
                        chunk.seq_end,
                        meta,
                    )
                    .await
                    .context("embed chunk")?;
                crate::accounting::record_chunk(
                    conversation_id.to_string(),
                    chunk.chunk_index,
                    body.len() as i64,
                    (body.len() as u64) / 4, // rough token estimate (4 chars/token)
                    None,
                );
                self.pacer.reset_failures().await;
                embedded += 1;
            }
        }

        // Drop chunks past the new highest index.
        for r in &existing {
            if let Some(i) = r.chunk_index {
                if i > new_highest_index {
                    target
                        .delete_chunk_by_index(conversation_id, i)
                        .await
                        .context("delete obsolete chunk")?;
                }
            }
        }

        let new_state = ConversationState {
            last_event_secs: max_secs,
            event_count: count_i64,
            visited_at_ms: now_ms,
        };
        self.state.put(conversation_id, &new_state)?;

        Ok(ConversationPassResult {
            chunks_embedded: embedded,
            events_seen: events.len(),
            skipped_rate_limited: false,
        })
    }
}

fn chunk_title(conversation_id: &str, chunk: &Chunk) -> String {
    let preview: String = conversation_id.chars().take(8).collect();
    format!(
        "{preview} · msgs {start}–{end}",
        start = chunk.seq_start,
        end = chunk.seq_end
    )
}

fn render_chunk_body(conversation_id: &str, chunk: &Chunk) -> String {
    let mut participants: Vec<String> = Vec::new();
    for item in &chunk.items {
        if !participants.iter().any(|p| p == &item.speaker) {
            participants.push(item.speaker.clone());
        }
    }

    let conversation_preview: String = conversation_id.chars().take(8).collect();
    let mut out = String::new();
    out.push_str(&format!("Conversation: {conversation_preview}\n"));
    out.push_str(&format!(
        "Messages: {a}..{b} ({n})\n",
        a = chunk.seq_start,
        b = chunk.seq_end,
        n = chunk.items.len()
    ));
    out.push_str(&format!(
        "Time: {start_ts}..{end_ts}\n",
        start_ts = chunk.start_ts_secs,
        end_ts = chunk.end_ts_secs
    ));
    if !participants.is_empty() {
        out.push_str(&format!("Participants: {}\n", participants.join(", ")));
    }
    out.push_str("---\n");
    out.push_str(&chunk.body);
    out
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
