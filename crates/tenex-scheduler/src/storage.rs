use std::fs;

use anyhow::{anyhow, Context, Result};
use chrono::DateTime;

use crate::model::ScheduledTask;
use crate::paths;

/// Enforce schema invariants that aren't expressible at the type level.
///
/// A one-off task must carry an `executeAt` field that parses as RFC3339.
/// Cron tasks have no such constraint here (the cron expression is parsed
/// when the timer arms).
fn validate_task(task: &ScheduledTask) -> Result<()> {
    if task.is_oneoff() {
        let execute_at = task.execute_at.as_deref().ok_or_else(|| {
            anyhow!(
                "one-off task '{}' is missing required 'executeAt' field",
                task.id
            )
        })?;
        DateTime::parse_from_rfc3339(execute_at).with_context(|| {
            format!(
                "one-off task '{}' has invalid RFC3339 'executeAt': {execute_at}",
                task.id
            )
        })?;
    }
    Ok(())
}

/// Discover all project dTags that have a schedules.json.
pub fn list_project_dtags() -> Result<Vec<String>> {
    let projects_dir = paths::projects_dir();
    if !projects_dir.exists() {
        return Ok(Vec::new());
    }

    let mut dtags = Vec::new();
    for entry in
        fs::read_dir(&projects_dir).with_context(|| format!("read {}", projects_dir.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let schedules_path = paths::project_schedules_file(&name);
        if schedules_path.exists() {
            dtags.push(name);
        }
    }
    Ok(dtags)
}

/// Load tasks from a project's schedules.json. Returns empty vec if absent.
///
/// Every task is validated against schema invariants (see [`validate_task`]).
/// A malformed entry fails the entire load so callers never observe a
/// partially valid set.
pub fn load_tasks(d_tag: &str) -> Result<Vec<ScheduledTask>> {
    let path = paths::project_schedules_file(d_tag);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let tasks: Vec<ScheduledTask> =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    for task in &tasks {
        validate_task(task).with_context(|| format!("validate {}", path.display()))?;
    }
    Ok(tasks)
}

/// Save tasks to a project's schedules.json atomically (write-temp-then-rename).
///
/// Every task is validated against schema invariants (see [`validate_task`])
/// before any bytes touch disk.
pub fn save_tasks(d_tag: &str, tasks: &[ScheduledTask]) -> Result<()> {
    for task in tasks {
        validate_task(task)?;
    }
    let path = paths::project_schedules_file(d_tag);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(tasks).context("serialize schedules")?;
    fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, &path).with_context(|| format!("rename to {}", path.display()))?;
    Ok(())
}

/// Remove a task by ID from a project's schedules.json. Returns true if found.
pub fn remove_task(d_tag: &str, task_id: &str) -> Result<bool> {
    let mut tasks = load_tasks(d_tag)?;
    let before = tasks.len();
    tasks.retain(|t| t.id != task_id);
    if tasks.len() == before {
        return Ok(false);
    }
    save_tasks(d_tag, &tasks)?;
    Ok(true)
}

/// Append a new task to a project's schedules.json.
pub fn add_task(d_tag: &str, task: ScheduledTask) -> Result<()> {
    let mut tasks = load_tasks(d_tag)?;
    tasks.push(task);
    save_tasks(d_tag, &tasks)
}

/// Update `lastRun` for a task after it fires.
pub fn update_last_run(d_tag: &str, task_id: &str, last_run_iso: &str) -> Result<()> {
    let mut tasks = load_tasks(d_tag)?;
    for task in &mut tasks {
        if task.id == task_id {
            task.last_run = Some(last_run_iso.to_string());
            break;
        }
    }
    save_tasks(d_tag, &tasks)
}

/// Find the dTag for a given task ID by scanning all projects.
pub fn find_project_for_task(task_id: &str) -> Result<Option<String>> {
    for d_tag in list_project_dtags()? {
        let tasks = load_tasks(&d_tag)?;
        if tasks.iter().any(|t| t.id == task_id) {
            return Ok(Some(d_tag));
        }
    }
    Ok(None)
}

/// All tasks across all projects, with their dTag.
pub fn all_tasks() -> Result<Vec<(String, ScheduledTask)>> {
    let mut result = Vec::new();
    for d_tag in list_project_dtags()? {
        for task in load_tasks(&d_tag)? {
            result.push((d_tag.clone(), task));
        }
    }
    Ok(result)
}

/// All tasks for a given agent pubkey across all projects.
pub fn tasks_for_agent(agent_pubkey: &str) -> Result<Vec<ScheduledTask>> {
    let mut result = Vec::new();
    for d_tag in list_project_dtags()? {
        for task in load_tasks(&d_tag)? {
            if task.from_pubkey.as_deref() == Some(agent_pubkey) {
                result.push(task);
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TaskType;

    fn oneoff_task(execute_at: Option<&str>) -> ScheduledTask {
        ScheduledTask {
            id: "task-1".to_string(),
            title: None,
            schedule: "2026-04-29T09:00:00Z".to_string(),
            prompt: "p".to_string(),
            last_run: None,
            next_run: None,
            created_at: None,
            from_pubkey: None,
            target_agent_slug: "agent".to_string(),
            project_id: "project".to_string(),
            project_ref: None,
            task_type: Some(TaskType::Oneoff),
            execute_at: execute_at.map(str::to_string),
            target_channel: None,
        }
    }

    #[test]
    fn validate_rejects_oneoff_without_execute_at() {
        let err = validate_task(&oneoff_task(None)).unwrap_err();
        assert!(
            err.to_string().contains("missing required 'executeAt'"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn validate_rejects_oneoff_with_unparseable_execute_at() {
        let err = validate_task(&oneoff_task(Some("not a timestamp"))).unwrap_err();
        assert!(
            err.to_string().contains("invalid RFC3339 'executeAt'"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn validate_accepts_oneoff_with_valid_execute_at() {
        validate_task(&oneoff_task(Some("2026-04-29T09:00:00Z"))).unwrap();
    }

    #[test]
    fn validate_accepts_cron_without_execute_at() {
        let mut task = oneoff_task(None);
        task.task_type = Some(TaskType::Cron);
        task.schedule = "0 9 * * *".to_string();
        validate_task(&task).unwrap();
    }

    #[test]
    fn load_tasks_rejects_oneoff_fixture_missing_execute_at() {
        // Mirrors the body of `load_tasks` against an in-memory fixture.
        // We avoid going through the disk path because tests can't safely
        // write to the user's `~/.tenex` directory.
        let fixture = r#"[
            {
                "id": "task-1",
                "schedule": "2026-04-29T09:00:00Z",
                "prompt": "p",
                "targetAgentSlug": "agent",
                "projectId": "project",
                "type": "oneoff"
            }
        ]"#;

        let tasks: Vec<ScheduledTask> = serde_json::from_str(fixture).unwrap();
        let err = tasks
            .iter()
            .try_for_each(validate_task)
            .expect_err("validation must reject oneoff without executeAt");
        assert!(
            err.to_string().contains("missing required 'executeAt'"),
            "unexpected error: {err}"
        );
    }
}
