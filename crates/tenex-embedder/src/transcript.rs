//! Adapter from `tenex_protocol::transcript::TranscriptLine` to the
//! local chunker's `TranscriptItem`. The chunker was originally written
//! against `MessageRecord`-derived items (with `sequence` numbers); now
//! that we read from the relay there is no canonical sequence — we use
//! a synthesized monotonic ordinal based on the merged event stream.

use tenex_protocol::transcript::TranscriptLine;

/// One unit in the rendered transcript stream. The original embedder
/// also synthesized delegation markers; the relay-sourced design drops
/// that — every reply event in the thread is already a real message.
#[derive(Debug, Clone)]
pub struct TranscriptItem {
    /// Synthetic monotonic ordinal used as `seq_start` / `seq_end`
    /// when we record a chunk. Has no meaning beyond ordering and
    /// chunk-range labelling.
    pub sequence: i64,
    pub timestamp_secs: i64,
    pub speaker: String,
    pub body: String,
    pub event_id: String,
}

impl TranscriptItem {
    pub fn render(&self) -> String {
        format!("{}: {}", self.speaker, self.body)
    }

    pub fn rendered_len(&self) -> usize {
        self.render().len()
    }

    pub fn timestamp_secs(&self) -> i64 {
        self.timestamp_secs
    }
}

/// Adopt a sorted [`TranscriptLine`] stream as `TranscriptItem`s.
/// Sequence numbers are positional ordinals starting at 1.
pub fn adopt(lines: Vec<TranscriptLine>) -> Vec<TranscriptItem> {
    lines
        .into_iter()
        .enumerate()
        .map(|(i, l)| TranscriptItem {
            sequence: (i + 1) as i64,
            timestamp_secs: l.created_at_secs,
            speaker: l.speaker,
            body: l.body,
            event_id: l.event_id,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(ts: i64, speaker: &str, body: &str) -> TranscriptLine {
        TranscriptLine {
            event_id: format!("evid-{ts}"),
            conversation_id: "c".into(),
            author_pubkey: "pk".into(),
            speaker: speaker.into(),
            created_at_secs: ts,
            body: body.into(),
        }
    }

    #[test]
    fn adopt_assigns_sequential_ordinals_starting_at_one() {
        let lines = vec![
            line(100, "Alice", "hi"),
            line(101, "Bob", "hey"),
            line(102, "Alice", "ok"),
        ];
        let items = adopt(lines);
        assert_eq!(items[0].sequence, 1);
        assert_eq!(items[1].sequence, 2);
        assert_eq!(items[2].sequence, 3);
    }

    #[test]
    fn render_format_is_speaker_colon_body() {
        let item = TranscriptItem {
            sequence: 1,
            timestamp_secs: 0,
            speaker: "Alice".into(),
            body: "hello".into(),
            event_id: "evid".into(),
        };
        assert_eq!(item.render(), "Alice: hello");
    }
}
