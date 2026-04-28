use crate::types::{Detection, PostCompletionContext, PreToolContext};

pub trait PostCompletionHeuristic: Send + Sync {
    fn name(&self) -> &'static str;
    fn check(&self, ctx: &PostCompletionContext) -> Option<Detection>;
}

pub trait PreToolHeuristic: Send + Sync {
    fn name(&self) -> &'static str;
    fn check<'a>(&self, ctx: &PreToolContext<'a>) -> Option<String>;
}
