use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

use crate::backend_events::project_status::{
    ProjectStatusScheduledTask, ProjectStatusScheduledTaskKind,
};

pub const GLOBAL_LLMS_FILE_NAME: &str = "llms.json";
pub const PROJECT_SCHEDULES_FILE_NAME: &str = "schedules.json";

#[derive(Debug, Error)]
pub enum ProjectStatusSourceError {
    #[error("failed to read project-status source file {path}: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("failed to parse project-status source file {path}: {source}")]
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
}

#[derive(Debug, Deserialize)]
struct RawGlobalLlms {
    #[serde(default)]
    configurations: serde_json::Map<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawScheduledTask {
    id: Option<String>,
    title: Option<String>,
    schedule: Option<String>,
    prompt: Option<String>,
    last_run: Option<String>,
    target_agent_slug: Option<String>,
    #[serde(rename = "type")]
    task_type: Option<String>,
}

pub fn global_llms_path(base_dir: impl AsRef<Path>) -> PathBuf {
    base_dir.as_ref().join(GLOBAL_LLMS_FILE_NAME)
}

pub fn project_schedules_path(base_dir: impl AsRef<Path>, project_d_tag: &str) -> PathBuf {
    base_dir
        .as_ref()
        .join("projects")
        .join(project_d_tag)
        .join(PROJECT_SCHEDULES_FILE_NAME)
}

pub fn read_global_llm_model_keys(
    base_dir: impl AsRef<Path>,
) -> Result<Vec<String>, ProjectStatusSourceError> {
    let path = global_llms_path(base_dir);
    let Some(content) = read_optional_text_file(&path)? else {
        return Ok(Vec::new());
    };

    let raw: RawGlobalLlms =
        serde_json::from_str(&content).map_err(|source| ProjectStatusSourceError::Parse {
            path: path.clone(),
            source,
        })?;

    let mut model_keys: Vec<String> = raw.configurations.into_iter().map(|(key, _)| key).collect();
    model_keys.sort();
    Ok(model_keys)
}

pub fn read_project_scheduled_tasks(
    base_dir: impl AsRef<Path>,
    project_d_tag: &str,
) -> Result<Vec<ProjectStatusScheduledTask>, ProjectStatusSourceError> {
    let path = project_schedules_path(base_dir, project_d_tag);
    let Some(content) = read_optional_text_file(&path)? else {
        return Ok(Vec::new());
    };

    let root: Value =
        serde_json::from_str(&content).map_err(|source| ProjectStatusSourceError::Parse {
            path: path.clone(),
            source,
        })?;

    let Some(raw_tasks) = root.as_array() else {
        return Ok(Vec::new());
    };

    let mut tasks = Vec::new();
    for raw_task in raw_tasks {
        let parsed: RawScheduledTask = match serde_json::from_value(raw_task.clone()) {
            Ok(task) => task,
            Err(_) => continue,
        };

        let Some(task) = convert_raw_scheduled_task(parsed) else {
            continue;
        };
        tasks.push(task);
    }

    tasks.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.schedule.cmp(&right.schedule))
            .then_with(|| left.target_agent.cmp(&right.target_agent))
    });

    Ok(tasks)
}

fn convert_raw_scheduled_task(raw: RawScheduledTask) -> Option<ProjectStatusScheduledTask> {
    let id = nonempty(raw.id)?;
    let schedule = nonempty(raw.schedule)?;
    let target_agent = nonempty(raw.target_agent_slug)?;
    let prompt = nonempty(raw.prompt)?;

    if raw.task_type.as_deref() != Some("oneoff") && !looks_like_cron_expression(&schedule) {
        return None;
    }

    let title = raw
        .title
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| prompt.chars().take(50).collect());

    if title.is_empty() {
        return None;
    }

    Some(ProjectStatusScheduledTask {
        id,
        title,
        schedule,
        target_agent,
        kind: if raw.task_type.as_deref() == Some("oneoff") {
            ProjectStatusScheduledTaskKind::Oneoff
        } else {
            ProjectStatusScheduledTaskKind::Cron
        },
        last_run: raw
            .last_run
            .as_deref()
            .and_then(parse_unix_seconds_from_iso8601),
    })
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() { None } else { Some(text) }
    })
}

fn read_optional_text_file(path: &Path) -> Result<Option<String>, ProjectStatusSourceError> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(ProjectStatusSourceError::Read {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn looks_like_cron_expression(value: &str) -> bool {
    let fields: Vec<&str> = value.split_whitespace().collect();
    if fields.len() != 5 && fields.len() != 6 {
        return false;
    }

    fields.iter().all(|field| {
        !field.is_empty()
            && field
                .chars()
                .all(|ch| matches!(ch, '0'..='9' | 'a'..='z' | 'A'..='Z' | '*' | '/' | ',' | '-' | '?' | '#'))
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

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }

    #[test]
    fn reads_global_llm_model_keys_in_sorted_order() {
        let base_dir = unique_temp_dir("project-status-llms");
        fs::create_dir_all(&base_dir).expect("create temp dir");
        fs::write(
            global_llms_path(&base_dir),
            r#"{
                "configurations": {
                    "zeta": { "provider": "openai", "model": "gpt-4o" },
                    "alpha": { "provider": "anthropic", "model": "claude-3.5-sonnet" },
                    "beta": {
                        "provider": "meta",
                        "variants": {
                            "fast": { "model": "alpha" }
                        },
                        "default": "fast"
                    }
                },
                "default": "zeta",
                "summarization": "alpha",
                "supervision": "beta",
                "promptCompilation": "beta",
                "categorization": "alpha"
            }"#,
        )
        .expect("write llms file");

        let model_keys = read_global_llm_model_keys(&base_dir).expect("read llms");

        assert_eq!(
            model_keys,
            vec!["alpha".to_string(), "beta".to_string(), "zeta".to_string()]
        );
    }

    #[test]
    fn reads_project_schedules_and_converts_active_tasks() {
        let base_dir = unique_temp_dir("project-status-schedules");
        fs::create_dir_all(
            project_schedules_path(&base_dir, "demo-project")
                .parent()
                .unwrap(),
        )
        .expect("create project dir");
        fs::write(
            project_schedules_path(&base_dir, "demo-project"),
            r#"[
                {
                    "id": "task-cron",
                    "title": "",
                    "schedule": "0 9 * * *",
                    "prompt": "Run the daily standup summary",
                    "fromPubkey": "user-pubkey",
                    "targetAgentSlug": "architect",
                    "projectId": "demo-project"
                },
                {
                    "id": "task-oneoff",
                    "title": "Release announcement",
                    "schedule": "2026-03-01T12:00:00.000Z",
                    "prompt": "Announce the v2 release",
                    "fromPubkey": "user-pubkey",
                    "targetAgentSlug": "reporter",
                    "projectId": "demo-project",
                    "type": "oneoff",
                    "executeAt": "2026-03-01T12:00:00.000Z",
                    "lastRun": "1970-01-01T00:00:42.123Z"
                },
                {
                    "id": "task-invalid",
                    "schedule": "not-a-cron",
                    "prompt": "This should be skipped",
                    "fromPubkey": "user-pubkey",
                    "targetAgentSlug": "architect",
                    "projectId": "demo-project"
                }
            ]"#,
        )
        .expect("write schedules file");

        let tasks = read_project_scheduled_tasks(&base_dir, "demo-project").expect("read tasks");

        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].id, "task-cron");
        assert_eq!(tasks[0].title, "Run the daily standup summary");
        assert_eq!(tasks[0].schedule, "0 9 * * *");
        assert_eq!(tasks[0].target_agent, "architect");
        assert_eq!(tasks[0].kind, ProjectStatusScheduledTaskKind::Cron);
        assert_eq!(tasks[0].last_run, None);

        assert_eq!(tasks[1].id, "task-oneoff");
        assert_eq!(tasks[1].title, "Release announcement");
        assert_eq!(tasks[1].schedule, "2026-03-01T12:00:00.000Z");
        assert_eq!(tasks[1].target_agent, "reporter");
        assert_eq!(tasks[1].kind, ProjectStatusScheduledTaskKind::Oneoff);
        assert_eq!(tasks[1].last_run, Some(42));
    }

    #[test]
    fn missing_files_return_empty_vectors() {
        let base_dir = unique_temp_dir("project-status-missing");

        assert_eq!(
            read_global_llm_model_keys(&base_dir).expect("read missing llms"),
            Vec::<String>::new()
        );
        assert_eq!(
            read_project_scheduled_tasks(&base_dir, "demo-project")
                .expect("read missing schedules"),
            Vec::<ProjectStatusScheduledTask>::new()
        );
    }
}
