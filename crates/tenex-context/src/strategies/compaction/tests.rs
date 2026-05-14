use super::*;
use crate::types::{ModelProfile, ProjectionTelemetry};

fn profile(max_tokens: usize) -> ModelProfile {
    ModelProfile {
        provider: "test".into(),
        model_id: "test-model".into(),
        prompt_cache: false,
        ephemeral_reminders: false,
        image_support: false,
        max_context_tokens: max_tokens,
    }
}

fn ctx_with_messages<'a>(
    system: &str,
    user_msgs: &[&str],
    p: &'a ModelProfile,
) -> ProjectionContext<'a> {
    let mut messages = vec![Message::System {
        content: system.to_string(),
    }];
    for u in user_msgs {
        messages.push(Message::User {
            content: u.to_string(),
        });
    }
    ProjectionContext {
        messages,
        telemetry: ProjectionTelemetry::default(),
        model_profile: p,
        tool_defs: &[],
        agent_todos: None,
    }
}

#[tokio::test]
async fn no_compaction_below_threshold() {
    let p = profile(1000);
    let mut ctx = ctx_with_messages("sys.", &["msg1", "msg2", "msg3"], &p);
    CompactionToolStrategy::default()
        .apply(&mut ctx)
        .await
        .unwrap();
    assert_eq!(ctx.telemetry.compacted_count, 0);
    assert_eq!(ctx.messages.len(), 4);
}

#[tokio::test]
async fn no_compaction_when_zero_max_tokens() {
    let p = profile(0);
    let mut ctx = ctx_with_messages("sys", &["a", "b", "c"], &p);
    CompactionToolStrategy::default()
        .apply(&mut ctx)
        .await
        .unwrap();
    assert_eq!(ctx.telemetry.compacted_count, 0);
}

#[tokio::test]
async fn compaction_collapses_middle_and_preserves_head_and_tail() {
    let p = profile(100);
    let user_msgs: Vec<&str> = (0..9)
        .map(|_| "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        .collect();
    let sys_content = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let mut ctx = ctx_with_messages(sys_content, &user_msgs, &p);

    CompactionToolStrategy::default()
        .apply(&mut ctx)
        .await
        .unwrap();

    assert!(ctx.telemetry.compacted_count >= 1);
    assert!(matches!(&ctx.messages[0], Message::System { content } if content == sys_content));
    let has_summary = ctx.messages.iter().any(
        |m| matches!(m, Message::User { content } if content.starts_with("[Compacted context:")),
    );
    assert!(has_summary);
    assert!(
        ctx.telemetry
            .strategies_applied
            .contains(&"compaction".to_string())
    );
}

#[tokio::test]
async fn compaction_respects_keep_tail() {
    let p = profile(100);
    let msgs: Vec<&str> = (0..14)
        .map(|_| "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        .collect();
    let tag = "SENTINEL_TAIL_MESSAGE_AAAAAAAAAAAAAAAAAAA";
    let mut ctx = ctx_with_messages("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", &msgs, &p);
    let last = ctx.messages.len() - 1;
    ctx.messages[last] = Message::User {
        content: tag.to_string(),
    };

    CompactionToolStrategy::default()
        .apply(&mut ctx)
        .await
        .unwrap();

    let tail_survived = ctx
        .messages
        .iter()
        .any(|m| matches!(m, Message::User { content } if content == tag));
    assert!(tail_survived);
}

#[tokio::test]
async fn threshold_override_triggers_earlier_compaction() {
    let p = profile(100);
    let user_msgs: Vec<&str> = (0..7)
        .map(|_| "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        .collect();
    let sys_content = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let mut default_ctx = ctx_with_messages(sys_content, &user_msgs, &p);

    CompactionToolStrategy::default()
        .apply(&mut default_ctx)
        .await
        .unwrap();
    assert_eq!(default_ctx.telemetry.compacted_count, 0);

    let mut retry_ctx = ctx_with_messages(sys_content, &user_msgs, &p);
    CompactionToolStrategy::with_threshold_ratio(None, 0.5)
        .apply(&mut retry_ctx)
        .await
        .unwrap();
    assert_eq!(retry_ctx.telemetry.compacted_count, 1);
}

#[tokio::test]
async fn no_compaction_when_too_few_messages() {
    let p = profile(10);
    let mut ctx = ctx_with_messages("s", &["a", "b", "c"], &p);
    CompactionToolStrategy::default()
        .apply(&mut ctx)
        .await
        .unwrap();
    assert_eq!(ctx.telemetry.compacted_count, 0);
}
