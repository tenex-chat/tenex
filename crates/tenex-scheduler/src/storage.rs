use std::fs;

use anyhow::{Context, Result};

use crate::model::ScheduledTask;
use crate::paths;

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
pub fn load_tasks(d_tag: &str) -> Result<Vec<ScheduledTask>> {
    let path = paths::project_schedules_file(d_tag);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
}

/// Save tasks to a project's schedules.json atomically (write-temp-then-rename).
pub fn save_tasks(d_tag: &str, tasks: &[ScheduledTask]) -> Result<()> {
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
