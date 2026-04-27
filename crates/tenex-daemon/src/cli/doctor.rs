use std::path::Path;

use super::agent_store;

pub struct DoctorOptions {
    pub subcommand: Option<String>,
    pub sub_args: Vec<String>,
}

pub fn run_doctor(options: DoctorOptions, base_dir: &Path) -> anyhow::Result<()> {
    match options.subcommand.as_deref() {
        Some("agents") => run_doctor_agents(&options.sub_args, base_dir),
        None | Some("--help") | Some("-h") => {
            eprintln!("{DOCTOR_USAGE}");
            Ok(())
        }
        Some(other) => {
            eprintln!("Unknown doctor subcommand: {other}");
            eprintln!("{DOCTOR_USAGE}");
            std::process::exit(2);
        }
    }
}

const DOCTOR_USAGE: &str = "\
Usage: tenex doctor <subcommand>

Subcommands:
  agents    Agent diagnostics and repair

Run 'tenex doctor agents --help' for agent subcommands.";

fn run_doctor_agents(args: &[String], base_dir: &Path) -> anyhow::Result<()> {
    let agents_dir = base_dir.join("agents");
    match args.first().map(|s| s.as_str()) {
        Some("orphans") => {
            let purge = args.contains(&"--purge".to_string());
            run_orphans(&agents_dir, purge)
        }
        Some("duplicates") => {
            let merge = args.contains(&"--merge".to_string());
            run_duplicates(&agents_dir, merge)
        }
        None | Some("--help") | Some("-h") => {
            eprintln!("{DOCTOR_AGENTS_USAGE}");
            Ok(())
        }
        Some(other) => {
            eprintln!("Unknown doctor agents subcommand: {other}");
            eprintln!("{DOCTOR_AGENTS_USAGE}");
            std::process::exit(2);
        }
    }
}

const DOCTOR_AGENTS_USAGE: &str = "\
Usage: tenex doctor agents <subcommand>

Subcommands:
  orphans [--purge]      List agents not assigned to any project; --purge to delete them
  duplicates [--merge]   Find agents sharing a slug; --merge to auto-resolve";

fn run_orphans(agents_dir: &Path, purge: bool) -> anyhow::Result<()> {
    let agents = agent_store::load_agents(agents_dir)?;
    let orphans: Vec<&agent_store::AgentEntry> =
        agents.iter().filter(|a| a.projects.is_empty()).collect();

    if orphans.is_empty() {
        println!("No orphaned agents found.");
        return Ok(());
    }

    println!("Found {} orphaned agent(s) (no project assignments):", orphans.len());
    for agent in &orphans {
        let source = agent
            .doc
            .get("eventId")
            .and_then(|v| v.as_str())
            .map(|id| format!("nostr:{}", &id[..id.len().min(12)]))
            .unwrap_or_else(|| "local".to_string());
        let status = agent.status.as_deref().unwrap_or("active");
        println!(
            "  {}  ({})  [{}]  status={}",
            agent.slug,
            &agent.pubkey[..agent.pubkey.len().min(8)],
            source,
            status
        );
    }

    if !purge {
        println!("\nRun with --purge to permanently delete them.");
        return Ok(());
    }

    println!("\nDeleting {} orphaned agent(s)...", orphans.len());
    for agent in &orphans {
        match agent_store::delete_agent(agents_dir, agent) {
            Ok(()) => println!("  ✓ deleted {}", agent.slug),
            Err(e) => eprintln!("  ✗ failed to delete {}: {e}", agent.slug),
        }
    }

    Ok(())
}

fn run_duplicates(agents_dir: &Path, merge: bool) -> anyhow::Result<()> {
    let agents = agent_store::load_agents(agents_dir)?;
    let dup_groups = agent_store::find_duplicate_slug_groups(&agents);

    if dup_groups.is_empty() {
        println!("No duplicate slugs found.");
        return Ok(());
    }

    println!("Found {} duplicate slug group(s):", dup_groups.len());
    for group in &dup_groups {
        let slug = &agents[group[0]].slug;
        println!("  {slug}:");
        for &i in group {
            let a = &agents[i];
            let projects = if a.projects.is_empty() {
                "(no projects)".to_string()
            } else {
                a.projects.join(", ")
            };
            let status = a.status.as_deref().unwrap_or("active");
            println!(
                "    {} ({})  {}  status={}",
                a.name,
                &a.pubkey[..a.pubkey.len().min(8)],
                projects,
                status
            );
        }
    }

    if !merge {
        println!("\nRun with --merge to auto-resolve (keeps the most-active copy).");
        return Ok(());
    }

    println!("\nMerging {} group(s)...", dup_groups.len());
    for group in &dup_groups {
        let survivor_idx = agent_store::pick_survivor(group, &agents);
        let slug = &agents[group[0]].slug;
        match agent_store::merge_agents(agents_dir, group, &agents) {
            Ok(()) => println!("  ✓ merged '{slug}' → kept '{}'", agents[survivor_idx].name),
            Err(e) => eprintln!("  ✗ merge failed for '{slug}': {e}"),
        }
    }

    Ok(())
}
