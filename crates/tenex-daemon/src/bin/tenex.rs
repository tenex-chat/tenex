use std::env;
use std::path::PathBuf;
use std::process;

use tenex_daemon::cli::config_tui::{ConfigTuiOptions, run_config};
use tenex_daemon::cli::onboard::{OnboardOptions, run_onboard};

const USAGE: &str = "\
Usage: tenex <command> [options]

Commands:
  onboard     Initial setup wizard
  config      Configure TENEX settings

Run 'tenex <command> --help' for command-specific options.
";

const ONBOARD_USAGE: &str = "\
Usage: tenex onboard [options]

Options:
  --pubkey <hex|npub|nprofile>  Pubkey(s) to whitelist (can be repeated)
  --local-relay-url <url>       Offer a local relay as the first option
  --json                        Output configuration as JSON
  --help                        Show this help
";

const CONFIG_USAGE: &str = "\
Usage: tenex config [subcommand]

Subcommands:
  providers      Manage API keys and provider connections
  llm            Manage LLM model configurations
  roles          Assign which model handles each task
  relays         Manage Nostr relay connections
  identity       Manage authorized pubkeys
  summarization  Set auto-summary inactivity timeout
  logging        Set log level and file path
  paths          Show and edit file storage paths

Run without a subcommand to open the interactive settings menu.
";

fn get_tenex_base_dir() -> PathBuf {
    if let Ok(base) = env::var("TENEX_BASE_DIR") {
        return PathBuf::from(base);
    }
    let home = env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".tenex")
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprint!("{USAGE}");
        process::exit(2);
    }

    match args[1].as_str() {
        "onboard" => {
            let opts = parse_onboard_args(&args[2..]);
            let base_dir = get_tenex_base_dir();
            if let Err(e) = std::fs::create_dir_all(&base_dir) {
                eprintln!(
                    "Error: cannot create config directory {}: {e}",
                    base_dir.display()
                );
                process::exit(1);
            }
            if let Err(e) = run_onboard(opts, &base_dir) {
                let msg = e.to_string();
                if msg.contains("SIGINT")
                    || msg.contains("force closed")
                    || msg.contains("interrupted")
                {
                    process::exit(0);
                }
                eprintln!("Setup failed: {e}");
                process::exit(1);
            }
        }
        "config" => {
            let (opts, show_help) = parse_config_args(&args[2..]);
            if show_help {
                print!("{CONFIG_USAGE}");
                return;
            }
            let base_dir = get_tenex_base_dir();
            if let Err(e) = std::fs::create_dir_all(&base_dir) {
                eprintln!(
                    "Error: cannot create config directory {}: {e}",
                    base_dir.display()
                );
                process::exit(1);
            }
            if let Err(e) = run_config(opts, &base_dir) {
                let msg = e.to_string();
                if msg.contains("SIGINT")
                    || msg.contains("force closed")
                    || msg.contains("interrupted")
                {
                    process::exit(0);
                }
                eprintln!("Config error: {e}");
                process::exit(1);
            }
        }
        "--help" | "-h" | "help" => {
            print!("{USAGE}");
        }
        other => {
            eprintln!("Unknown command: {other}");
            eprint!("{USAGE}");
            process::exit(2);
        }
    }
}

fn parse_onboard_args(args: &[String]) -> OnboardOptions {
    let mut pubkeys = Vec::new();
    let mut local_relay_url = None;
    let mut json = false;
    let mut i = 0;

    while i < args.len() {
        match args[i].as_str() {
            "--pubkey" => {
                i += 1;
                while i < args.len() && !args[i].starts_with("--") {
                    pubkeys.push(args[i].clone());
                    i += 1;
                }
                continue;
            }
            "--local-relay-url" => {
                i += 1;
                if i < args.len() {
                    local_relay_url = Some(args[i].clone());
                }
            }
            "--json" => {
                json = true;
            }
            "--help" | "-h" => {
                print!("{ONBOARD_USAGE}");
                process::exit(0);
            }
            other => {
                eprintln!("Unknown option: {other}");
                eprint!("{ONBOARD_USAGE}");
                process::exit(2);
            }
        }
        i += 1;
    }

    OnboardOptions {
        pubkeys,
        local_relay_url,
        json,
    }
}

fn parse_config_args(args: &[String]) -> (ConfigTuiOptions, bool) {
    if args.is_empty() {
        return (ConfigTuiOptions { subcommand: None }, false);
    }

    match args[0].as_str() {
        "--help" | "-h" => (ConfigTuiOptions { subcommand: None }, true),
        sub => (
            ConfigTuiOptions {
                subcommand: Some(sub.to_string()),
            },
            false,
        ),
    }
}
