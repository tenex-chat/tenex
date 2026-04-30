/// A scheduled task entry for rendering in the system prompt (Fragment 22).
pub struct ScheduledTaskForPrompt {
    pub id: String,
    pub cron_expr: String,
    pub description: String,
    /// Unix timestamp (milliseconds) for the next scheduled run, if known.
    pub next_run_ms: Option<i64>,
    /// Whether this is a one-off task (true) or recurring (false).
    pub is_oneoff: bool,
}

/// Convert a cron expression to a human-readable description.
///
/// Handles `@hourly`, `@daily`, `@weekly`, `@monthly` presets and the most
/// common 5-field patterns. Falls back to the raw expression for anything
/// unrecognised.
pub fn humanize_cron(expr: &str) -> String {
    match expr {
        "@hourly" => return "Every hour".to_string(),
        "@daily" | "@midnight" => return "Every day at 00:00 UTC".to_string(),
        "@weekly" => return "Every Sunday at 00:00 UTC".to_string(),
        "@monthly" => return "On the 1st of every month at 00:00 UTC".to_string(),
        "@yearly" | "@annually" => return "On January 1st at 00:00 UTC".to_string(),
        _ => {}
    }

    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return expr.to_string();
    }
    let (minute, hour, dom, month, dow) = (parts[0], parts[1], parts[2], parts[3], parts[4]);

    if minute == "*" && hour == "*" && dom == "*" && month == "*" && dow == "*" {
        return "Every minute".to_string();
    }

    if let Some(n) = minute.strip_prefix("*/") {
        if hour == "*" && dom == "*" && month == "*" && dow == "*" {
            return format!("Every {n} minutes");
        }
    }

    if let Some(n) = hour.strip_prefix("*/") {
        if dom == "*" && month == "*" && dow == "*" {
            return format!("Every {n} hours at minute {minute}");
        }
    }

    if hour == "*" && dom == "*" && month == "*" && dow == "*" {
        return format!("Every hour at minute {minute}");
    }

    if dom == "*" && month == "*" && dow == "*" {
        return format!(
            "Daily at {}:{} UTC",
            format_number(hour),
            format_number(minute)
        );
    }

    if dom == "*" && month == "*" {
        let days = [
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
        ];
        let day_name = dow
            .parse::<usize>()
            .ok()
            .and_then(|i| days.get(i))
            .copied()
            .unwrap_or(dow);
        return format!(
            "Every {day_name} at {}:{} UTC",
            format_number(hour),
            format_number(minute)
        );
    }

    if month == "*" {
        return format!(
            "Monthly on day {dom} at {}:{} UTC",
            format_number(hour),
            format_number(minute)
        );
    }

    expr.to_string()
}

pub(crate) fn render_scheduled_tasks(tasks: &[ScheduledTaskForPrompt]) -> String {
    let recurring: Vec<&ScheduledTaskForPrompt> = tasks.iter().filter(|t| !t.is_oneoff).collect();
    let oneoff: Vec<&ScheduledTaskForPrompt> = tasks.iter().filter(|t| t.is_oneoff).collect();

    let mut sections: Vec<String> = Vec::new();

    if !recurring.is_empty() {
        let lines: Vec<String> = recurring
            .iter()
            .map(|t| {
                let human = humanize_cron(&t.cron_expr);
                format!(
                    "- **{}** [recurring]: {} (cron: `{}`)\n  ID: `{}`",
                    t.description, human, t.cron_expr, t.id
                )
            })
            .collect();
        sections.push(format!("### Recurring Tasks\n{}", lines.join("\n\n")));
    }

    if !oneoff.is_empty() {
        let lines: Vec<String> = oneoff
            .iter()
            .map(|t| {
                let when = t
                    .next_run_ms
                    .map(|ms| {
                        let secs = ms / 1000;
                        format!("at unix timestamp {secs}")
                    })
                    .unwrap_or_else(|| "at unknown time".to_string());
                format!(
                    "- **{}** [one-off]: Executes {}\n  ID: `{}`",
                    t.description, when, t.id
                )
            })
            .collect();
        sections.push(format!("### One-off Tasks\n{}", lines.join("\n\n")));
    }

    let total = tasks.len();
    let summary = if total == 1 {
        "1 scheduled task".to_string()
    } else {
        format!(
            "{total} scheduled tasks ({} recurring, {} one-off)",
            recurring.len(),
            oneoff.len()
        )
    };

    format!(
        "<scheduled-tasks>\nYou have {summary} that will trigger automatically:\n\n{}\n\nUse `kill` to remove any task by ID.\n</scheduled-tasks>",
        sections.join("\n\n")
    )
}

fn format_number(raw: &str) -> String {
    raw.parse::<u8>()
        .map(|n| format!("{n:02}"))
        .unwrap_or_else(|_| raw.to_string())
}
