//! Transport-agnostic intent vocabulary.
//!
//! Mirrors the nine intent variants from `src/nostr/AgentEventEncoder.ts`. The
//! intent layer carries no transport-specific fields; transport details live
//! either in the [`refs`](crate::refs) types or in the per-transport encoder.

use crate::refs::{ConversationRef, MessageRef, PrincipalRef};

/// LLM token-and-cost accounting attached to an emitted message.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LlmUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub cost_usd: Option<f64>,
}

/// Provider-side LLM bookkeeping (thread/turn ids and tool-call counters).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LlmMetadata {
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub tool_total_calls: Option<u64>,
    pub tool_total_duration_ms: Option<u64>,
    pub tool_command_calls: Option<u64>,
    pub tool_file_change_calls: Option<u64>,
    pub tool_mcp_calls: Option<u64>,
    pub tool_other_calls: Option<u64>,
}

/// Final response from an agent. Carries usage totals and triggers a notification.
#[derive(Debug, Clone)]
pub struct CompletionIntent {
    pub content: String,
    pub usage: Option<LlmUsage>,
    pub metadata: Option<LlmMetadata>,
}

/// Mid-loop response. No notification, no status — used for intermediate text.
#[derive(Debug, Clone)]
pub struct ConversationIntent {
    pub content: String,
    pub is_reasoning: bool,
    pub usage: Option<LlmUsage>,
    pub metadata: Option<LlmMetadata>,
}

/// One delegation request inside a [`DelegationIntent`].
///
/// `recipient_label` is the literal `@slug` or `nostr:npub…` prefix injected
/// into the content body. Caller resolves slug→pubkey and chooses the label.
#[derive(Debug, Clone)]
pub struct DelegationRequest {
    pub recipient: PrincipalRef,
    pub recipient_label: String,
    pub request: String,
    pub branch: Option<String>,
    /// Expected git commit hash on `branch`. Set on cross-host delegations so
    /// the receiver can sync its worktree to the exact commit the sender
    /// pushed, eliminating filesystem coupling.
    pub commit: Option<String>,
    /// When set, the outbound event carries an e-tag referencing this message,
    /// turning the delegation into a followup rather than a fresh conversation.
    pub followup_of: Option<MessageRef>,
    /// Extra raw Nostr tags for fresh delegation routing metadata.
    pub extra_tags: Vec<Vec<String>>,
}

/// Delegate work to one or more other agents. Each request becomes a separate
/// event with no thread e-tag (delegations start fresh conversations).
#[derive(Debug, Clone)]
pub struct DelegationIntent {
    pub items: Vec<DelegationRequest>,
}

/// One question inside an [`AskIntent`].
#[derive(Debug, Clone)]
pub enum AskQuestion {
    SingleSelect {
        title: String,
        prompt: String,
        suggestions: Vec<String>,
    },
    MultiSelect {
        title: String,
        prompt: String,
        options: Vec<String>,
    },
}

/// Ask a human a structured question. Always p-tags the recipient and ships
/// `["intent","ask"]`.
#[derive(Debug, Clone)]
pub struct AskIntent {
    pub title: String,
    pub context: String,
    pub questions: Vec<AskQuestion>,
    pub recipient: PrincipalRef,
}

/// Finalize an execution with an error. Like a completion but with `["error", …]`.
#[derive(Debug, Clone)]
pub struct ErrorIntent {
    pub message: String,
    pub error_type: Option<String>,
}

/// Persist a learned lesson (kind:4129).
#[derive(Debug, Clone)]
pub struct LessonIntent {
    pub title: String,
    pub lesson: String,
    pub category: Option<String>,
    pub hashtags: Vec<String>,
    pub agent_definition_id: Option<MessageRef>,
}

/// Tool invocation tracking event (kind:1 with `tool` / `tool-args` / `q` tags).
///
/// `args_json` is pre-serialized by the caller. The encoder enforces the 100 KB
/// cap rule itself: oversized payloads emit an empty `["tool-args"]` tag.
///
/// `extra_tags` carries additional tag arrays the caller wants injected into
/// the kind:1 event after the standard tool tags. Each inner `Vec<String>` is
/// passed through `Tag::parse` verbatim — the first element is the tag name
/// and the rest are values (e.g. `vec!["url".into(), "https://…".into()]`).
#[derive(Debug, Clone)]
pub struct ToolUseIntent {
    pub tool_name: String,
    pub content: String,
    pub args_json: Option<String>,
    pub referenced_messages: Vec<MessageRef>,
    pub usage: Option<LlmUsage>,
    pub extra_tags: Vec<Vec<String>>,
}

/// Ephemeral live-update delta (kind:24135). Best-effort; not a snapshot.
#[derive(Debug, Clone)]
pub struct StreamTextDeltaIntent {
    pub delta: String,
    pub sequence: u64,
}

/// Standalone intervention review request — no thread anchoring.
#[derive(Debug, Clone)]
pub struct InterventionReviewIntent {
    pub target: PrincipalRef,
    pub conversation: ConversationRef,
    pub user_name: String,
    pub agent_name: String,
}

/// Publish a markdown file as a NIP-23 long-form article (kind:30023).
///
/// Each file in a `report_publish` batch becomes one intent. The encoder
/// emits a replaceable event keyed on `d_tag` and linked to the project via
/// an `["a", "31933:…"]` tag.
#[derive(Debug, Clone)]
pub struct PublishArticleIntent {
    /// NIP-33 replaceable event identifier — filename for single files,
    /// `dirName/relative/path` for directory entries.
    pub d_tag: String,
    /// Human-readable document grouping — filename without extension, or
    /// directory base name when publishing a directory recursively.
    pub document_tag: String,
    /// NIP-23 article title.
    pub title: String,
    pub content: String,
}

/// The full set of intents an agent can emit on a [`Channel`](crate::Channel).
#[derive(Debug, Clone)]
pub enum Intent {
    Completion(CompletionIntent),
    Conversation(ConversationIntent),
    Delegation(DelegationIntent),
    Ask(AskIntent),
    Error(ErrorIntent),
    Lesson(LessonIntent),
    ToolUse(ToolUseIntent),
    StreamTextDelta(StreamTextDeltaIntent),
    InterventionReview(InterventionReviewIntent),
    PublishArticle(PublishArticleIntent),
}

impl Intent {
    pub fn variant_name(&self) -> &'static str {
        match self {
            Intent::Completion(_) => "completion",
            Intent::Conversation(_) => "conversation",
            Intent::Delegation(_) => "delegation",
            Intent::Ask(_) => "ask",
            Intent::Error(_) => "error",
            Intent::Lesson(_) => "lesson",
            Intent::ToolUse(_) => "tool_use",
            Intent::StreamTextDelta(_) => "stream_text_delta",
            Intent::InterventionReview(_) => "intervention_review",
            Intent::PublishArticle(_) => "publish_article",
        }
    }
}
