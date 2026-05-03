//! `run_agent!` macro: builds a rig agent with our shared configuration
//! (preamble, max tokens, turn fuse, tools, hook) and drives the streaming
//! chat to completion, returning the `FinalResponse`.
//!
//! The macro uses fully-qualified paths for all external types so it can be
//! invoked from any sibling module in this crate without additional `use`
//! statements at the call site. The only crate-local symbol it references
//! is [`crate::agent_loop_hook::AgentLoopHook`] and
//! [`crate::progress_monitor::RIG_AGENT_TURN_FUSE`].
//
// run_agent!(client, model, system, message, history, hook, tools)
// run_agent!(client, model, system, message, history, hook, tools, |m| m.with_prompt_caching())
//
// The optional seventh argument is a closure applied to the completion model before building the
// agent. Use it to configure provider-specific options (e.g. Anthropic prompt caching). The
// default is the identity closure, which leaves the model unchanged.

macro_rules! run_agent {
    ($client:expr, $model:expr, $system:expr, $message:expr, $history:expr, $hook:expr, $tools:expr) => {
        run_agent!(
            $client,
            $model,
            $system,
            $message,
            $history,
            $hook,
            $tools,
            |m| m
        )
    };
    ($client:expr, $model:expr, $system:expr, $message:expr, $history:expr, $hook:expr, $tools:expr, $model_config:expr) => {{
        use ::futures::StreamExt as _;
        use ::rig::agent::AgentBuilder;
        use ::rig::client::CompletionClient as _;
        use ::rig::streaming::StreamingChat as _;

        let __model = ($model_config)($client.completion_model($model.to_string()));
        let __hook = $crate::agent_loop_hook::AgentLoopHook::new($hook, __model.clone());
        let mut __stream = AgentBuilder::new(__model)
            .preamble($system)
            .max_tokens(16384)
            .default_max_turns($crate::progress_monitor::RIG_AGENT_TURN_FUSE)
            .tools($tools)
            .build()
            .stream_chat($message, $history)
            .with_hook(__hook)
            .await;

        let mut __final = ::rig::agent::FinalResponse::empty();
        while let Some(__item) = __stream.next().await {
            match __item {
                Ok(::rig::agent::MultiTurnStreamItem::FinalResponse(__r)) => {
                    __final = __r;
                    break;
                }
                Ok(_) => {}
                Err(__e) => return Err(::anyhow::anyhow!("stream error: {__e}")),
            }
        }
        __final
    }};
}
