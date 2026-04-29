use crate::hook::EmitHook;
use crate::progress_monitor::ProgressMonitor;
use rig::agent::{HookAction, PromptHook, ToolCallHookAction};
use rig::completion::{CompletionModel, CompletionResponse, Message};

#[derive(Clone)]
pub struct AgentLoopHook<M> {
    emit: EmitHook,
    progress: ProgressMonitor<M>,
}

impl<M> AgentLoopHook<M> {
    pub fn new(emit: EmitHook, review_model: M) -> Self {
        Self {
            emit,
            progress: ProgressMonitor::new(review_model),
        }
    }
}

impl<M> PromptHook<M> for AgentLoopHook<M>
where
    M: CompletionModel,
{
    fn on_completion_call(
        &self,
        prompt: &Message,
        history: &[Message],
    ) -> impl std::future::Future<Output = HookAction> + Send {
        let emit = self.emit.clone();
        let progress = self.progress.clone();
        let prompt = prompt.clone();
        let history = history.to_vec();

        async move {
            let action =
                <EmitHook as PromptHook<M>>::on_completion_call(&emit, &prompt, &history).await;
            if !matches!(action, HookAction::Continue) {
                return action;
            }
            progress.on_completion_call(&prompt, &history).await
        }
    }

    fn on_completion_response(
        &self,
        prompt: &Message,
        response: &CompletionResponse<M::Response>,
    ) -> impl std::future::Future<Output = HookAction> + Send {
        <EmitHook as PromptHook<M>>::on_completion_response(&self.emit, prompt, response)
    }

    fn on_tool_call(
        &self,
        tool_name: &str,
        tool_call_id: Option<String>,
        internal_call_id: &str,
        args: &str,
    ) -> impl std::future::Future<Output = ToolCallHookAction> + Send {
        <EmitHook as PromptHook<M>>::on_tool_call(
            &self.emit,
            tool_name,
            tool_call_id,
            internal_call_id,
            args,
        )
    }

    fn on_tool_result(
        &self,
        tool_name: &str,
        tool_call_id: Option<String>,
        internal_call_id: &str,
        args: &str,
        result: &str,
    ) -> impl std::future::Future<Output = HookAction> + Send {
        let emit = self.emit.clone();
        let progress = self.progress.clone();
        let tool_name = tool_name.to_string();
        let internal_call_id = internal_call_id.to_string();
        let args = args.to_string();
        let result = result.to_string();

        async move {
            let action = progress
                .on_tool_result(
                    &tool_name,
                    tool_call_id.clone(),
                    &internal_call_id,
                    &args,
                    &result,
                )
                .await;
            if !matches!(action, HookAction::Continue) {
                return action;
            }
            <EmitHook as PromptHook<M>>::on_tool_result(
                &emit,
                &tool_name,
                tool_call_id,
                &internal_call_id,
                &args,
                &result,
            )
            .await
        }
    }

    fn on_text_delta(
        &self,
        text_delta: &str,
        aggregated_text: &str,
    ) -> impl std::future::Future<Output = HookAction> + Send {
        <EmitHook as PromptHook<M>>::on_text_delta(&self.emit, text_delta, aggregated_text)
    }

    fn on_tool_call_delta(
        &self,
        tool_call_id: &str,
        internal_call_id: &str,
        tool_name: Option<&str>,
        tool_call_delta: &str,
    ) -> impl std::future::Future<Output = HookAction> + Send {
        <EmitHook as PromptHook<M>>::on_tool_call_delta(
            &self.emit,
            tool_call_id,
            internal_call_id,
            tool_name,
            tool_call_delta,
        )
    }

    fn on_stream_completion_response_finish(
        &self,
        prompt: &Message,
        response: &M::StreamingResponse,
    ) -> impl std::future::Future<Output = HookAction> + Send {
        <EmitHook as PromptHook<M>>::on_stream_completion_response_finish(
            &self.emit, prompt, response,
        )
    }
}
