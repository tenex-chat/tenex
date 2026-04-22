use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use thiserror::Error;

use crate::backend_events::project_status::ProjectStatusScheduledTaskKind;
use crate::periodic_tick::{PeriodicScheduler, PeriodicSchedulerSnapshot, PeriodicTickError};
use crate::project_status_sources::project_schedules_path;

pub const SCHEDULED_TASK_DUE_PLANNER_TASK_NAME: &str = "scheduled-task-due-planner";
pub const SCHEDULED_TASK_DUE_PLANNER_INTERVAL_SECONDS: u64 = 30;
pub const SCHEDULED_TASK_DUE_PLANNER_DEFAULT_GRACE_SECONDS: u64 = 24 * 60 * 60;

const CRON_SEARCH_LIMIT_SECONDS: u64 = 366 * 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledTaskDuePlannerProject<'a> {
    pub project_d_tag: &'a str,
}

#[derive(Debug)]
pub struct ScheduledTaskDuePlannerInput<'a> {
    pub tenex_base_dir: &'a Path,
    pub projects: &'a [ScheduledTaskDuePlannerProject<'a>],
    pub now: u64,
    pub grace_seconds: u64,
    pub max_plans: usize,
}

#[derive(Debug)]
pub struct ScheduledTaskDuePlannerTickInput<'a> {
    pub scheduler: &'a mut PeriodicScheduler,
    pub tenex_base_dir: &'a Path,
    pub projects: &'a [ScheduledTaskDuePlannerProject<'a>],
    pub now: u64,
    pub grace_seconds: u64,
    pub max_plans: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledTaskTriggerPlan {
    pub project_d_tag: String,
    pub project_ref: String,
    pub task_id: String,
    pub title: String,
    pub prompt: String,
    pub from_pubkey: String,
    pub target_agent: String,
    pub target_channel: Option<String>,
    pub schedule: String,
    pub kind: ProjectStatusScheduledTaskKind,
    pub due_at: u64,
    pub last_run: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledTaskDuePlannerOutcome {
    pub tick_due: bool,
    pub due_task_names: Vec<String>,
    pub plans: Vec<ScheduledTaskTriggerPlan>,
    pub truncated: bool,
    pub scheduler_snapshot: Option<PeriodicSchedulerSnapshot>,
}

#[derive(Debug, Error)]
pub enum ScheduledTaskDuePlannerError {
    #[error("scheduled task planner source read failed at {path}: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("scheduled task planner source parse failed at {path}: {source}")]
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("scheduled task planner periodic scheduler failed: {0}")]
    Periodic(#[from] PeriodicTickError),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawScheduledTask {
    id: Option<String>,
    title: Option<String>,
    schedule: Option<String>,
    prompt: Option<String>,
    last_run: Option<String>,
    created_at: Option<String>,
    from_pubkey: Option<String>,
    target_agent_slug: Option<String>,
    project_id: Option<String>,
    project_ref: Option<String>,
    #[serde(rename = "type")]
    task_type: Option<String>,
    execute_at: Option<String>,
    target_channel: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ScheduledTaskSource {
    project_d_tag: String,
    project_ref: String,
    id: String,
    title: String,
    schedule: String,
    prompt: String,
    from_pubkey: String,
    target_agent: String,
    target_channel: Option<String>,
    kind: ProjectStatusScheduledTaskKind,
    execute_at: Option<String>,
    created_at: Option<u64>,
    last_run: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CronSchedule {
    seconds: BTreeSet<u8>,
    minutes: BTreeSet<u8>,
    hours: BTreeSet<u8>,
    days_of_month: BTreeSet<u8>,
    months: BTreeSet<u8>,
    days_of_week: BTreeSet<u8>,
    day_of_month_any: bool,
    day_of_week_any: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct UtcComponents {
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
    day_of_week: u8,
}

pub fn ensure_scheduled_task_due_planner_task(
    scheduler: &mut PeriodicScheduler,
    first_due_at: u64,
) -> Result<bool, PeriodicTickError> {
    if scheduler.has_task(SCHEDULED_TASK_DUE_PLANNER_TASK_NAME) {
        return Ok(false);
    }

    scheduler.register_task(
        SCHEDULED_TASK_DUE_PLANNER_TASK_NAME,
        SCHEDULED_TASK_DUE_PLANNER_INTERVAL_SECONDS,
        first_due_at,
    )?;
    Ok(true)
}

pub fn tick_scheduled_task_due_planner(
    input: ScheduledTaskDuePlannerTickInput<'_>,
) -> Result<ScheduledTaskDuePlannerOutcome, ScheduledTaskDuePlannerError> {
    let due_task_names = input.scheduler.take_due(input.now);
    let tick_due = due_task_names
        .iter()
        .any(|task_name| task_name == SCHEDULED_TASK_DUE_PLANNER_TASK_NAME);

    let mut outcome = if tick_due {
        plan_due_scheduled_tasks(ScheduledTaskDuePlannerInput {
            tenex_base_dir: input.tenex_base_dir,
            projects: input.projects,
            now: input.now,
            grace_seconds: input.grace_seconds,
            max_plans: input.max_plans,
        })?
    } else {
        ScheduledTaskDuePlannerOutcome {
            tick_due: false,
            due_task_names: Vec::new(),
            plans: Vec::new(),
            truncated: false,
            scheduler_snapshot: None,
        }
    };

    outcome.tick_due = tick_due;
    outcome.due_task_names = due_task_names;
    outcome.scheduler_snapshot = Some(input.scheduler.inspect());
    Ok(outcome)
}

pub fn plan_due_scheduled_tasks(
    input: ScheduledTaskDuePlannerInput<'_>,
) -> Result<ScheduledTaskDuePlannerOutcome, ScheduledTaskDuePlannerError> {
    let mut plans = Vec::new();
    let grace_start = input.now.saturating_sub(input.grace_seconds);

    for project in input.projects {
        for task in
            read_project_scheduled_task_sources(input.tenex_base_dir, project.project_d_tag)?
        {
            let Some(due_at) = due_at(&task, input.now, grace_start) else {
                continue;
            };
            plans.push(ScheduledTaskTriggerPlan {
                project_d_tag: task.project_d_tag,
                project_ref: task.project_ref,
                task_id: task.id,
                title: task.title,
                prompt: task.prompt,
                from_pubkey: task.from_pubkey,
                target_agent: task.target_agent,
                target_channel: task.target_channel,
                schedule: task.schedule,
                kind: task.kind,
                due_at,
                last_run: task.last_run,
            });
        }
    }

    plans.sort_by(|left, right| {
        left.due_at
            .cmp(&right.due_at)
            .then_with(|| left.project_d_tag.cmp(&right.project_d_tag))
            .then_with(|| left.task_id.cmp(&right.task_id))
    });

    let truncated = plans.len() > input.max_plans;
    plans.truncate(input.max_plans);

    Ok(ScheduledTaskDuePlannerOutcome {
        tick_due: true,
        due_task_names: Vec::new(),
        plans,
        truncated,
        scheduler_snapshot: None,
    })
}

fn read_project_scheduled_task_sources(
    base_dir: &Path,
    project_d_tag: &str,
) -> Result<Vec<ScheduledTaskSource>, ScheduledTaskDuePlannerError> {
    let path = project_schedules_path(base_dir, project_d_tag);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => return Err(ScheduledTaskDuePlannerError::Read { path, source }),
    };

    let raw: serde_json::Value =
        serde_json::from_str(&content).map_err(|source| ScheduledTaskDuePlannerError::Parse {
            path: path.clone(),
            source,
        })?;
    let Some(raw_tasks) = raw.as_array() else {
        return Ok(Vec::new());
    };

    let mut tasks = Vec::new();
    for raw_task in raw_tasks {
        let parsed: RawScheduledTask = match serde_json::from_value(raw_task.clone()) {
            Ok(task) => task,
            Err(_) => continue,
        };

        let Some(task) = convert_raw_scheduled_task(project_d_tag, parsed) else {
            continue;
        };
        tasks.push(task);
    }

    Ok(tasks)
}

fn convert_raw_scheduled_task(
    project_d_tag: &str,
    raw: RawScheduledTask,
) -> Option<ScheduledTaskSource> {
    let id = nonempty(raw.id)?;
    let schedule = nonempty(raw.schedule)?;
    let prompt = nonempty(raw.prompt)?;
    let from_pubkey = nonempty(raw.from_pubkey)?;
    let target_agent = nonempty(raw.target_agent_slug)?;
    let project_id = nonempty(raw.project_id)?;
    let kind = if raw.task_type.as_deref() == Some("oneoff") {
        ProjectStatusScheduledTaskKind::Oneoff
    } else {
        ProjectStatusScheduledTaskKind::Cron
    };

    if kind == ProjectStatusScheduledTaskKind::Cron && CronSchedule::parse(&schedule).is_none() {
        return None;
    }

    let title = raw
        .title
        .and_then(|value| {
            if value.trim().is_empty() {
                None
            } else {
                Some(value)
            }
        })
        .unwrap_or_else(|| prompt.chars().take(50).collect());

    if title.is_empty() {
        return None;
    }

    let project_ref = nonempty(raw.project_ref).unwrap_or(project_id);

    Some(ScheduledTaskSource {
        project_d_tag: project_d_tag.to_string(),
        project_ref,
        id,
        title,
        schedule,
        prompt,
        from_pubkey,
        target_agent,
        target_channel: raw.target_channel.and_then(|value| nonempty(Some(value))),
        kind,
        execute_at: raw.execute_at.and_then(|value| nonempty(Some(value))),
        created_at: raw
            .created_at
            .as_deref()
            .and_then(parse_unix_seconds_from_iso8601),
        last_run: raw
            .last_run
            .as_deref()
            .and_then(parse_unix_seconds_from_iso8601),
    })
}

fn due_at(task: &ScheduledTaskSource, now: u64, grace_start: u64) -> Option<u64> {
    match task.kind {
        ProjectStatusScheduledTaskKind::Oneoff => oneoff_due_at(task, now, grace_start),
        ProjectStatusScheduledTaskKind::Cron => cron_due_at(task, now, grace_start),
    }
}

fn oneoff_due_at(task: &ScheduledTaskSource, now: u64, grace_start: u64) -> Option<u64> {
    if task.last_run.is_some() {
        return None;
    }

    let execute_at = task.execute_at.as_deref().unwrap_or(&task.schedule);
    let execute_at = parse_unix_seconds_from_iso8601(execute_at)?;
    if execute_at <= now && execute_at >= grace_start {
        Some(execute_at)
    } else {
        None
    }
}

fn cron_due_at(task: &ScheduledTaskSource, now: u64, grace_start: u64) -> Option<u64> {
    let anchor = task.last_run.or(task.created_at)?;
    if anchor >= now {
        return None;
    }

    let search_start = anchor.saturating_add(1).max(grace_start);
    next_cron_occurrence_between(&task.schedule, search_start, now)
}

fn next_cron_occurrence_between(schedule: &str, start: u64, end: u64) -> Option<u64> {
    if start > end {
        return None;
    }

    let schedule = CronSchedule::parse(schedule)?;
    let search_end = end.min(start.saturating_add(CRON_SEARCH_LIMIT_SECONDS));
    let mut minute_start = start - (start % 60);

    while minute_start <= search_end {
        for second in &schedule.seconds {
            let candidate = minute_start.saturating_add(u64::from(*second));
            if candidate < start || candidate > search_end {
                continue;
            }
            if schedule.matches(candidate) {
                return Some(candidate);
            }
        }
        minute_start = minute_start.saturating_add(60);
    }

    None
}

impl CronSchedule {
    fn parse(value: &str) -> Option<Self> {
        let fields: Vec<&str> = value.split_whitespace().collect();
        let (second_field, minute_field, hour_field, day_field, month_field, weekday_field) =
            match fields.as_slice() {
                [minute, hour, day, month, weekday] => {
                    ("0", *minute, *hour, *day, *month, *weekday)
                }
                [second, minute, hour, day, month, weekday] => {
                    (*second, *minute, *hour, *day, *month, *weekday)
                }
                _ => return None,
            };

        Some(Self {
            seconds: parse_cron_field(second_field, 0, 59, CronFieldNames::None, false)?,
            minutes: parse_cron_field(minute_field, 0, 59, CronFieldNames::None, false)?,
            hours: parse_cron_field(hour_field, 0, 23, CronFieldNames::None, false)?,
            days_of_month: parse_cron_field(day_field, 1, 31, CronFieldNames::None, true)?,
            months: parse_cron_field(month_field, 1, 12, CronFieldNames::Month, false)?,
            days_of_week: parse_cron_field(weekday_field, 0, 7, CronFieldNames::Weekday, true)?,
            day_of_month_any: cron_field_is_any(day_field, true),
            day_of_week_any: cron_field_is_any(weekday_field, true),
        })
    }

    fn matches(&self, unix_seconds: u64) -> bool {
        let components = unix_seconds_to_utc_components(unix_seconds);
        if !self.seconds.contains(&components.second)
            || !self.minutes.contains(&components.minute)
            || !self.hours.contains(&components.hour)
            || !self.months.contains(&components.month)
        {
            return false;
        }

        let day_of_month_match = self.days_of_month.contains(&components.day);
        let day_of_week_match = self.days_of_week.contains(&components.day_of_week);
        match (self.day_of_month_any, self.day_of_week_any) {
            (true, true) => true,
            (true, false) => day_of_week_match,
            (false, true) => day_of_month_match,
            (false, false) => day_of_month_match || day_of_week_match,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CronFieldNames {
    None,
    Month,
    Weekday,
}

fn parse_cron_field(
    value: &str,
    min: u8,
    max: u8,
    names: CronFieldNames,
    allow_question: bool,
) -> Option<BTreeSet<u8>> {
    let mut values = BTreeSet::new();

    for part in value.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return None;
        }

        let (base, step) = match part.split_once('/') {
            Some((base, step)) => {
                let step: u8 = step.parse().ok()?;
                if step == 0 {
                    return None;
                }
                (base, step)
            }
            None => (part, 1),
        };

        let range = if cron_field_is_any(base, allow_question) {
            (min, max)
        } else if let Some((left, right)) = base.split_once('-') {
            (
                parse_cron_value(left, names)?,
                parse_cron_value(right, names)?,
            )
        } else {
            let value = parse_cron_value(base, names)?;
            (value, value)
        };

        if range.0 < min || range.1 > max || range.0 > range.1 {
            return None;
        }

        for value in range.0..=range.1 {
            if (value - range.0) % step == 0 {
                values.insert(normalize_cron_value(value, max));
            }
        }
    }

    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn cron_field_is_any(value: &str, allow_question: bool) -> bool {
    value == "*" || (allow_question && value == "?")
}

fn parse_cron_value(value: &str, names: CronFieldNames) -> Option<u8> {
    let lower = value.to_ascii_lowercase();
    match names {
        CronFieldNames::None => lower.parse().ok(),
        CronFieldNames::Month => match lower.as_str() {
            "jan" => Some(1),
            "feb" => Some(2),
            "mar" => Some(3),
            "apr" => Some(4),
            "may" => Some(5),
            "jun" => Some(6),
            "jul" => Some(7),
            "aug" => Some(8),
            "sep" => Some(9),
            "oct" => Some(10),
            "nov" => Some(11),
            "dec" => Some(12),
            _ => lower.parse().ok(),
        },
        CronFieldNames::Weekday => match lower.as_str() {
            "sun" => Some(0),
            "mon" => Some(1),
            "tue" => Some(2),
            "wed" => Some(3),
            "thu" => Some(4),
            "fri" => Some(5),
            "sat" => Some(6),
            _ => lower.parse().ok(),
        },
    }
}

fn normalize_cron_value(value: u8, max: u8) -> u8 {
    if max == 7 && value == 7 { 0 } else { value }
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        if text.trim().is_empty() {
            None
        } else {
            Some(text)
        }
    })
}

fn parse_unix_seconds_from_iso8601(value: &str) -> Option<u64> {
    let (date_part, time_part) = value.split_once('T')?;
    let (time_part, offset_seconds) = split_timezone_offset(time_part)?;

    let (year, month, day) = parse_date(date_part)?;
    let (hour, minute, second) = parse_time(time_part)?;

    let days = days_from_civil(year, month, day);
    let utc_seconds = days
        .checked_mul(86_400)?
        .checked_add(hour * 3_600)?
        .checked_add(minute * 60)?
        .checked_add(second)?
        .checked_sub(offset_seconds)?;

    u64::try_from(utc_seconds).ok()
}

fn split_timezone_offset(value: &str) -> Option<(&str, i64)> {
    if let Some(time) = value.strip_suffix('Z') {
        return Some((time, 0));
    }

    let sign_index = value.rfind(['+', '-'])?;
    if sign_index < 8 {
        return None;
    }

    let (time, offset) = value.split_at(sign_index);
    Some((time, parse_offset_seconds(offset)?))
}

fn parse_offset_seconds(value: &str) -> Option<i64> {
    let sign = match value.as_bytes().first().copied()? {
        b'+' => 1_i64,
        b'-' => -1_i64,
        _ => return None,
    };

    let (hours, minutes) = value.get(1..)?.split_once(':')?;
    let hours: i64 = hours.parse().ok()?;
    let minutes: i64 = minutes.parse().ok()?;
    Some(sign * (hours * 3_600 + minutes * 60))
}

fn parse_date(value: &str) -> Option<(i64, i64, i64)> {
    let (year, rest) = value.split_once('-')?;
    let (month, day) = rest.split_once('-')?;
    Some((year.parse().ok()?, month.parse().ok()?, day.parse().ok()?))
}

fn parse_time(value: &str) -> Option<(i64, i64, i64)> {
    let core = value.split_once('.').map_or(value, |(left, _)| left);
    let (hour, rest) = core.split_once(':')?;
    let (minute, second) = rest.split_once(':')?;
    Some((
        hour.parse().ok()?,
        minute.parse().ok()?,
        second.parse().ok()?,
    ))
}

fn unix_seconds_to_utc_components(seconds: u64) -> UtcComponents {
    let days = seconds / 86_400;
    let rem = seconds % 86_400;
    let (_, month, day) = civil_from_days(days as i64);

    UtcComponents {
        month: month as u8,
        day: day as u8,
        hour: (rem / 3_600) as u8,
        minute: ((rem % 3_600) / 60) as u8,
        second: (rem % 60) as u8,
        day_of_week: ((days as i64 + 4).rem_euclid(7)) as u8,
    }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::periodic_tick_state::{
        read_periodic_scheduler_state, write_periodic_scheduler_state,
    };
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn recurring_task_due_after_created_at_plans_trigger() {
        let base_dir = unique_temp_dir("scheduled-task-planner-recurring-due");
        write_project_schedules(
            &base_dir,
            "demo-project",
            r#"[
                {
                    "id": "task-recurring",
                    "title": "Daily summary",
                    "schedule": "0 9 * * *",
                    "prompt": "Summarize the work",
                    "fromPubkey": "owner",
                    "targetAgentSlug": "reporter",
                    "projectId": "demo-project",
                    "projectRef": "31933:owner:demo-project",
                    "createdAt": "2026-04-22T08:00:00Z"
                }
            ]"#,
        );

        let outcome = plan_due_scheduled_tasks(ScheduledTaskDuePlannerInput {
            tenex_base_dir: &base_dir,
            projects: &[ScheduledTaskDuePlannerProject {
                project_d_tag: "demo-project",
            }],
            now: ts("2026-04-22T09:00:05Z"),
            grace_seconds: SCHEDULED_TASK_DUE_PLANNER_DEFAULT_GRACE_SECONDS,
            max_plans: 10,
        })
        .expect("planner must read schedules");

        assert_eq!(outcome.plans.len(), 1);
        assert_eq!(outcome.plans[0].task_id, "task-recurring");
        assert_eq!(outcome.plans[0].target_agent, "reporter");
        assert_eq!(outcome.plans[0].due_at, ts("2026-04-22T09:00:00Z"));
        assert_eq!(outcome.plans[0].kind, ProjectStatusScheduledTaskKind::Cron);
        assert!(!outcome.truncated);
    }

    #[test]
    fn recurring_task_not_due_when_last_run_covers_current_window() {
        let base_dir = unique_temp_dir("scheduled-task-planner-recurring-not-due");
        write_project_schedules(
            &base_dir,
            "demo-project",
            r#"[
                {
                    "id": "task-recurring",
                    "schedule": "0 9 * * *",
                    "prompt": "Summarize the work",
                    "fromPubkey": "owner",
                    "targetAgentSlug": "reporter",
                    "projectId": "demo-project",
                    "createdAt": "2026-04-22T08:00:00Z",
                    "lastRun": "2026-04-22T09:00:00Z"
                }
            ]"#,
        );

        let outcome = plan_due_scheduled_tasks(ScheduledTaskDuePlannerInput {
            tenex_base_dir: &base_dir,
            projects: &[ScheduledTaskDuePlannerProject {
                project_d_tag: "demo-project",
            }],
            now: ts("2026-04-22T09:00:20Z"),
            grace_seconds: SCHEDULED_TASK_DUE_PLANNER_DEFAULT_GRACE_SECONDS,
            max_plans: 10,
        })
        .expect("planner must read schedules");

        assert!(outcome.plans.is_empty());
    }

    #[test]
    fn oneoff_due_task_plans_once_and_skips_future_or_already_run_tasks() {
        let base_dir = unique_temp_dir("scheduled-task-planner-oneoff");
        write_project_schedules(
            &base_dir,
            "demo-project",
            r#"[
                {
                    "id": "task-due",
                    "title": "Send release note",
                    "schedule": "2026-04-22T09:00:00Z",
                    "prompt": "Send the release note",
                    "fromPubkey": "owner",
                    "targetAgentSlug": "reporter",
                    "projectId": "demo-project",
                    "type": "oneoff",
                    "executeAt": "2026-04-22T09:00:00Z",
                    "targetChannel": "channel-1"
                },
                {
                    "id": "task-future",
                    "schedule": "2026-04-22T10:00:00Z",
                    "prompt": "Future task",
                    "fromPubkey": "owner",
                    "targetAgentSlug": "reporter",
                    "projectId": "demo-project",
                    "type": "oneoff",
                    "executeAt": "2026-04-22T10:00:00Z"
                },
                {
                    "id": "task-ran",
                    "schedule": "2026-04-22T08:00:00Z",
                    "prompt": "Already ran",
                    "fromPubkey": "owner",
                    "targetAgentSlug": "reporter",
                    "projectId": "demo-project",
                    "type": "oneoff",
                    "executeAt": "2026-04-22T08:00:00Z",
                    "lastRun": "2026-04-22T08:00:01Z"
                }
            ]"#,
        );

        let outcome = plan_due_scheduled_tasks(ScheduledTaskDuePlannerInput {
            tenex_base_dir: &base_dir,
            projects: &[ScheduledTaskDuePlannerProject {
                project_d_tag: "demo-project",
            }],
            now: ts("2026-04-22T09:00:00Z"),
            grace_seconds: SCHEDULED_TASK_DUE_PLANNER_DEFAULT_GRACE_SECONDS,
            max_plans: 10,
        })
        .expect("planner must read schedules");

        assert_eq!(outcome.plans.len(), 1);
        assert_eq!(outcome.plans[0].task_id, "task-due");
        assert_eq!(
            outcome.plans[0].kind,
            ProjectStatusScheduledTaskKind::Oneoff
        );
        assert_eq!(
            outcome.plans[0].target_channel.as_deref(),
            Some("channel-1")
        );
    }

    #[test]
    fn bounded_plans_are_sorted_and_truncated() {
        let base_dir = unique_temp_dir("scheduled-task-planner-bounded");
        write_project_schedules(
            &base_dir,
            "beta",
            r#"[
                {
                    "id": "task-late",
                    "schedule": "2026-04-22T09:00:30Z",
                    "prompt": "Late",
                    "fromPubkey": "owner",
                    "targetAgentSlug": "reporter",
                    "projectId": "beta",
                    "type": "oneoff"
                }
            ]"#,
        );
        write_project_schedules(
            &base_dir,
            "alpha",
            r#"[
                {
                    "id": "task-early",
                    "schedule": "2026-04-22T09:00:00Z",
                    "prompt": "Early",
                    "fromPubkey": "owner",
                    "targetAgentSlug": "reporter",
                    "projectId": "alpha",
                    "type": "oneoff"
                },
                {
                    "id": "task-middle",
                    "schedule": "2026-04-22T09:00:10Z",
                    "prompt": "Middle",
                    "fromPubkey": "owner",
                    "targetAgentSlug": "reporter",
                    "projectId": "alpha",
                    "type": "oneoff"
                }
            ]"#,
        );

        let outcome = plan_due_scheduled_tasks(ScheduledTaskDuePlannerInput {
            tenex_base_dir: &base_dir,
            projects: &[
                ScheduledTaskDuePlannerProject {
                    project_d_tag: "beta",
                },
                ScheduledTaskDuePlannerProject {
                    project_d_tag: "alpha",
                },
            ],
            now: ts("2026-04-22T09:01:00Z"),
            grace_seconds: SCHEDULED_TASK_DUE_PLANNER_DEFAULT_GRACE_SECONDS,
            max_plans: 2,
        })
        .expect("planner must read schedules");

        assert!(outcome.truncated);
        assert_eq!(
            outcome
                .plans
                .iter()
                .map(|plan| plan.task_id.as_str())
                .collect::<Vec<_>>(),
            vec!["task-early", "task-middle"]
        );
    }

    #[test]
    fn periodic_tick_state_replay_prevents_immediate_rescan() {
        let base_dir = unique_temp_dir("scheduled-task-planner-periodic-base");
        let daemon_dir = unique_temp_dir("scheduled-task-planner-periodic-daemon");
        write_project_schedules(
            &base_dir,
            "demo-project",
            r#"[
                {
                    "id": "task-due",
                    "schedule": "1970-01-01T00:01:40Z",
                    "prompt": "Due task",
                    "fromPubkey": "owner",
                    "targetAgentSlug": "reporter",
                    "projectId": "demo-project",
                    "type": "oneoff"
                }
            ]"#,
        );

        let mut scheduler = PeriodicScheduler::new();
        let registered = ensure_scheduled_task_due_planner_task(&mut scheduler, 100)
            .expect("planner task must register");
        assert!(registered);

        let first = tick_scheduled_task_due_planner(ScheduledTaskDuePlannerTickInput {
            scheduler: &mut scheduler,
            tenex_base_dir: &base_dir,
            projects: &[ScheduledTaskDuePlannerProject {
                project_d_tag: "demo-project",
            }],
            now: 100,
            grace_seconds: SCHEDULED_TASK_DUE_PLANNER_DEFAULT_GRACE_SECONDS,
            max_plans: 10,
        })
        .expect("tick must plan due task");

        assert!(first.tick_due);
        assert_eq!(
            first.due_task_names,
            vec![SCHEDULED_TASK_DUE_PLANNER_TASK_NAME]
        );
        assert_eq!(first.plans.len(), 1);

        write_periodic_scheduler_state(&daemon_dir, &scheduler)
            .expect("scheduler snapshot must persist");
        let mut replayed =
            read_periodic_scheduler_state(&daemon_dir).expect("scheduler snapshot must replay");

        let second = tick_scheduled_task_due_planner(ScheduledTaskDuePlannerTickInput {
            scheduler: &mut replayed,
            tenex_base_dir: &base_dir,
            projects: &[ScheduledTaskDuePlannerProject {
                project_d_tag: "demo-project",
            }],
            now: 110,
            grace_seconds: SCHEDULED_TASK_DUE_PLANNER_DEFAULT_GRACE_SECONDS,
            max_plans: 10,
        })
        .expect("replayed tick must not rescan before next deadline");

        assert!(!second.tick_due);
        assert!(second.due_task_names.is_empty());
        assert!(second.plans.is_empty());
    }

    fn write_project_schedules(base_dir: &Path, project_d_tag: &str, content: &str) {
        let path = project_schedules_path(base_dir, project_d_tag);
        fs::create_dir_all(path.parent().expect("schedules path must have parent"))
            .expect("project schedules dir must create");
        fs::write(path, content).expect("schedules file must write");
    }

    fn ts(value: &str) -> u64 {
        parse_unix_seconds_from_iso8601(value).expect("timestamp must parse")
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }
}
