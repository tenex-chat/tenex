use std::collections::HashSet;
use std::io::{self, Write};
use std::path::Path;

use crossterm::{
    cursor::{Hide, MoveUp, Show},
    event::{self, Event, KeyCode},
    execute, queue,
    style::{Color, Print, ResetColor, SetForegroundColor},
    terminal::{self, Clear, ClearType, disable_raw_mode, enable_raw_mode},
};
use dialoguer::{Confirm, theme::ColorfulTheme};

use super::agent_store::{self, AgentEntry};
use super::display;

struct AgentList {
    agents: Vec<AgentEntry>,
    cursor: usize,
    selected: HashSet<usize>,
    visible_rows: usize,
}

impl AgentList {
    fn new(agents: Vec<AgentEntry>) -> Self {
        let visible_rows = terminal::size()
            .map(|(_, h)| (h as usize / 2).max(8))
            .unwrap_or(12);
        Self { agents, cursor: 0, selected: HashSet::new(), visible_rows }
    }

    fn scroll_offset(&self) -> usize {
        if self.agents.len() <= self.visible_rows {
            return 0;
        }
        let half = self.visible_rows / 2;
        let max_start = self.agents.len() - self.visible_rows;
        self.cursor.saturating_sub(half).min(max_start)
    }

    fn move_up(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
        }
    }

    fn move_down(&mut self) {
        if self.cursor + 1 < self.agents.len() {
            self.cursor += 1;
        }
    }

    fn toggle_selected(&mut self) {
        if !self.selected.remove(&self.cursor) {
            self.selected.insert(self.cursor);
        }
    }

    fn reload(&mut self, agents_dir: &Path) -> anyhow::Result<()> {
        self.agents = agent_store::load_agents(agents_dir)?;
        self.selected.clear();
        self.cursor = self.cursor.min(self.agents.len().saturating_sub(1));
        Ok(())
    }
}

fn render(list: &AgentList) -> anyhow::Result<usize> {
    let mut out = io::stdout();
    let mut lines = 0;

    let selected_info = if list.selected.is_empty() {
        String::new()
    } else {
        format!("  [{} selected]", list.selected.len())
    };

    queue!(
        out,
        SetForegroundColor(Color::DarkGrey),
        Print(format!("  Agents ({}){}\r\n", list.agents.len(), selected_info)),
        Print("  ↑↓ navigate  ·  space select  ·  x delete  ·  m merge  ·  esc quit\r\n"),
        Print("  ──────────────────────────────────────────────────────────\r\n"),
        ResetColor,
    )?;
    lines += 3;

    let offset = list.scroll_offset();
    let end = (offset + list.visible_rows).min(list.agents.len());

    if offset > 0 {
        queue!(
            out,
            SetForegroundColor(Color::DarkGrey),
            Print(format!("  ↑ {} more\r\n", offset)),
            ResetColor,
        )?;
        lines += 1;
    }

    for (i, agent) in list.agents[offset..end].iter().enumerate() {
        let idx = offset + i;
        let is_cursor = idx == list.cursor;
        let is_selected = list.selected.contains(&idx);

        let pfx = if is_cursor { ">" } else { " " };
        let check = if is_selected { "[x]" } else { "[ ]" };
        let projects = match agent.projects.len() {
            0 => "no projects".to_string(),
            1 => "1 project".to_string(),
            n => format!("{n} projects"),
        };
        let inactive = if !agent.is_active() { "  [inactive]" } else { "" };
        let line = format!("  {pfx} {check} {:<34} {}{}\r\n", agent.name, projects, inactive);

        if is_cursor {
            queue!(out, SetForegroundColor(Color::Yellow), Print(line), ResetColor)?;
        } else if is_selected {
            queue!(out, SetForegroundColor(Color::Green), Print(line), ResetColor)?;
        } else {
            queue!(out, Print(line))?;
        }
        lines += 1;
    }

    if end < list.agents.len() {
        queue!(
            out,
            SetForegroundColor(Color::DarkGrey),
            Print(format!("  ↓ {} more\r\n", list.agents.len() - end)),
            ResetColor,
        )?;
        lines += 1;
    }

    out.flush()?;
    Ok(lines)
}

fn erase(lines: usize) -> anyhow::Result<()> {
    if lines == 0 {
        return Ok(());
    }
    let mut out = io::stdout();
    queue!(out, MoveUp(lines as u16), Clear(ClearType::FromCursorDown))?;
    out.flush()?;
    Ok(())
}

fn suspend_raw<F>(rendered_lines: &mut usize, f: F) -> anyhow::Result<()>
where
    F: FnOnce() -> anyhow::Result<()>,
{
    erase(*rendered_lines)?;
    *rendered_lines = 0;
    execute!(io::stdout(), Show)?;
    disable_raw_mode()?;
    let result = f();
    enable_raw_mode()?;
    execute!(io::stdout(), Hide)?;
    result
}

pub fn run_agent_manager(theme: &ColorfulTheme, base_dir: &Path) -> anyhow::Result<()> {
    let agents_dir = base_dir.join("agents");
    let mut agents = agent_store::load_agents(&agents_dir)?;

    if agents.is_empty() {
        display::blank();
        display::hint("No agents found.");
        return Ok(());
    }

    agents = offer_auto_merge(theme, &agents_dir, agents)?;

    let mut list = AgentList::new(agents);
    let mut rendered_lines: usize = 0;

    enable_raw_mode()?;
    execute!(io::stdout(), Hide)?;

    let result = (|| -> anyhow::Result<()> {
        loop {
            if list.agents.is_empty() {
                break;
            }

            erase(rendered_lines)?;
            rendered_lines = render(&list)?;

            let Event::Key(key) = event::read()? else { continue };

            match key.code {
                KeyCode::Esc | KeyCode::Char('q') => break,
                KeyCode::Up => list.move_up(),
                KeyCode::Down => list.move_down(),
                KeyCode::Char(' ') => list.toggle_selected(),

                KeyCode::Char('x') => {
                    let targets: Vec<usize> = if list.selected.is_empty() {
                        vec![list.cursor]
                    } else {
                        let mut v: Vec<usize> = list.selected.iter().copied().collect();
                        v.sort_unstable();
                        v
                    };
                    let names: Vec<String> =
                        targets.iter().map(|&i| list.agents[i].name.clone()).collect();

                    suspend_raw(&mut rendered_lines, || {
                        let confirmed = Confirm::with_theme(theme)
                            .with_prompt(format!("Permanently delete {}?", names.join(", ")))
                            .default(false)
                            .interact()?;

                        if confirmed {
                            for &i in targets.iter().rev() {
                                match agent_store::delete_agent(&agents_dir, &list.agents[i]) {
                                    Ok(()) => display::success(&format!("Deleted {}", list.agents[i].name)),
                                    Err(e) => display::error(&format!("Failed: {e}")),
                                }
                            }
                        }
                        Ok(())
                    })?;

                    list.reload(&agents_dir)?;
                }

                KeyCode::Char('m') => {
                    let targets: Vec<usize> = {
                        let mut v: Vec<usize> = list.selected.iter().copied().collect();
                        v.sort_unstable();
                        v
                    };
                    if targets.len() < 2 {
                        continue;
                    }

                    let survivor_idx = agent_store::pick_survivor(&targets, &list.agents);
                    let survivor_name = list.agents[survivor_idx].name.clone();
                    let target_count = targets.len();

                    suspend_raw(&mut rendered_lines, || {
                        let confirmed = Confirm::with_theme(theme)
                            .with_prompt(format!(
                                "Merge {target_count} agents into '{survivor_name}'?"
                            ))
                            .default(true)
                            .interact()?;

                        if confirmed {
                            match agent_store::merge_agents(&agents_dir, &targets, &list.agents) {
                                Ok(()) => display::success(&format!("Merged into '{survivor_name}'")),
                                Err(e) => display::error(&format!("Merge failed: {e}")),
                            }
                        }
                        Ok(())
                    })?;

                    list.reload(&agents_dir)?;
                }

                _ => {}
            }
        }
        Ok(())
    })();

    erase(rendered_lines).ok();
    execute!(io::stdout(), Show).ok();
    disable_raw_mode().ok();

    result
}

fn offer_auto_merge(
    theme: &ColorfulTheme,
    agents_dir: &Path,
    agents: Vec<AgentEntry>,
) -> anyhow::Result<Vec<AgentEntry>> {
    let dup_groups = agent_store::find_duplicate_slug_groups(&agents);
    if dup_groups.is_empty() {
        return Ok(agents);
    }

    display::blank();
    display::context(&format!("Detected {} duplicate slug group(s):", dup_groups.len()));
    for group in &dup_groups {
        display::context(&format!("  {}  ({} copies)", agents[group[0]].slug, group.len()));
    }
    display::blank();

    let confirmed = Confirm::with_theme(theme)
        .with_prompt("Auto-merge duplicates now?")
        .default(true)
        .interact()?;

    if !confirmed {
        return Ok(agents);
    }

    for group in &dup_groups {
        let survivor_idx = agent_store::pick_survivor(group, &agents);
        let slug = &agents[group[0]].slug;
        match agent_store::merge_agents(agents_dir, group, &agents) {
            Ok(()) => display::success(&format!(
                "Merged '{slug}' → kept '{}'",
                agents[survivor_idx].name
            )),
            Err(e) => display::error(&format!("Merge failed for '{slug}': {e}")),
        }
    }

    agent_store::load_agents(agents_dir)
}
