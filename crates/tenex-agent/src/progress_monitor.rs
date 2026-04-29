use std::sync::{Arc, Mutex};

use rig::agent::{HookAction, PromptHook};
use rig::completion::{AssistantContent, CompletionModel, CompletionResponse, Message};

pub const RIG_AGENT_TURN_FUSE: usize = 1_000_000;

const DEFAULT_REVIEW_THRESHOLD: usize = 50;

#[derive(Debug, Default)]
struct ProgressState {
    tool_result_step_pending: bool,
    steps_since_review: usize,
    tool_names: Vec<String>,
}

impl ProgressState {
    fn record_tool_result(&mut self, tool_name: &str) {
        self.tool_result_step_pending = true;
        self.tool_names.push(tool_name.to_string());
    }

    fn prepare_review(&mut self, threshold: usize) -> Option<Vec<String>> {
        if !self.tool_result_step_pending {
            return None;
        }

        self.tool_result_step_pending = false;
        self.steps_since_review += 1;
        if self.steps_since_review < threshold {
            return None;
        }

        self.steps_since_review = 0;
        Some(self.tool_names.clone())
    }
}

#[derive(Clone)]
pub struct ProgressMonitor<M> {
    model: M,
    threshold: usize,
    state: Arc<Mutex<ProgressState>>,
}

impl<M> ProgressMonitor<M> {
    pub fn new(model: M) -> Self {
        Self {
            model,
            threshold: DEFAULT_REVIEW_THRESHOLD,
            state: Arc::new(Mutex::new(ProgressState::default())),
        }
    }

    #[cfg(test)]
    fn with_threshold(model: M, threshold: usize) -> Self {
        Self {
            model,
            threshold,
            state: Arc::new(Mutex::new(ProgressState::default())),
        }
    }
}

impl<M> ProgressMonitor<M>
where
    M: CompletionModel,
{
    async fn review_progress(&self, tool_names: Vec<String>) -> bool {
        let tool_summary = tool_names
            .iter()
            .enumerate()
            .map(|(idx, name)| format!("{}. {}", idx + 1, name))
            .collect::<Vec<_>>()
            .join("\n");
        let prompt = format!(
            "Review these {} tool calls. Is the agent making progress or stuck?\n\n{}\n\nRespond with only \"continue\" or \"stop\":",
            tool_names.len(),
            tool_summary
        );

        match self
            .model
            .completion_request(prompt)
            .max_tokens(10)
            .temperature(0.0)
            .send()
            .await
        {
            Ok(response) => {
                let should_continue = completion_text(response)
                    .trim()
                    .to_lowercase()
                    .contains("continue");
                tracing::info!(
                    should_continue,
                    tool_call_count = tool_names.len(),
                    "Progress monitor review completed"
                );
                should_continue
            }
            Err(error) => {
                tracing::error!(
                    error = %error,
                    tool_call_count = tool_names.len(),
                    "Progress monitor review failed; stopping agent loop"
                );
                false
            }
        }
    }
}

impl<M> PromptHook<M> for ProgressMonitor<M>
where
    M: CompletionModel,
{
    fn on_completion_call(
        &self,
        _prompt: &Message,
        _history: &[Message],
    ) -> impl std::future::Future<Output = HookAction> + Send {
        let review_tool_names = {
            let mut state = self.state.lock().unwrap();
            state.prepare_review(self.threshold)
        };
        let monitor = self.clone();

        async move {
            let Some(tool_names) = review_tool_names else {
                return HookAction::cont();
            };

            if monitor.review_progress(tool_names).await {
                HookAction::cont()
            } else {
                HookAction::terminate(
                    "progress monitor stopped the agent because recent tool use appears stuck",
                )
            }
        }
    }

    fn on_tool_result(
        &self,
        tool_name: &str,
        _tool_call_id: Option<String>,
        _internal_call_id: &str,
        _args: &str,
        _result: &str,
    ) -> impl std::future::Future<Output = HookAction> + Send {
        {
            let mut state = self.state.lock().unwrap();
            state.record_tool_result(tool_name);
        }

        async { HookAction::cont() }
    }
}

fn completion_text<T>(response: CompletionResponse<T>) -> String {
    let mut text = String::new();
    for item in response.choice {
        if let AssistantContent::Text(part) = item {
            text.push_str(&part.text);
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use rig::completion::{CompletionError, CompletionRequest, Usage};
    use rig::message::Text;
    use rig::streaming::StreamingCompletionResponse;
    use rig::OneOrMany;

    #[derive(Clone)]
    struct TestModel {
        response: String,
        requests: Arc<Mutex<Vec<String>>>,
    }

    impl TestModel {
        fn new(response: &str) -> Self {
            Self {
                response: response.to_string(),
                requests: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    #[allow(refining_impl_trait)]
    impl CompletionModel for TestModel {
        type Response = ();
        type StreamingResponse = ();
        type Client = ();

        fn make(_client: &Self::Client, model: impl Into<String>) -> Self {
            Self::new(&model.into())
        }

        async fn completion(
            &self,
            request: CompletionRequest,
        ) -> Result<CompletionResponse<Self::Response>, CompletionError> {
            self.requests.lock().unwrap().push(format!("{request:?}"));
            Ok(CompletionResponse {
                choice: OneOrMany::one(AssistantContent::Text(Text {
                    text: self.response.clone(),
                })),
                usage: Usage::default(),
                raw_response: (),
                message_id: None,
            })
        }

        async fn stream(
            &self,
            _request: CompletionRequest,
        ) -> Result<StreamingCompletionResponse<Self::StreamingResponse>, CompletionError> {
            unreachable!("progress monitor tests do not stream")
        }
    }

    #[test]
    fn state_counts_one_step_per_completion_after_tool_results() {
        let mut state = ProgressState::default();

        assert!(state.prepare_review(2).is_none());

        state.record_tool_result("fs_read");
        state.record_tool_result("fs_write");
        assert!(state.prepare_review(2).is_none());
        assert_eq!(state.steps_since_review, 1);

        assert!(state.prepare_review(2).is_none());
        assert_eq!(state.steps_since_review, 1);

        state.record_tool_result("shell");
        let review = state.prepare_review(2).expect("threshold reached");
        assert_eq!(review, vec!["fs_read", "fs_write", "shell"]);
        assert_eq!(state.steps_since_review, 0);
    }

    #[tokio::test]
    async fn monitor_continues_when_reviewer_says_continue() {
        let monitor = ProgressMonitor::with_threshold(TestModel::new("continue"), 1);
        monitor
            .on_tool_result("fs_read", None, "internal", "{}", "ok")
            .await;

        let action = monitor
            .on_completion_call(&Message::user("next"), &[])
            .await;

        assert_eq!(action, HookAction::Continue);
    }

    #[tokio::test]
    async fn monitor_terminates_when_reviewer_says_stop() {
        let monitor = ProgressMonitor::with_threshold(TestModel::new("stop"), 1);
        monitor
            .on_tool_result("fs_read", None, "internal", "{}", "ok")
            .await;

        let action = monitor
            .on_completion_call(&Message::user("next"), &[])
            .await;

        assert!(matches!(action, HookAction::Terminate { .. }));
    }
}
