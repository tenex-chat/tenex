use time::OffsetDateTime;
use time::macros::format_description;

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const CYAN: &str = "\x1b[36m";

fn timestamp() -> String {
    let fmt = format_description!("[hour]:[minute]:[second]");
    OffsetDateTime::now_utc()
        .format(fmt)
        .unwrap_or_else(|_| "??:??:??".to_string())
}

fn short_pubkey(pubkey: &str) -> &str {
    &pubkey[..pubkey.len().min(8)]
}

pub fn print_project_booted(project_d_tag: &str, total_count: usize, already_booted: bool) {
    let label = if already_booted { "↻ project" } else { "↑ project" };
    println!(
        "{DIM}{}{RESET}  {BOLD}{CYAN}{label}{RESET}  {BOLD}{project_d_tag}{RESET}  {DIM}({total_count} booted){RESET}",
        timestamp()
    );
}

pub fn print_agent_started(project_id: &str, agent_pubkey: &str, worker_id: &str) {
    println!(
        "{DIM}{}{RESET}  {BOLD}{YELLOW}→ agent  {RESET}  {BOLD}{}…{RESET}  {DIM}{worker_id}{RESET}  starting  {project_id}",
        timestamp(),
        short_pubkey(agent_pubkey)
    );
}

pub fn print_agent_stopped(project_id: &str, agent_pubkey: &str, worker_id: &str) {
    println!(
        "{DIM}{}{RESET}  {BOLD}{GREEN}✓ agent  {RESET}  {BOLD}{}…{RESET}  {DIM}{worker_id}{RESET}  done  {project_id}",
        timestamp(),
        short_pubkey(agent_pubkey)
    );
}
