//! Shared emission state: the channel, the conversation thread, and the
//! `AgentMeta` accumulator (RAL counter + LLM runtime tracker). Both the
//! prompt hook and the delegate tool consume this through `Arc<EmitState>`.
//!
//! ## Runtime delta contract
//!
//! `EncodingContext.llm_runtime_ms` carries the *incremental* runtime since
//! the previous publish, so downstream summing must see each delta exactly
//! once. The builders here ([`EmitState::build_ctx`] et al.) are **pure**
//! — they do not consume runtime — and leave `llm_runtime_ms` unset.
//! Callers explicitly attach the delta with [`EmitState::take_runtime_delta`]:
//!
//! ```ignore
//! let mut ctx = state.build_ctx(ral);
//! ctx.llm_runtime_ms = state.take_runtime_delta();
//! channel.send(intent, &ctx).await?;
//! ```
//!
//! For multi-event sends in a single tool call, attach the delta to
//! exactly one event (typically the first / "real" event in the batch);
//! subsequent events leave `llm_runtime_ms` unset. See `tools/delegate.rs`
//! for the canonical pattern.
//!
//! [`EmitState::build_completion_ctx`] is the one terminal exception: it
//! both consumes the residual delta and reads the running total in a
//! single locked critical section, since it represents the final event
//! of the agent invocation.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
use tenex_protocol::{
    Channel, ConversationRef, EncodingContext, MessageRef, PrincipalRef, ProjectRef,
};

pub use crate::runtime_tracker::AgentMeta;

/// Cloneable handle holding the immutable thread context plus the shared
/// counter. Cheap to share across hook + tools.
#[derive(Clone)]
pub struct EmitState {
    pub channel: Arc<dyn Channel>,
    pub project: ProjectRef,
    pub triggering_principal: PrincipalRef,
    pub triggering_message: Option<MessageRef>,
    pub conversation_root: Option<ConversationRef>,
    pub completion_recipient: Option<PrincipalRef>,
    pub model: String,
    /// Team scope from the inbound event's `["team", ...]` tag.
    pub team: Option<String>,
    /// Git branch this agent is running on. Forwarded to all outbound events
    /// via `EncodingContext.branch` → `forward_branch_team`.
    pub current_branch: Option<String>,
    pub completion_project_a_tags: Vec<String>,
    pub meta: Arc<Mutex<AgentMeta>>,
    pending_external_work: Arc<AtomicBool>,
}

pub struct EmitStateArgs {
    pub channel: Arc<dyn Channel>,
    pub project: ProjectRef,
    pub triggering_principal: PrincipalRef,
    pub triggering_message: Option<MessageRef>,
    pub conversation_root: Option<ConversationRef>,
    pub completion_recipient: Option<PrincipalRef>,
    pub model: String,
    pub team: Option<String>,
    /// Git branch this agent is running on. Forwarded to all outbound events.
    pub current_branch: Option<String>,
    pub completion_project_a_tags: Vec<String>,
}

impl EmitState {
    pub fn new(args: EmitStateArgs) -> Self {
        Self {
            channel: args.channel,
            project: args.project,
            triggering_principal: args.triggering_principal,
            triggering_message: args.triggering_message,
            conversation_root: args.conversation_root,
            completion_recipient: args.completion_recipient,
            model: args.model,
            team: args.team,
            current_branch: args.current_branch,
            completion_project_a_tags: args.completion_project_a_tags,
            meta: Arc::new(Mutex::new(AgentMeta::new())),
            pending_external_work: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn mark_pending_external_work(&self) {
        self.pending_external_work.store(true, Ordering::Release);
    }

    #[allow(
        dead_code,
        reason = "used by the stdio binary; the ACP binary compiles shared delegation tool types without this call site"
    )]
    pub fn has_pending_external_work(&self) -> bool {
        self.pending_external_work.load(Ordering::Acquire)
    }

    /// Mark the start of an LLM streaming session. Called from the prompt
    /// hook's `on_completion_call`.
    #[allow(
        dead_code,
        reason = "used by the stdio binary's PromptHook; the ACP binary tracks LLM time independently via session/prompt elapsed"
    )]
    pub fn start_llm_stream(&self) {
        self.meta.lock().unwrap().start_stream(Instant::now());
    }

    /// Mark the end of an LLM streaming session, folding the final tail
    /// into the accumulator. Idempotent: a no-op if no stream is active,
    /// so callers may stop the timer at handoff (e.g. tool-call) and
    /// again at the rig stream-finish hook without double-counting.
    #[allow(
        dead_code,
        reason = "used by the stdio binary's PromptHook; the ACP binary tracks LLM time independently"
    )]
    pub fn end_llm_stream(&self) {
        self.meta.lock().unwrap().end_stream(Instant::now());
    }

    /// Consume and return the unreported runtime delta in milliseconds.
    /// Returns `None` for a zero delta so the caller can leave
    /// `EncodingContext.llm_runtime_ms` unset (the encoder filters out
    /// zero-valued runtime tags).
    ///
    /// This is the **only** way to consume the delta — the `build_ctx*`
    /// builders are pure. Call exactly once per outbound event that
    /// should carry the delta.
    #[allow(
        dead_code,
        reason = "compiled into the ACP binary too, but only single-binary callsites use it directly"
    )]
    pub fn take_runtime_delta(&self) -> Option<u64> {
        self.meta.lock().unwrap().consume_unreported(Instant::now())
    }

    /// Build a pure encoding context for an outbound event. Leaves
    /// `llm_runtime_ms` unset; callers must explicitly assign
    /// [`Self::take_runtime_delta`] to the field on whichever event
    /// should carry the delta.
    pub fn build_ctx(&self, ral: u32) -> EncodingContext {
        self.build_ctx_with_team(ral, self.team.clone())
    }

    /// Build a pure encoding context, overriding the team tag. Used by
    /// the delegate tool when delegating by team name — the outbound
    /// event must carry the resolved team name, not the inbound one.
    pub fn build_ctx_with_team(&self, ral: u32, team: Option<String>) -> EncodingContext {
        EncodingContext {
            project: self.project.clone(),
            conversation_root: self.conversation_root.clone(),
            triggering_message: self.triggering_message.clone(),
            completion_recipient: self.completion_recipient.clone(),
            triggering_principal: self.triggering_principal.clone(),
            ral,
            model: Some(self.model.clone()),
            cost_usd: None,
            execution_time_ms: None,
            llm_runtime_ms: None,
            llm_runtime_total_ms: None,
            completion_project_a_tags: self.completion_project_a_tags.clone(),
            branch: self.current_branch.clone(),
            team,
        }
    }

    /// Build a pure encoding context, overriding the project a-tag. Used
    /// by the cross-project delegate tool — the outbound delegation must
    /// carry the target project's coordinate, not the source project's.
    pub fn build_ctx_with_project(&self, ral: u32, project: ProjectRef) -> EncodingContext {
        let mut ctx = self.build_ctx(ral);
        ctx.project = project;
        ctx
    }

    /// Build an encoding context for a terminal completion event.
    /// **Consumes** the residual `llm_runtime_ms` delta and additionally
    /// stamps the accumulated `llm_runtime_total_ms` for the whole RAL so
    /// downstream delegation aggregation can see the full cost.
    ///
    /// Unlike [`Self::build_ctx`], this method has a consuming
    /// side-effect by design — it represents the single terminal event
    /// of the agent invocation and atomically reads both the delta and
    /// the total in one locked critical section to avoid the
    /// take-delta-then-build-ctx race that would otherwise lose runtime
    /// accumulated between the two operations.
    #[allow(
        dead_code,
        reason = "used by the stdio binary's turn loop; the ACP binary builds its terminal completion ctx inline with session/prompt totals"
    )]
    pub fn build_completion_ctx(&self, ral: u32) -> EncodingContext {
        let now = Instant::now();
        let mut meta = self.meta.lock().unwrap();
        let llm_runtime_ms = meta.consume_unreported(now);
        let total = meta.accumulated_with_live(now);
        drop(meta);
        EncodingContext {
            project: self.project.clone(),
            conversation_root: self.conversation_root.clone(),
            triggering_message: self.triggering_message.clone(),
            completion_recipient: self.completion_recipient.clone(),
            triggering_principal: self.triggering_principal.clone(),
            ral,
            model: Some(self.model.clone()),
            cost_usd: None,
            execution_time_ms: None,
            llm_runtime_ms,
            llm_runtime_total_ms: if total > 0 { Some(total) } else { None },
            completion_project_a_tags: self.completion_project_a_tags.clone(),
            branch: self.current_branch.clone(),
            team: self.team.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    use async_trait::async_trait;
    use nostr::Keys;
    use tenex_protocol::{Channel, ChannelError, Intent, MessageRef, PrincipalRef, ProjectRef};

    struct NoopChannel(PrincipalRef);

    #[async_trait]
    impl Channel for NoopChannel {
        fn name(&self) -> &'static str {
            "noop"
        }
        fn identity(&self) -> &PrincipalRef {
            &self.0
        }
        async fn send(
            &self,
            _intent: Intent,
            _ctx: &EncodingContext,
        ) -> Result<Vec<MessageRef>, ChannelError> {
            Ok(vec![])
        }
    }

    fn test_state() -> Arc<EmitState> {
        let keys = Keys::generate();
        let pubkey = keys.public_key();
        let identity = PrincipalRef::nostr_agent(pubkey);
        let channel: Arc<dyn Channel> = Arc::new(NoopChannel(identity.clone()));
        Arc::new(EmitState::new(EmitStateArgs {
            channel,
            project: ProjectRef {
                author: pubkey,
                d_tag: "test".to_string(),
            },
            triggering_principal: identity,
            triggering_message: None,
            conversation_root: None,
            completion_recipient: None,
            model: "test:test".to_string(),
            team: None,
            current_branch: None,
            completion_project_a_tags: vec![],
        }))
    }

    /// `build_ctx` is pure — it never touches the runtime accumulator.
    /// Explicit deadlock-style guard: invoking it while holding the meta
    /// mutex must not deadlock.
    #[test]
    fn build_ctx_is_pure_and_does_not_deadlock() {
        let state = test_state();
        // Pure build → no runtime fields, regardless of stream state.
        let ctx = state.build_ctx(0);
        assert!(ctx.llm_runtime_ms.is_none());
        assert!(ctx.llm_runtime_total_ms.is_none());

        state.start_llm_stream();
        let ctx_during = state.build_ctx(1);
        assert!(
            ctx_during.llm_runtime_ms.is_none(),
            "build_ctx must not consume runtime"
        );
    }

    /// `take_runtime_delta` consumes once, returns subsequent zeros as
    /// `None`. Uses the deterministic `AgentMeta` tests for the timing
    /// math — this case only verifies the consume-once contract.
    #[test]
    fn take_runtime_delta_consumes_exactly_once() {
        let state = test_state();
        // Nothing to report before any stream.
        assert_eq!(state.take_runtime_delta(), None);

        state.start_llm_stream();
        thread::sleep(Duration::from_millis(20));

        let first = state.take_runtime_delta();
        let first_ms = first.expect("first take should yield Some delta");
        assert!(first_ms >= 15, "first delta = {first_ms}");

        // Immediate re-take returns no fresh delta — either None or a
        // value strictly smaller than the first take. This is a
        // structural ordering assertion; deterministic timing math is
        // covered by `runtime_tracker::tests`.
        let second = state.take_runtime_delta();
        match second {
            None => {}
            Some(second_ms) => assert!(
                second_ms < first_ms,
                "second take ({second_ms}ms) must not exceed first ({first_ms}ms)"
            ),
        }
    }

    /// End-to-end: `build_completion_ctx` carries both the residual
    /// delta and the accumulated total. Structural assertion only —
    /// presence of the total, not its exact value.
    #[test]
    fn completion_ctx_carries_total() {
        let state = test_state();
        state.start_llm_stream();
        thread::sleep(Duration::from_millis(10));
        state.end_llm_stream();

        let complete = state.build_completion_ctx(2);
        assert!(
            complete.llm_runtime_total_ms.is_some(),
            "completion ctx must stamp the running total"
        );
    }
}
