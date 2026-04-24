use std::path::Path;

use time::OffsetDateTime;
use time::macros::format_description;

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const RED: &str = "\x1b[31m";

static PALETTE: &[&str] = &[
    "\x1b[36m", // cyan
    "\x1b[35m", // magenta
    "\x1b[34m", // blue
    "\x1b[96m", // bright cyan
    "\x1b[95m", // bright magenta
    "\x1b[94m", // bright blue
    "\x1b[93m", // bright yellow
    "\x1b[92m", // bright green
];

fn color_for(key: &str) -> &'static str {
    let hash = key
        .bytes()
        .fold(0u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64));
    PALETTE[(hash as usize) % PALETTE.len()]
}

fn timestamp() -> String {
    let fmt = format_description!("[hour]:[minute]:[second]");
    OffsetDateTime::now_utc()
        .format(fmt)
        .unwrap_or_else(|_| "??:??:??".to_string())
}

fn agent_label(tenex_base_dir: Option<&Path>, agent_pubkey: &str) -> String {
    tenex_base_dir
        .and_then(|dir| read_agent_slug(dir, agent_pubkey))
        .unwrap_or_else(|| format!("{}…", &agent_pubkey[..agent_pubkey.len().min(8)]))
}

fn read_agent_slug(tenex_base_dir: &Path, agent_pubkey: &str) -> Option<String> {
    let path = tenex_base_dir
        .join("agents")
        .join(format!("{agent_pubkey}.json"));
    let content = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    value.get("slug")?.as_str().map(str::to_string)
}

pub fn print_daemon_ready(
    nostr_enabled: bool,
    telegram_enabled: bool,
    max_concurrent_workers: Option<u64>,
) {
    let nostr = if nostr_enabled { "nostr on" } else { "nostr off" };
    let telegram = if telegram_enabled {
        "telegram on"
    } else {
        "telegram off"
    };
    let workers = match max_concurrent_workers {
        Some(n) => format!("max {n} workers"),
        None => "unbounded workers".to_string(),
    };
    println!(
        "{DIM}{}{RESET}  {BOLD}{GREEN}✓{RESET}  {BOLD}{GREEN}daemon ready{RESET}  {DIM}({nostr}, {telegram}, {workers}){RESET}",
        timestamp()
    );
}

pub fn print_project_booted(project_d_tag: &str, total_count: usize, already_booted: bool) {
    let marker = if already_booted { "↻" } else { "↑" };
    let project_color = color_for(project_d_tag);
    println!(
        "{DIM}{}{RESET}  {marker}  {BOLD}{project_color}{project_d_tag}{RESET}  {DIM}({total_count} booted){RESET}",
        timestamp()
    );
}

pub fn print_agent_started(
    project_id: &str,
    agent_pubkey: &str,
    worker_id: &str,
    tenex_base_dir: Option<&Path>,
) {
    let label = agent_label(tenex_base_dir, agent_pubkey);
    let agent_color = color_for(agent_pubkey);
    let project_color = color_for(project_id);
    println!(
        "{DIM}{}{RESET}  {BOLD}{YELLOW}●{RESET}  {BOLD}{agent_color}{label}{RESET}  {DIM}{worker_id}{RESET}  {BOLD}{project_color}{project_id}{RESET}",
        timestamp()
    );
}

pub fn print_agent_stopped(
    project_id: &str,
    agent_pubkey: &str,
    worker_id: &str,
    tenex_base_dir: Option<&Path>,
) {
    let label = agent_label(tenex_base_dir, agent_pubkey);
    let agent_color = color_for(agent_pubkey);
    let project_color = color_for(project_id);
    println!(
        "{DIM}{}{RESET}  {BOLD}{GREEN}✓{RESET}  {BOLD}{agent_color}{label}{RESET}  {DIM}{worker_id}{RESET}  {BOLD}{project_color}{project_id}{RESET}",
        timestamp()
    );
}

pub fn print_daemon_tick_failure(iteration: u64, error: &dyn std::error::Error) {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(" ← ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    println!(
        "{DIM}{}{RESET}  {BOLD}{RED}✖{RESET}  {BOLD}{RED}daemon tick #{iteration} failed{RESET}  {message}",
        timestamp()
    );
}

pub fn print_publish_outbox_permanent_failure(event_id: &str, request_id: &str) {
    println!(
        "{DIM}{}{RESET}  {BOLD}{RED}✖{RESET}  {BOLD}{RED}publish rejected by all relays (permanent){RESET}  event {DIM}{event_id}{RESET} request {DIM}{request_id}{RESET}",
        timestamp()
    );
}

pub fn print_publish_outbox_quarantined(source_path: &Path, target_path: &Path) {
    println!(
        "{DIM}{}{RESET}  {BOLD}{RED}✖{RESET}  {BOLD}{RED}publish outbox record quarantined (permanent loss){RESET}  {DIM}{} → {}{RESET}",
        timestamp(),
        source_path.display(),
        target_path.display()
    );
}

pub fn print_stale_injection_skipped(worker_id: &str, injection_id: &str) {
    println!(
        "{DIM}{}{RESET}  {BOLD}{YELLOW}⚠{RESET}  {BOLD}{YELLOW}injection dropped (stale lease){RESET}  worker {DIM}{worker_id}{RESET} injection {DIM}{injection_id}{RESET}",
        timestamp()
    );
}

pub fn print_agent_installed(slug: &str, agent_pubkey: &str, already_installed: bool) {
    let marker = if already_installed { "↻" } else { "+" };
    let agent_color = color_for(agent_pubkey);
    let short_pubkey = &agent_pubkey[..agent_pubkey.len().min(8)];
    println!(
        "{DIM}{}{RESET}  {marker}  {BOLD}{agent_color}{slug}{RESET}  {DIM}{short_pubkey}…{RESET}",
        timestamp()
    );
}

pub fn print_sighup_reload_failed(error: &dyn std::error::Error) {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(" ← ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    println!(
        "{DIM}{}{RESET}  {BOLD}{RED}✖{RESET}  {BOLD}{RED}SIGHUP reload failed (stale config){RESET}  {message}",
        timestamp()
    );
}
