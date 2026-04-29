use chrono::{DateTime, Utc};
use croner::{errors::CronError, Cron};

use crate::model::ScheduledTask;

pub fn parse_schedule(schedule: &str) -> Result<Cron, CronError> {
    Cron::new(schedule).parse()
}

pub fn missed_occurrences(
    task: &ScheduledTask,
    now: DateTime<Utc>,
    catchup_window_secs: i64,
) -> Result<Vec<DateTime<Utc>>, CronError> {
    let cron = parse_schedule(&task.schedule)?;
    let last_run = task
        .last_run
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc));

    let Some(from) = last_run else {
        return Ok(Vec::new());
    };

    let cutoff = now - chrono::Duration::seconds(catchup_window_secs);
    let start = from.max(cutoff);

    let mut missed = Vec::new();
    for t in cron.iter_from(start) {
        if t >= now {
            break;
        }
        missed.push(t);
    }
    Ok(missed)
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::model::TaskType;

    #[test]
    fn five_field_schedule_finds_next_occurrence() {
        let cron = parse_schedule("0 9 * * *").expect("cron parses");
        let start = Utc.with_ymd_and_hms(2026, 4, 29, 8, 30, 0).unwrap();

        let next = cron
            .find_next_occurrence(&start, false)
            .expect("next occurrence");

        assert_eq!(next, Utc.with_ymd_and_hms(2026, 4, 29, 9, 0, 0).unwrap());
    }

    #[test]
    fn missed_occurrences_uses_parsed_five_field_schedule() {
        let task = cron_task("0 9 * * *", Some("2026-04-29T08:00:00Z"));
        let now = Utc.with_ymd_and_hms(2026, 4, 29, 10, 0, 0).unwrap();

        let missed = missed_occurrences(&task, now, 24 * 60 * 60).expect("missed occurrences");

        assert_eq!(
            missed,
            vec![Utc.with_ymd_and_hms(2026, 4, 29, 9, 0, 0).unwrap()]
        );
    }

    #[test]
    fn invalid_schedule_is_reported() {
        let task = cron_task("not a cron", Some("2026-04-29T08:00:00Z"));
        let now = Utc.with_ymd_and_hms(2026, 4, 29, 10, 0, 0).unwrap();

        assert!(missed_occurrences(&task, now, 24 * 60 * 60).is_err());
    }

    fn cron_task(schedule: &str, last_run: Option<&str>) -> ScheduledTask {
        ScheduledTask {
            id: "task-1".to_string(),
            title: None,
            schedule: schedule.to_string(),
            prompt: "prompt".to_string(),
            last_run: last_run.map(str::to_string),
            next_run: None,
            created_at: None,
            from_pubkey: None,
            target_agent_slug: "agent".to_string(),
            project_id: "project".to_string(),
            project_ref: None,
            task_type: Some(TaskType::Cron),
            execute_at: None,
            target_channel: None,
        }
    }
}
