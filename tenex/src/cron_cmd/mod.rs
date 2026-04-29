//! `tenex cron` — interactive TUI for managing scheduled tasks.
//!
//! Reads and writes `~/.tenex/projects/<dTag>/schedules.json` directly,
//! the same files the `tenex-scheduler` daemon watches via inotify.
//! No IPC with the daemon is needed — file-watch reconciliation picks up
//! changes automatically within seconds.

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use clap::Args;
use crossterm::cursor::{MoveToColumn, MoveUp};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::style::{Attribute, Color, Print, ResetColor, SetAttribute, SetForegroundColor};
use crossterm::terminal::{Clear, ClearType};
use crossterm::{queue, QueueableCommand};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use uuid::Uuid;

use crate::tui::custom_prompts::RawMode;
use crate::tui::glyphs;
use crate::tui::prompts;
use crate::tui::theme;

#[derive(Args)]
pub struct CronArgs {}

pub async fn run(_args: CronArgs) -> Result<()> {
    let tasks = load_all_tasks()?;
    cron_tui(tasks)
}

// ─── Data model (mirrors tenex-scheduler's model.rs exactly) ──────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum TaskType {
    Cron,
    Oneoff,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledTask {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    schedule: String,
    prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    from_pubkey: Option<String>,
    target_agent_slug: String,
    project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_ref: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    task_type: Option<TaskType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    execute_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_channel: Option<String>,
}

impl ScheduledTask {
    fn is_oneoff(&self) -> bool {
        matches!(self.task_type, Some(TaskType::Oneoff))
    }

    fn display_schedule(&self) -> &str {
        if self.is_oneoff() {
            self.execute_at.as_deref().unwrap_or("[missing execute_at]")
        } else {
            &self.schedule
        }
    }

    fn type_label(&self) -> &str {
        if self.is_oneoff() {
            "once"
        } else {
            "cron"
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SchedulesFile {
    #[serde(default)]
    tasks: Vec<ScheduledTask>,
}

#[derive(Debug, Clone)]
struct TaskEntry {
    d_tag: String,
    task: ScheduledTask,
}

// ─── Storage helpers ────────────────────────────────────────────────────────

fn base_dir() -> Result<PathBuf> {
    if let Ok(custom) = std::env::var("TENEX_BASE_DIR") {
        return Ok(PathBuf::from(custom));
    }
    dirs_next::home_dir()
        .map(|h| h.join(".tenex"))
        .ok_or_else(|| anyhow!("cannot determine home directory"))
}

fn projects_dir() -> Result<PathBuf> {
    Ok(base_dir()?.join("projects"))
}

fn schedules_path(d_tag: &str) -> Result<PathBuf> {
    Ok(projects_dir()?.join(d_tag).join("schedules.json"))
}

fn load_all_tasks() -> Result<Vec<TaskEntry>> {
    let dir = projects_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(&dir).with_context(|| format!("read {}", dir.display()))? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let d_tag = entry.file_name().to_string_lossy().into_owned();
        let path = schedules_path(&d_tag)?;
        if !path.exists() {
            continue;
        }
        let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        let file: SchedulesFile =
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
        for task in file.tasks {
            result.push(TaskEntry {
                d_tag: d_tag.clone(),
                task,
            });
        }
    }
    Ok(result)
}

fn save_tasks(d_tag: &str, tasks: &[ScheduledTask]) -> Result<()> {
    let path = schedules_path(d_tag)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let file = SchedulesFile {
        tasks: tasks.to_vec(),
    };
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&file).context("serialize")?;
    fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, &path).with_context(|| format!("rename to {}", path.display()))?;
    Ok(())
}

fn remove_task_from_project(d_tag: &str, task_id: &str) -> Result<()> {
    let path = schedules_path(d_tag)?;
    if !path.exists() {
        return Ok(());
    }
    let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let mut file: SchedulesFile =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    file.tasks.retain(|t| t.id != task_id);
    save_tasks(d_tag, &file.tasks)
}

fn add_task_to_project(d_tag: &str, task: ScheduledTask) -> Result<()> {
    let path = schedules_path(d_tag)?;
    let mut file = if path.exists() {
        let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        serde_json::from_slice::<SchedulesFile>(&bytes)
            .with_context(|| format!("parse {}", path.display()))?
    } else {
        SchedulesFile::default()
    };
    file.tasks.push(task);
    save_tasks(d_tag, &file.tasks)
}

// ─── TUI state machine ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TuiInput {
    Up,
    Down,
    Add,
    Delete,
    RunNow,
    Quit,
    Other,
}

impl TuiInput {
    fn from_key_event(ev: KeyEvent) -> Self {
        if ev.modifiers.contains(KeyModifiers::CONTROL) && matches!(ev.code, KeyCode::Char('c')) {
            return TuiInput::Quit;
        }
        match ev.code {
            KeyCode::Up | KeyCode::Char('k') => TuiInput::Up,
            KeyCode::Down | KeyCode::Char('j') => TuiInput::Down,
            KeyCode::Char('a') => TuiInput::Add,
            KeyCode::Char('d') => TuiInput::Delete,
            KeyCode::Char('r') => TuiInput::RunNow,
            KeyCode::Char('q') | KeyCode::Esc => TuiInput::Quit,
            _ => TuiInput::Other,
        }
    }
}

// ─── Rendering constants ─────────────────────────────────────────────────────

const COL_PROJECT: usize = 18;
const COL_TITLE: usize = 22;
const COL_SCHEDULE: usize = 22;
const COL_TYPE: usize = 5;

// Palette aliases sourced from the shared theme module.
const ACCENT: Color = crate::tui::theme::DISPLAY_ACCENT_CROSSTERM;
const MUTED: Color = crate::tui::theme::DISPLAY_MUTED_CROSSTERM;

// ─── Main TUI loop ───────────────────────────────────────────────────────────

fn cron_tui(mut tasks: Vec<TaskEntry>) -> Result<()> {
    // Hold the RawMode guard in an `Option` so we can drop it during the
    // sub-prompts (which need cooked mode) and re-enter on return without
    // running into the move-out-of-loop issue.
    let mut guard: Option<RawMode> = Some(RawMode::enter()?);
    let mut selected: usize = 0;
    let mut prev_height: u16 = 0;
    let mut stdout = io::stdout();

    loop {
        // Clamp selection.
        if !tasks.is_empty() && selected >= tasks.len() {
            selected = tasks.len() - 1;
        }

        prev_height = render(&mut stdout, &tasks, selected, prev_height)?;

        let ev = match event::read() {
            Ok(Event::Key(k)) => k,
            Ok(_) => continue,
            Err(e) => return Err(e.into()),
        };
        let input = TuiInput::from_key_event(ev);

        match input {
            TuiInput::Quit => {
                clear_frame(&mut stdout, prev_height)?;
                break;
            }
            TuiInput::Up => {
                selected = selected.saturating_sub(1);
            }
            TuiInput::Down => {
                if !tasks.is_empty() && selected < tasks.len() - 1 {
                    selected += 1;
                }
            }
            TuiInput::Delete => {
                if !tasks.is_empty() {
                    let entry = &tasks[selected];
                    let d_tag = entry.d_tag.clone();
                    let task_id = entry.task.id.clone();

                    // Drop the guard to restore cooked mode for confirmation.
                    clear_frame(&mut stdout, prev_height)?;
                    guard.take();

                    let confirmed = confirm_delete(&entry.task)?;
                    if confirmed {
                        remove_task_from_project(&d_tag, &task_id)?;
                        tasks.remove(selected);
                        if selected > 0 && selected >= tasks.len() {
                            selected -= 1;
                        }
                    }
                    // Re-enter raw mode.
                    guard = Some(RawMode::enter()?);
                    prev_height = 0;
                }
            }
            TuiInput::Add => {
                clear_frame(&mut stdout, prev_height)?;
                guard.take();

                if let Some(new_entry) = prompt_add_task()? {
                    let d_tag = new_entry.d_tag.clone();
                    let task = new_entry.task.clone();
                    add_task_to_project(&d_tag, task)?;
                    tasks.push(new_entry);
                    selected = tasks.len() - 1;
                }
                guard = Some(RawMode::enter()?);
                prev_height = 0;
            }
            TuiInput::RunNow => {
                if !tasks.is_empty() {
                    let entry = &tasks[selected];
                    let d_tag = entry.d_tag.clone();
                    let task = entry.task.clone();

                    clear_frame(&mut stdout, prev_height)?;
                    guard.take();

                    // Create a one-off copy with executeAt = now.
                    let now_iso = Utc::now().to_rfc3339();
                    let oneoff = ScheduledTask {
                        id: Uuid::new_v4().to_string(),
                        title: task.title.clone().map(|t| format!("{t} (manual)")),
                        schedule: now_iso.clone(),
                        prompt: task.prompt.clone(),
                        last_run: None,
                        next_run: None,
                        created_at: Some(Utc::now().to_rfc3339()),
                        from_pubkey: task.from_pubkey.clone(),
                        target_agent_slug: task.target_agent_slug.clone(),
                        project_id: task.project_id.clone(),
                        project_ref: task.project_ref.clone(),
                        task_type: Some(TaskType::Oneoff),
                        execute_at: Some(now_iso),
                        target_channel: task.target_channel.clone(),
                    };
                    add_task_to_project(&d_tag, oneoff.clone())?;
                    let msg = format!(
                        "Queued one-off run of '{}' — the scheduler will fire it momentarily.",
                        task.title.as_deref().unwrap_or(&task.id)
                    );
                    println!("{}", theme::display_accent().apply_to(msg));

                    guard = Some(RawMode::enter()?);
                    prev_height = 0;
                }
            }
            TuiInput::Other => {}
        }
    }

    Ok(())
}

// ─── Frame rendering ─────────────────────────────────────────────────────────

fn render<W: Write>(
    out: &mut W,
    tasks: &[TaskEntry],
    selected: usize,
    prev_height: u16,
) -> io::Result<u16> {
    clear_frame(out, prev_height)?;
    queue!(out, MoveToColumn(0))?;

    let mut height: u16 = 0;

    // Header.
    queue!(
        out,
        SetForegroundColor(ACCENT),
        SetAttribute(Attribute::Bold),
        Print(" TENEX Scheduled Tasks"),
        SetAttribute(Attribute::NormalIntensity),
        ResetColor,
        Print("\r\n"),
    )?;
    height += 1;

    // Column headers.
    queue!(out, SetForegroundColor(MUTED), SetAttribute(Attribute::Dim))?;
    queue!(
        out,
        Print(format!(
            " {:<project$}  {:<title$}  {:<sched$}  {:<type_$}  AGENT\r\n",
            "PROJECT",
            "TITLE",
            "SCHEDULE",
            "TYPE",
            project = COL_PROJECT,
            title = COL_TITLE,
            sched = COL_SCHEDULE,
            type_ = COL_TYPE,
        ))
    )?;
    queue!(out, SetAttribute(Attribute::NormalIntensity), ResetColor)?;
    height += 1;

    // Separator.
    let rule = "─".repeat(COL_PROJECT + COL_TITLE + COL_SCHEDULE + COL_TYPE + 14 + 8);
    queue!(
        out,
        SetForegroundColor(MUTED),
        Print(format!(" {rule}\r\n")),
        ResetColor,
    )?;
    height += 1;

    if tasks.is_empty() {
        queue!(
            out,
            SetAttribute(Attribute::Dim),
            Print(" No scheduled tasks. Press 'a' to add one.\r\n"),
            SetAttribute(Attribute::NormalIntensity),
        )?;
        height += 1;
    } else {
        for (i, entry) in tasks.iter().enumerate() {
            let is_active = i == selected;
            let cursor = if is_active { glyphs::CURSOR_THIN } else { " " };

            let d_tag = truncate(&entry.d_tag, COL_PROJECT);
            let title = truncate(entry.task.title.as_deref().unwrap_or("—"), COL_TITLE);
            let schedule = truncate(entry.task.display_schedule(), COL_SCHEDULE);
            let type_label = entry.task.type_label();
            let agent = truncate(&entry.task.target_agent_slug, 16);

            let line = format!(
                "{cursor} {d_tag:<project$}  {title:<title_w$}  {schedule:<sched$}  {type_label:<type_$}  {agent}",
                project = COL_PROJECT,
                title_w = COL_TITLE,
                sched = COL_SCHEDULE,
                type_ = COL_TYPE,
            );

            if is_active {
                queue!(
                    out,
                    SetForegroundColor(ACCENT),
                    Print(&line),
                    ResetColor,
                    Print("\r\n"),
                )?;
            } else {
                queue!(out, Print(&line), Print("\r\n"))?;
            }
            height += 1;
        }
    }

    // Footer separator.
    queue!(
        out,
        SetForegroundColor(MUTED),
        Print(format!(" {rule}\r\n")),
        ResetColor,
    )?;
    height += 1;

    // Status bar.
    let count = tasks.len();
    let projects: std::collections::HashSet<&str> =
        tasks.iter().map(|e| e.d_tag.as_str()).collect();
    let summary = if count == 1 {
        " 1 task in 1 project".to_string()
    } else {
        format!(" {count} tasks across {} projects", projects.len())
    };

    queue!(
        out,
        SetAttribute(Attribute::Dim),
        Print(summary),
        SetAttribute(Attribute::NormalIntensity),
        Print("\r\n"),
    )?;
    height += 1;

    // Key hints.
    queue!(
        out,
        SetAttribute(Attribute::Dim),
        Print(" ↑↓/jk navigate  a add  d delete  r run now  q quit"),
        SetAttribute(Attribute::NormalIntensity),
        Print("\r\n"),
    )?;
    height += 1;

    out.flush()?;
    Ok(height)
}

fn clear_frame<W: Write>(out: &mut W, height: u16) -> io::Result<()> {
    if height == 0 {
        return Ok(());
    }
    if height > 1 {
        out.queue(MoveUp(height - 1))?;
    }
    out.queue(MoveToColumn(0))?;
    out.queue(Clear(ClearType::FromCursorDown))?;
    out.flush()
}

fn truncate(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        s.to_string()
    } else {
        format!("{}…", chars[..max - 1].iter().collect::<String>())
    }
}

// ─── Interactive sub-flows ───────────────────────────────────────────────────

fn confirm_delete(task: &ScheduledTask) -> Result<bool> {
    let label = task.title.as_deref().unwrap_or(&task.id);
    match prompts::confirm(&format!("Delete task '{label}'?"))
        .with_default(false)
        .prompt()
    {
        Ok(b) => Ok(b),
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => Ok(false),
        Err(e) => Err(anyhow!("confirm prompt: {e}")),
    }
}

fn prompt_add_task() -> Result<Option<TaskEntry>> {
    println!();
    let accent = theme::display_accent();
    println!(
        "  {}  {}",
        accent.apply_to("Add scheduled task"),
        accent.apply_to("─────────────")
    );
    println!();

    // Project dTag.
    let d_tag = match prompts::input("Project dTag:")
        .with_help_message("The project directory name under ~/.tenex/projects/")
        .prompt()
    {
        Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
        Ok(_) => return Ok(None),
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
        Err(e) => return Err(anyhow!("project prompt: {e}")),
    };

    // Type.
    let type_choice = match inquire::Select::new("Task type:", vec!["cron", "once"]).prompt() {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
        Err(e) => return Err(anyhow!("type prompt: {e}")),
    };

    let is_oneoff = type_choice == "once";

    // Schedule or execute-at.
    let (schedule_str, execute_at) = if is_oneoff {
        let s = match prompts::input("Execute at (ISO 8601):")
            .with_placeholder("2026-05-01T09:00:00Z")
            .prompt()
        {
            Ok(s) => s.trim().to_string(),
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
            Err(e) => return Err(anyhow!("execute-at prompt: {e}")),
        };
        (s.clone(), Some(s))
    } else {
        let s = match prompts::input("Cron expression:")
            .with_placeholder("0 9 * * mon-fri")
            .with_help_message("5-field cron: min hour dom month dow")
            .prompt()
        {
            Ok(s) => s.trim().to_string(),
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
            Err(e) => return Err(anyhow!("cron prompt: {e}")),
        };
        (s, None)
    };

    // Prompt text.
    let prompt_text = match prompts::input("Prompt:")
        .with_help_message("The message content sent to the agent")
        .prompt()
    {
        Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
        Ok(_) => return Ok(None),
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
        Err(e) => return Err(anyhow!("prompt text prompt: {e}")),
    };

    // Target agent slug.
    let target = match prompts::input("Target agent slug:").prompt() {
        Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
        Ok(_) => return Ok(None),
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
        Err(e) => return Err(anyhow!("target prompt: {e}")),
    };

    // Optional title.
    let title = match prompts::input("Title (optional):").prompt() {
        Ok(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Ok(_) => None,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(None),
        Err(e) => return Err(anyhow!("title prompt: {e}")),
    };

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let task = ScheduledTask {
        id,
        title,
        schedule: schedule_str,
        prompt: prompt_text,
        last_run: None,
        next_run: None,
        created_at: Some(now),
        from_pubkey: None,
        target_agent_slug: target,
        project_id: d_tag.clone(),
        project_ref: None,
        task_type: if is_oneoff {
            Some(TaskType::Oneoff)
        } else {
            Some(TaskType::Cron)
        },
        execute_at,
        target_channel: None,
    };

    Ok(Some(TaskEntry { d_tag, task }))
}
