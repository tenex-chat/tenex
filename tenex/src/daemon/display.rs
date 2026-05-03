use std::io::IsTerminal;
use std::sync::OnceLock;

static IS_TTY: OnceLock<bool> = OnceLock::new();

fn tty() -> bool {
    *IS_TTY.get_or_init(|| std::io::stdout().is_terminal())
}

fn green() -> &'static str {
    if tty() { "\x1b[32m" } else { "" }
}
fn red() -> &'static str {
    if tty() { "\x1b[31m" } else { "" }
}
fn cyan() -> &'static str {
    if tty() { "\x1b[36m" } else { "" }
}
fn dim() -> &'static str {
    if tty() { "\x1b[2m" } else { "" }
}
fn bold() -> &'static str {
    if tty() { "\x1b[1m" } else { "" }
}
fn reset() -> &'static str {
    if tty() { "\x1b[0m" } else { "" }
}

fn strip_prefix(key: &str) -> &str {
    key.strip_prefix("tenex-").unwrap_or(key)
}

pub fn header(base_dir: &std::path::Path, relay_count: usize) {
    println!();
    println!(
        "{bold}TENEX{reset}  {dim}{base}  {count} relay{s}{reset}",
        bold = bold(),
        dim = dim(),
        reset = reset(),
        base = base_dir.display(),
        count = relay_count,
        s = if relay_count == 1 { "" } else { "s" },
    );
    println!();
}

pub fn service_ready(name: &str) {
    println!(
        "  {green}✓{reset}  {name}",
        green = green(),
        reset = reset(),
    );
}

pub fn service_started(key: &str) {
    println!(
        "  {green}●{reset}  {name}",
        green = green(),
        reset = reset(),
        name = strip_prefix(key),
    );
}

pub fn service_exited_cleanly(key: &str) {
    println!(
        "  {dim}○  {name}{reset}",
        dim = dim(),
        reset = reset(),
        name = strip_prefix(key),
    );
}

pub fn service_crashed(key: &str, code: Option<i32>) {
    let code_str = code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "?".to_string());
    println!(
        "  {red}✗  {name}  exited (code {code_str}){reset}",
        red = red(),
        reset = reset(),
        name = strip_prefix(key),
    );
}

pub fn watching(relay_count: usize) {
    println!();
    println!(
        "{green}●{reset}  watching Nostr ({count} relay{s})",
        green = green(),
        reset = reset(),
        count = relay_count,
        s = if relay_count == 1 { "" } else { "s" },
    );
}

pub fn project_booted(d_tag: &str) {
    println!(
        "  {cyan}▶{reset}  {d_tag}",
        cyan = cyan(),
        reset = reset(),
    );
}
