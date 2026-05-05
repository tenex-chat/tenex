use crate::heuristic::PostCompletionHeuristic;
use crate::types::{Detection, EnforcementMode, PostCompletionContext, TodoStatus};

pub struct PendingTodosHeuristic;

/// Returns `true` iff `text` contains `phrase` bounded on both sides by
/// non-alphanumeric characters (or by string boundaries). This is a tiny
/// word-boundary matcher: it prevents `"and do"` from matching inside
/// `"and don't"` and `"fix"` from matching inside `"fixed"` or `"prefix"`,
/// without pulling a regex dependency into this no-deps crate.
///
/// Both `text` and `phrase` are expected to already be lowercased ASCII.
/// Multi-byte UTF-8 boundary bytes are not ASCII-alphanumeric, so they
/// behave as word separators — acceptable for the English-language
/// keyword phrases this heuristic uses.
fn contains_word_phrase(text: &str, phrase: &str) -> bool {
    if phrase.is_empty() {
        return false;
    }
    let bytes = text.as_bytes();
    let mut search_start = 0;
    while let Some(idx) = text[search_start..].find(phrase) {
        let abs = search_start + idx;
        let before_ok = abs == 0 || !bytes[abs - 1].is_ascii_alphanumeric();
        let end = abs + phrase.len();
        let after_ok = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        search_start = abs + 1;
    }
    false
}

fn is_explicit_todo_list_only_request(message: &str) -> bool {
    let lower = message.to_lowercase();
    let mentions_todos = ["todo", "to-do", "task list"]
        .iter()
        .any(|phrase| contains_word_phrase(&lower, phrase));
    if !mentions_todos {
        return false;
    }

    let asks_to_set_up = [
        "set up",
        "setup",
        "create",
        "make",
        "initialize",
        "init",
        "write",
        "draft",
        "prepare",
    ]
    .iter()
    .any(|phrase| contains_word_phrase(&lower, phrase));
    if !asks_to_set_up {
        return false;
    }

    let asks_to_stop_after = [
        "and stop",
        "then stop",
        "stop after",
        "nothing else",
        "only",
        "just",
        "do not continue",
        "don't continue",
        "do not do",
        "don't do",
    ]
    .iter()
    .any(|phrase| contains_word_phrase(&lower, phrase));

    let asks_to_execute_items = [
        "then do",
        "and do",
        "then complete",
        "and complete",
        "work through",
        "execute",
        "implement",
        "build",
        "fix",
    ]
    .iter()
    .any(|phrase| contains_word_phrase(&lower, phrase));

    asks_to_stop_after && !asks_to_execute_items
}

impl PostCompletionHeuristic for PendingTodosHeuristic {
    fn name(&self) -> &'static str {
        "pending-todos"
    }

    fn check(&self, ctx: &PostCompletionContext<'_>) -> Option<Detection> {
        if ctx.todos.is_empty() {
            return None;
        }
        if ctx.pending_delegation_count > 0 {
            return None;
        }
        if is_explicit_todo_list_only_request(ctx.triggering_message) {
            return None;
        }
        let active: Vec<&str> = ctx
            .todos
            .iter()
            .filter(|t| t.status == TodoStatus::Pending || t.status == TodoStatus::InProgress)
            .map(|t| t.id.as_str())
            .collect();
        if active.is_empty() {
            return None;
        }

        let message = format!(
            "Your original task was: {}\n\n\
             You have unfinished todo items: {}. \
             Please continue working on them. \
             Mark each item in_progress when you start it and done when complete.",
            ctx.triggering_message,
            active.join(", ")
        );

        Some(Detection {
            heuristic_name: self.name(),
            message,
            enforcement: EnforcementMode::RepeatUntilResolved,
            re_engage: true,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{TodoEntry, TodoStatus};

    fn ctx(todos: &[TodoEntry], delegations: usize) -> PostCompletionContext<'_> {
        PostCompletionContext {
            todos,
            tool_calls_made: &[],
            nudged_about_todos: false,
            pending_delegation_count: delegations,
            triggering_message: "do the thing",
        }
    }

    #[test]
    fn fires_when_pending_todos_remain() {
        let h = PendingTodosHeuristic;
        let todos = vec![
            TodoEntry {
                id: "t1".to_string(),
                status: TodoStatus::Pending,
            },
            TodoEntry {
                id: "t2".to_string(),
                status: TodoStatus::Done,
            },
        ];
        let detection = h.check(&ctx(&todos, 0));
        assert!(detection.is_some());
        let d = detection.unwrap();
        assert!(d.re_engage);
        assert!(d.message.contains("t1"));
        assert!(!d.message.contains("t2"), "done todos should not appear");
    }

    #[test]
    fn suppressed_when_delegation_pending() {
        let h = PendingTodosHeuristic;
        let todos = vec![TodoEntry {
            id: "t1".to_string(),
            status: TodoStatus::Pending,
        }];
        assert!(h.check(&ctx(&todos, 1)).is_none());
    }

    #[test]
    fn suppressed_when_all_done() {
        let h = PendingTodosHeuristic;
        let todos = vec![
            TodoEntry {
                id: "t1".to_string(),
                status: TodoStatus::Done,
            },
            TodoEntry {
                id: "t2".to_string(),
                status: TodoStatus::Skipped,
            },
        ];
        assert!(h.check(&ctx(&todos, 0)).is_none());
    }

    #[test]
    fn suppressed_when_no_todos() {
        let h = PendingTodosHeuristic;
        assert!(h.check(&ctx(&[], 0)).is_none());
    }

    #[test]
    fn suppressed_when_user_requested_todo_setup_and_stop() {
        let h = PendingTodosHeuristic;
        let todos = vec![TodoEntry {
            id: "t1".to_string(),
            status: TodoStatus::Pending,
        }];
        let mut ctx = ctx(&todos, 0);
        ctx.triggering_message = "setup a todo list with 3 items and stop";
        assert!(h.check(&ctx).is_none());
    }

    #[test]
    fn still_fires_when_user_requests_todo_setup_and_execution() {
        let h = PendingTodosHeuristic;
        let todos = vec![TodoEntry {
            id: "t1".to_string(),
            status: TodoStatus::Pending,
        }];
        let mut ctx = ctx(&todos, 0);
        ctx.triggering_message = "setup a todo list and then complete the tasks";
        assert!(h.check(&ctx).is_some());
    }

    #[test]
    fn suppressed_when_user_explicitly_says_dont_do_them() {
        // Regression: "and do" used to substring-match "and don't do", so a
        // request that explicitly forbids execution was misclassified as
        // asking for execution and the heuristic kept firing.
        let h = PendingTodosHeuristic;
        let todos = vec![TodoEntry {
            id: "t1".to_string(),
            status: TodoStatus::Pending,
        }];
        let mut ctx = ctx(&todos, 0);
        ctx.triggering_message = "create a todo list and don't do anything else";
        assert!(
            h.check(&ctx).is_none(),
            "explicit 'don't do' must suppress, not fire"
        );
    }

    #[test]
    fn suppressed_when_setup_words_appear_inside_other_words() {
        // Regression: substring matching let "fix" match inside words like
        // "fixed" or "prefix", and let "execute" match inside "executed",
        // muddying the suppression decision. Word-boundary matching pins the
        // execute-vocabulary to actual standalone tokens.
        let h = PendingTodosHeuristic;
        let todos = vec![TodoEntry {
            id: "t1".to_string(),
            status: TodoStatus::Pending,
        }];
        let mut ctx = ctx(&todos, 0);
        // No real execute verbs here — just words that *contain* execute
        // tokens as substrings. Should suppress.
        ctx.triggering_message = "create a todo list of prefixed items, just stop";
        assert!(
            h.check(&ctx).is_none(),
            "substrings inside larger words must not count as execute verbs"
        );
    }
}
