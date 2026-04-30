//! Fire-and-forget bridge from `tenex-agent` to `tenex-accounting`.
//!
//! The recorder is lazily opened on first use against `TENEX_ACCOUNTING_DB`
//! (or the default path). Recording is always on — there is no opt-out.
//!
//! Each call records a single trace with one `llm_call` span — sufficient for
//! cost / token / latency analytics. Hierarchical multi-span traces (one
//! trace per conversation, spans per delegation) are a Phase-2 follow-up.
//!
//! Errors are logged and swallowed: accounting must never break the agent.

use std::path::PathBuf;
use std::sync::Arc;

use tenex_accounting::{
    LlmCallFinish, LlmCallStart, RecordedMessage, Recorder, RootKind, RootKindOrStr, TraceRoot,
};
use tokio::sync::OnceCell;

static RECORDER: OnceCell<Option<Arc<Recorder>>> = OnceCell::const_new();

/// Resolve the Recorder, lazily opening it on first use. Returns `None` only
/// if the recorder failed to open (in which case calls become no-ops).
async fn recorder() -> Option<Arc<Recorder>> {
    RECORDER
        .get_or_init(|| async {
            let path = std::env::var("TENEX_ACCOUNTING_DB")
                .map(PathBuf::from)
                .unwrap_or_else(|_| tenex_accounting::default_db_path());
            match Recorder::open(path.clone()).await {
                Ok(r) => {
                    eprintln!(
                        "[tenex-agent] accounting recorder ready: {}",
                        path.display()
                    );
                    Some(Arc::new(r))
                }
                Err(e) => {
                    eprintln!("[tenex-agent] accounting recorder open failed: {e:#}");
                    None
                }
            }
        })
        .await
        .clone()
}

/// Record one completed LLM turn. Fire-and-forget — never blocks the caller
/// for more than a channel send.
#[allow(clippy::too_many_arguments)]
pub fn record_turn(
    provider: &str,
    provider_model_id: &str,
    operation: &str,
    agent_pubkey_hex: Option<String>,
    agent_slug: Option<String>,
    conversation_id: Option<String>,
    project_id: Option<String>,
    user_message: Option<String>,
    assistant_response: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    cached_input_tokens: u64,
    reasoning_tokens: u64,
    total_tokens: Option<u64>,
    finish_reason: Option<String>,
) {
    let provider = provider.to_string();
    let model = provider_model_id.to_string();
    let operation = operation.to_string();
    tokio::spawn(async move {
        let Some(rec) = recorder().await else {
            return;
        };
        let trace = match rec
            .open_trace(TraceRoot {
                root_kind: RootKindOrStr::Known(RootKind::UserMessage),
                project_id,
                conversation_id,
                user_pubkey: None,
                triggering_pubkey: agent_pubkey_hex.clone(),
                ..Default::default()
            })
            .await
        {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[tenex-agent] accounting open_trace failed: {e:#}");
                return;
            }
        };
        let mut messages = Vec::new();
        if let Some(c) = user_message {
            messages.push(RecordedMessage {
                role: "user".into(),
                classification: Some("user".into()),
                content: c,
                tokens_estimated: None,
                cache_breakpoint_after: false,
            });
        }
        if let Some(c) = assistant_response {
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
                provider: provider.clone(),
                provider_model_id: model.clone(),
                operation,
                api_key_label: None,
                api_key_identity: None,
                agent_pubkey: agent_pubkey_hex,
                agent_slug,
                agent_role: None,
                temperature: None,
                top_p: None,
                max_tokens_requested: None,
                seed: None,
                n_messages_sent: Some(n_messages),
                n_tools_offered: None,
                system_prompt_hash: None,
                messages_prefix_hash: None,
                messages,
                queued_at_ms: None,
            })
            .await
        {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[tenex-agent] accounting open_llm_call failed: {e:#}");
                return;
            }
        };
        let _ = total_tokens;
        if let Err(e) = span
            .finish_ok(LlmCallFinish {
                input_tokens,
                output_tokens,
                reasoning_tokens,
                cache_read_tokens,
                cache_write_tokens,
                cached_input_tokens,
                finish_reason,
                ..Default::default()
            })
            .await
        {
            eprintln!("[tenex-agent] accounting finish_ok failed: {e:#}");
        }
        if let Err(e) = trace.finish_ok(None).await {
            eprintln!("[tenex-agent] accounting trace.finish_ok failed: {e:#}");
        }
    });
}
