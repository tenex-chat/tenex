//! Convenience helpers for crates that need to record one self-contained
//! LLM call without managing the recorder, trace, and span lifecycles
//! themselves.
//!
//! The recorder is opened lazily against `TENEX_ACCOUNTING_DB` (or the
//! default path) on first use; failures collapse to a no-op so accounting
//! never breaks the calling code path.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::OnceCell;

use crate::recorder::{
    LlmCallFinish, LlmCallStart, RecordedMessage, Recorder, RootKind, RootKindOrStr, TraceHandle,
    TraceRoot,
};

tokio::task_local! {
    static CURRENT_TRACE: TraceHandle;
}

/// Run `fut` with `handle` installed as the ambient accounting trace for
/// the current async task. While this scope is active, [`record_llm_call`]
/// will open spans on `handle` instead of opening a fresh trace per call.
///
/// `handle = None` is a no-op scope: `fut` runs unchanged and any nested
/// `record_llm_call` falls through to its open-its-own-trace behavior.
/// This shape lets the agent turn loop forward the result of
/// [`open_trace`] (which itself can be `None` if the recorder failed to
/// open) without branching at every call site.
pub async fn with_trace<F, T>(handle: Option<TraceHandle>, fut: F) -> T
where
    F: Future<Output = T>,
{
    match handle {
        Some(h) => CURRENT_TRACE.scope(h, fut).await,
        None => fut.await,
    }
}

fn current_trace() -> Option<TraceHandle> {
    CURRENT_TRACE.try_with(|t| t.clone()).ok()
}

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

/// Record one completed LLM call. If a trace is active in the current
/// task (set via [`with_trace`]), the call is recorded as a child span on
/// that trace and the trace is left open. Otherwise a fresh single-span
/// trace is opened and closed for this call alone.
///
/// Submission is queued; the writer drains asynchronously. Errors are
/// logged to stderr and swallowed. Callers that need durability before
/// exit (e.g. the agent turn loop closing out a request) must call
/// [`flush`] explicitly.
pub async fn record_llm_call(params: RecordLlmCall) {
    let ambient = current_trace();
    let owns_trace = ambient.is_none();
    let trace = match ambient {
        Some(t) => t,
        None => {
            let Some(rec) = recorder().await else {
                return;
            };
            match rec
                .open_trace(TraceRoot {
                    root_kind: params.root_kind,
                    project_id: params.project_id.clone(),
                    conversation_id: params.conversation_id.clone(),
                    user_pubkey: params.user_pubkey.clone(),
                    triggering_event_id: params.triggering_event_id.clone(),
                    triggering_kind: params.triggering_kind,
                    triggering_pubkey: params
                        .triggering_pubkey
                        .clone()
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
            }
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
    if owns_trace {
        if let Err(e) = trace.finish_ok(None).await {
            eprintln!("[tenex-accounting] trace.finish_ok failed: {e:#}");
        }
    }
}

/// Open a trace from `params` (the same root-kind / context fields used
/// by [`record_llm_call`]) and return the handle. The caller is
/// responsible for installing it via [`with_trace`] and finishing it via
/// [`finish_trace`].
pub async fn open_trace(params: &RecordLlmCall) -> Option<TraceHandle> {
    let rec = recorder().await?;
    match rec
        .open_trace(TraceRoot {
            root_kind: params.root_kind.clone(),
            project_id: params.project_id.clone(),
            conversation_id: params.conversation_id.clone(),
            user_pubkey: params.user_pubkey.clone(),
            triggering_event_id: params.triggering_event_id.clone(),
            triggering_kind: params.triggering_kind,
            triggering_pubkey: params
                .triggering_pubkey
                .clone()
                .or_else(|| params.agent_pubkey.clone()),
            ..Default::default()
        })
        .await
    {
        Ok(t) => Some(t),
        Err(e) => {
            eprintln!("[tenex-accounting] open_trace failed: {e:#}");
            None
        }
    }
}

/// Finalize a trace previously returned by [`open_trace`]. No-op if the
/// trace is `None`.
pub async fn finish_trace(trace: Option<TraceHandle>) {
    let Some(t) = trace else { return };
    if let Err(e) = t.finish_ok(None).await {
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
