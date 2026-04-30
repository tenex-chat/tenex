//! Message-aligned token-budgeted windowing with overlap.

use std::cmp::min;

use sha2::{Digest, Sha256};

use crate::transcript::TranscriptItem;
use crate::tuning::{CHUNK_CEILING_CHARS, CHUNK_TARGET_CHARS, OVERLAP_MESSAGES};

/// One windowed chunk of a transcript stream.
#[derive(Debug, Clone)]
pub struct Chunk {
    pub chunk_index: i64,
    pub seq_start: i64,
    pub seq_end: i64,
    pub start_ts_secs: i64,
    pub end_ts_secs: i64,
    pub is_tail: bool,
    pub items: Vec<TranscriptItem>,
    pub body: String,
}

impl Chunk {
    pub fn content_hash(&self) -> String {
        let mut h = Sha256::new();
        h.update(self.body.as_bytes());
        hex::encode(h.finalize())
    }
}

pub fn window(items: &[TranscriptItem]) -> Vec<Chunk> {
    if items.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut idx = 0usize;
    let mut chunk_index = 0i64;

    while idx < items.len() {
        let (consumed_count, body, items_in_chunk) = build_chunk_starting_at(items, idx);
        let last_idx = idx + consumed_count - 1;
        let is_tail = last_idx == items.len() - 1;

        let seq_start = items_in_chunk.first().map(|i| i.sequence).unwrap_or(0);
        let seq_end = items_in_chunk.last().map(|i| i.sequence).unwrap_or(0);
        let start_ts = items_in_chunk.first().map(|i| i.timestamp_secs).unwrap_or(0);
        let end_ts = items_in_chunk.last().map(|i| i.timestamp_secs).unwrap_or(0);

        chunks.push(Chunk {
            chunk_index,
            seq_start,
            seq_end,
            start_ts_secs: start_ts,
            end_ts_secs: end_ts,
            is_tail,
            items: items_in_chunk,
            body,
        });
        chunk_index += 1;

        if is_tail {
            break;
        }

        let advance = consumed_count.saturating_sub(OVERLAP_MESSAGES).max(1);
        idx += advance;
    }

    chunks
}

fn build_chunk_starting_at(
    items: &[TranscriptItem],
    start: usize,
) -> (usize, String, Vec<TranscriptItem>) {
    let mut body = String::new();
    let mut owned: Vec<TranscriptItem> = Vec::new();
    let mut taken = 0usize;

    for item in &items[start..] {
        let rendered = item.render();
        let rendered_len = rendered.len();

        if owned.is_empty() && rendered_len > CHUNK_CEILING_CHARS {
            let truncated = truncate_to_ceiling(&rendered, CHUNK_CEILING_CHARS);
            body.push_str(&truncated);
            owned.push(item.clone());
            taken = 1;
            break;
        }

        let separator_len = if body.is_empty() { 0 } else { 2 };
        let prospective = body.len() + separator_len + rendered_len;
        if prospective > CHUNK_CEILING_CHARS && !owned.is_empty() {
            break;
        }

        if !body.is_empty() {
            body.push_str("\n\n");
        }
        body.push_str(&rendered);
        owned.push(item.clone());
        taken += 1;

        if body.len() >= CHUNK_TARGET_CHARS {
            break;
        }
    }

    (taken, body, owned)
}

fn truncate_to_ceiling(s: &str, ceiling: usize) -> String {
    let suffix = "…[truncated]";
    if s.len() <= ceiling {
        return s.to_string();
    }
    let target = ceiling.saturating_sub(suffix.len());
    let mut end = min(target, s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = String::with_capacity(end + suffix.len());
    out.push_str(&s[..end]);
    out.push_str(suffix);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(seq: i64, ts: i64, body: &str) -> TranscriptItem {
        TranscriptItem {
            sequence: seq,
            timestamp_secs: ts,
            speaker: "A".into(),
            body: body.to_string(),
            event_id: format!("evid-{seq}"),
        }
    }

    #[test]
    fn empty_input_yields_no_chunks() {
        assert!(window(&[]).is_empty());
    }

    #[test]
    fn single_short_message_yields_one_tail_chunk() {
        let items = vec![item(1, 100, "hello")];
        let chunks = window(&items);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].is_tail);
        assert_eq!(chunks[0].seq_start, 1);
        assert_eq!(chunks[0].seq_end, 1);
        assert_eq!(chunks[0].body, "A: hello");
    }

    #[test]
    fn fills_until_target_then_starts_new_chunk_with_overlap() {
        let body = "x".repeat(50);
        let items: Vec<TranscriptItem> = (1..=400i64).map(|s| item(s, s, &body)).collect();
        let chunks = window(&items);
        assert!(chunks.len() >= 3);
        for c in &chunks {
            assert!(c.body.len() <= CHUNK_CEILING_CHARS);
        }
        for win in chunks.windows(2) {
            let (prev, next) = (&win[0], &win[1]);
            let prev_last_seqs: Vec<i64> = prev
                .items
                .iter()
                .rev()
                .take(OVERLAP_MESSAGES)
                .map(|i| i.sequence)
                .collect();
            let next_first_seq = next.items.first().unwrap().sequence;
            assert!(
                prev_last_seqs.contains(&next_first_seq),
                "expected overlap; prev last seqs {prev_last_seqs:?} did not include {next_first_seq}"
            );
        }
        assert!(chunks.last().unwrap().is_tail);
        assert!(chunks[..chunks.len() - 1].iter().all(|c| !c.is_tail));
    }

    #[test]
    fn oversize_single_message_is_truncated_alone() {
        let huge = "x".repeat(CHUNK_CEILING_CHARS + 1000);
        let items = vec![item(1, 100, &huge), item(2, 101, "follow-up")];
        let chunks = window(&items);
        assert!(chunks[0].body.len() <= CHUNK_CEILING_CHARS);
        assert!(chunks[0].body.contains("…[truncated]"));
        assert_eq!(chunks[0].items.len(), 1);
        assert!(chunks.last().unwrap().body.contains("follow-up"));
    }

    #[test]
    fn chunk_index_is_monotonic_from_zero() {
        let items: Vec<TranscriptItem> = (1..=200i64).map(|s| item(s, s, &"x".repeat(50))).collect();
        let chunks = window(&items);
        for (expected, c) in chunks.iter().enumerate() {
            assert_eq!(c.chunk_index, expected as i64);
        }
    }

    #[test]
    fn content_hash_is_stable_for_same_body() {
        let c1 = Chunk {
            chunk_index: 0,
            seq_start: 1,
            seq_end: 5,
            start_ts_secs: 0,
            end_ts_secs: 10,
            is_tail: true,
            items: vec![],
            body: "hello".into(),
        };
        let mut c2 = c1.clone();
        c2.chunk_index = 99;
        c2.is_tail = false;
        assert_eq!(c1.content_hash(), c2.content_hash());
    }
}
