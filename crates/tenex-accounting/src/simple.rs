//! Convenience helpers for crates that need to record one self-contained
//! LLM call without managing the recorder, trace, and span lifecycles
//! themselves.
//!
//! The recorder is opened lazily against `TENEX_ACCOUNTING_DB` (or the
//! default path) on first use; failures collapse to a no-op so accounting
//! never breaks the calling code path.

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::OnceCell;

use crate::recorder::{
    LlmCallFinish, LlmCallStart, RecordedMessage, Recorder, RootKind, RootKindOrStr, TraceRoot,
};

static RECORDER: OnceCell<Option<Arc<Recorder>>> = OnceCell::const_new();

/// Resolve the process-wide `Recorder`, opening it on first use. Returns
/// `None` if the database failed to open — calls then become no-ops.
pub async fn recorder() -> Option<Arc<Recorder>> {
    RECORDER
        .get_or_init(|| async {
            let path = std::env::var("TENEX_ACCOUNTING_DB")
                .map(PathBuf::from)
                .unwrap_or_else(|_| crate::default_db_path());
            match Recorder::open(path.clone()).await {
                Ok(r) => {
                    eprintln!(
                        "[tenex-accounting] recorder ready: {}",
                        path.display()
                    );
                    Some(Arc::new(r))
                }
                Err(e) => {
                    eprintln!("[tenex-accounting] recorder open failed: {e:#}");
                    None
                }
            }
        })
        .await
        .clone()
}

/// Token usage captured from an LLM call. Mirrors the shape exposed by
/// rig's `Usage` so callers using rig can populate this directly without
/// pulling rig as a dep on `tenex-accounting`.
#[derive(Debug, Clone, Default)]
pub struct LlmUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: Option<u64>,
}

/// Inputs for [`record_llm_call`]. All optional context fields default
/// to `None`; populate whichever are known at the call site.
#[derive(Debug, Clone, Default)]
pub struct RecordLlmCall {
    pub root_kind: RootKindOrStr,
    pub provider: String,
    pub provider_model_id: String,
    pub operation: String,
    pub agent_pubkey: Option<String>,
    pub agent_slug: Option<String>,
    pub agent_role: Option<String>,
    pub conversation_id: Option<String>,
    pub project_id: Option<String>,
    pub user_pubkey: Option<String>,
    pub triggering_event_id: Option<String>,
    pub triggering_kind: Option<i64>,
    pub triggering_pubkey: Option<String>,
    pub user_message: Option<String>,
    pub assistant_response: Option<String>,
    pub usage: LlmUsage,
    pub finish_reason: Option<String>,
}

/// Record one completed LLM call as a single-span trace. Submission is
/// queued; the writer drains asynchronously. Errors are logged to stderr
/// and swallowed. Callers that need durability before exit (e.g. the agent
/// turn loop closing out a request) must call [`flush`] explicitly.
pub async fn record_llm_call(params: RecordLlmCall) {
    let Some(rec) = recorder().await else {
        return;
    };
    let trace = match rec
        .open_trace(TraceRoot {
            root_kind: params.root_kind,
            project_id: params.project_id,
            conversation_id: params.conversation_id,
            user_pubkey: params.user_pubkey,
            triggering_event_id: params.triggering_event_id,
            triggering_kind: params.triggering_kind,
            triggering_pubkey: params
                .triggering_pubkey
                .or_else(|| params.agent_pubkey.clone()),
            ..Default::default()
        })
        .await
    {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[tenex-accounting] open_trace failed: {e:#}");
            return;
        }
    };
    let mut messages = Vec::new();
    if let Some(c) = params.user_message {
        messages.push(RecordedMessage {
            role: "user".into(),
            classification: Some("user".into()),
            content: c,
            tokens_estimated: None,
            cache_breakpoint_after: false,
        });
    }
    if let Some(c) = params.assistant_response {
        messages.push(RecordedMessage {
            role: "assistant".into(),
            classification: Some("assistant".into()),
            content: c,
            tokens_estimated: None,
            cache_breakpoint_after: false,
        });
    }
    let n_messages = messages.len() as i64;
    let span = match trace
        .open_llm_call(LlmCallStart {
            provider: params.provider,
            provider_model_id: params.provider_model_id,
            operation: params.operation,
            agent_pubkey: params.agent_pubkey,
            agent_slug: params.agent_slug,
            agent_role: params.agent_role,
            n_messages_sent: Some(n_messages),
            messages,
            ..Default::default()
        })
        .await
    {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[tenex-accounting] open_llm_call failed: {e:#}");
            return;
        }
    };
    let _ = params.usage.total_tokens;
    if let Err(e) = span
        .finish_ok(LlmCallFinish {
            input_tokens: params.usage.input_tokens,
            output_tokens: params.usage.output_tokens,
            reasoning_tokens: params.usage.reasoning_tokens,
            cache_read_tokens: params.usage.cached_input_tokens,
            cache_write_tokens: params.usage.cache_creation_input_tokens,
            cached_input_tokens: params.usage.cached_input_tokens,
            finish_reason: params.finish_reason,
            ..Default::default()
        })
        .await
    {
        eprintln!("[tenex-accounting] llm finish_ok failed: {e:#}");
    }
    if let Err(e) = trace.finish_ok(None).await {
        eprintln!("[tenex-accounting] trace.finish_ok failed: {e:#}");
    }
}

/// Block until the writer queue has drained. Use at process boundaries
/// (turn-loop end, daemon shutdown) where durability matters.
pub async fn flush() {
    let Some(rec) = recorder().await else {
        return;
    };
    if let Err(e) = rec.flush().await {
        eprintln!("[tenex-accounting] flush failed: {e:#}");
    }
}

/// Convenience constructors mapping common operation strings to their
/// canonical `RootKind`. These are not exhaustive — callers can construct
/// `RootKindOrStr::Other(...)` directly for one-off operations.
impl RecordLlmCall {
    pub fn new(provider: impl Into<String>, model: impl Into<String>, operation: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            provider_model_id: model.into(),
            operation: operation.into(),
            ..Self::default()
        }
    }

    pub fn with_root_kind(mut self, kind: RootKind) -> Self {
        self.root_kind = RootKindOrStr::Known(kind);
        self
    }

    pub fn with_root_label(mut self, label: impl Into<String>) -> Self {
        self.root_kind = RootKindOrStr::Other(label.into());
        self
    }
}
