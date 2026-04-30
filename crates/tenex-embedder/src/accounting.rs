//! Fire-and-forget accounting bridge for `tenex-embedder`.
//!
//! Mirrors `tenex-agent::accounting`: always-on, lazy recorder open against
//! `TENEX_ACCOUNTING_DB` (or default path), errors swallowed. Records each
//! embedded chunk as one `embedding` span attached to a synthetic
//! `embedding_backfill` trace per conversation pass.

use std::path::PathBuf;
use std::sync::Arc;

use tenex_accounting::{
    EmbeddingFinish, EmbeddingStart, Recorder, RootKind, RootKindOrStr, TraceRoot,
};
use tokio::sync::OnceCell;

static RECORDER: OnceCell<Option<Arc<Recorder>>> = OnceCell::const_new();

async fn recorder() -> Option<Arc<Recorder>> {
    RECORDER
        .get_or_init(|| async {
            let path = std::env::var("TENEX_ACCOUNTING_DB")
                .map(PathBuf::from)
                .unwrap_or_else(|_| tenex_accounting::default_db_path());
            match Recorder::open(path.clone()).await {
                Ok(r) => {
                    eprintln!(
                        "[tenex-embedder] accounting recorder ready: {}",
                        path.display()
                    );
                    Some(Arc::new(r))
                }
                Err(e) => {
                    eprintln!("[tenex-embedder] accounting recorder open failed: {e:#}");
                    None
                }
            }
        })
        .await
        .clone()
}

/// Record one embedded chunk. Provider/model defaulted from
/// `TENEX_EMBEDDER_PROVIDER` / `TENEX_EMBEDDER_MODEL` (or "ollama" /
/// "nomic-embed-text") because the embedder selects these at runtime via the
/// configured target — this keeps the call site minimal.
#[allow(clippy::too_many_arguments)]
pub fn record_chunk(
    conversation_id: String,
    chunk_index: i64,
    char_count: i64,
    estimated_tokens: u64,
    vector_storage_target: Option<String>,
) {
    tokio::spawn(async move {
        let Some(rec) = recorder().await else {
            return;
        };
        let provider =
            std::env::var("TENEX_EMBEDDER_PROVIDER").unwrap_or_else(|_| "ollama".to_string());
        let model = std::env::var("TENEX_EMBEDDER_MODEL")
            .unwrap_or_else(|_| "nomic-embed-text".to_string());
        let trace = match rec
            .open_trace(TraceRoot {
                root_kind: RootKindOrStr::Known(RootKind::EmbeddingBackfill),
                conversation_id: Some(conversation_id.clone()),
                label: Some(format!(
                    "embed conversation {conversation_id} chunk {chunk_index}"
                )),
                ..Default::default()
            })
            .await
        {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[tenex-embedder] accounting open_trace failed: {e:#}");
                return;
            }
        };
        let span = match trace
            .open_embedding(EmbeddingStart {
                provider,
                model,
                agent_pubkey: None,
                batch_size: 1,
                total_input_chars: char_count,
                source_kind: Some("conversation_chunk".into()),
                source_event_kind: None,
                source_event_id: Some(conversation_id.clone()),
                vector_storage_target,
            })
            .await
        {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[tenex-embedder] accounting open_embedding failed: {e:#}");
                return;
            }
        };
        if let Err(e) = span
            .finish_ok(EmbeddingFinish {
                total_input_tokens: estimated_tokens,
                dimension: None,
                dedup_skipped_count: 0,
            })
            .await
        {
            eprintln!("[tenex-embedder] accounting finish_ok failed: {e:#}");
        }
        if let Err(e) = trace.finish_ok(None).await {
            eprintln!("[tenex-embedder] accounting trace.finish_ok failed: {e:#}");
        }
    });
}
