//! Pure helpers for the interactive agent manager (`tenex agent manage`).
//!
//! Mirrors the standalone exports at the top of
//! `src/commands/agent/AgentManager.ts:178-244`:
//!
//! - [`ManagedAgent`]                   — `type ManagedAgent` (`:23-27`)
//! - [`compare_agents`]                 — `compareAgents` (`:178-186`)
//! - [`format_projects`]                — `formatProjects` (`:188-190`)
//! - [`format_managed_agent_label`]     — `formatManagedAgentLabel` (`:192-201`)
//!                                        (multi-line variant, currently unused
//!                                        by the live menu but exists for tests)
//! - [`format_managed_agent_list_line`] — `formatManagedAgentListLine` (`:203-207`)
//! - [`pick_merge_survivor`]            — `pickMergeSurvivor` (`:209-228`)
//! - [`find_duplicate_slug_groups`]     — `findDuplicateSlugGroups` (`:230-244`)
//!
//! Styling: TS uses `chalk.dim(...)`. We mirror it with `console::Style::new().dim()`,
//! which emits the same SGR `2;` "faint" sequence so the on-wire output is
//! pixel-identical.
//!
//! `localeCompare` against ASCII (the slug universe) collapses to byte
//! ordering — so we use `String::cmp`. If a future slug includes non-ASCII
//! characters and a divergence appears, this assumption needs revisiting.

use std::cmp::Ordering;

use anyhow::{anyhow, Result};
use indexmap::IndexMap;

use crate::store::agent_storage::{derive_agent_pubkey_from_nsec, AgentStorage};
use crate::store::project_members::{
    get_project_visibility, list_projects_for_agent, ProjectVisibility,
};

/// Mirror of `type ManagedAgent` (`AgentManager.ts:23-27`):
/// loaded stored-agent + derived pubkey + visible projects.
///
/// `name` is read from the stored-agent JSON's `name` field (the agent's
/// human-readable display name, distinct from `slug`). Defaults to the
/// empty string when missing — TS uses the same fallback through
/// `entry.storedAgent.name` since the underlying schema marks `name` as
/// always present (`storage.ts:35`).
#[derive(Clone, Debug)]
pub struct ManagedAgent {
    pub slug: String,
    pub name: String,
    /// `"active"`, `"inactive"`, or `None` (treated as active).
    pub status: Option<String>,
    pub role: String,
    pub pubkey: String,
    pub projects: Vec<String>,
}

impl ManagedAgent {
    pub fn is_inactive(&self) -> bool {
        self.status.as_deref() == Some("inactive")
    }
}

/// `compareAgents` (`AgentManager.ts:178-186`):
/// inactive sorts after active; otherwise alphabetically by slug.
pub fn compare_agents(a: &ManagedAgent, b: &ManagedAgent) -> Ordering {
    let a_inactive = a.is_inactive();
    let b_inactive = b.is_inactive();
    if a_inactive != b_inactive {
        return if a_inactive { Ordering::Greater } else { Ordering::Less };
    }
    a.slug.cmp(&b.slug)
}

/// `formatProjects` (`AgentManager.ts:188-190`):
/// `projects.join(", ")` or the literal `"none"` when empty.
pub fn format_projects(projects: &[String]) -> String {
    if projects.is_empty() {
        "none".to_owned()
    } else {
        projects.join(", ")
    }
}

/// `formatManagedAgentLabel` (`AgentManager.ts:192-201`).
///
/// Multi-line label: slug (with optional `[inactive]` dim suffix), then a
/// dim role line and a dim projects line. Currently unused by the live
/// menu — the shipped main view uses [`format_managed_agent_list_line`] —
/// but exists for tests and parity. Mirrored verbatim.
pub fn format_managed_agent_label(entry: &ManagedAgent) -> String {
    let dim = console::Style::new().dim();
    let inactive_tag = if entry.is_inactive() {
        dim.apply_to(" [inactive]").to_string()
    } else {
        String::new()
    };
    let role_line = dim.apply_to(format!("    role: {}", entry.role)).to_string();
    let projects_line = dim
        .apply_to(format!(
            "    projects: {}",
            format_projects(&entry.projects)
        ))
        .to_string();
    format!(
        "{slug}{inactive}\n{role}\n{projects}",
        slug = entry.slug,
        inactive = inactive_tag,
        role = role_line,
        projects = projects_line,
    )
}

/// `formatManagedAgentListLine` (`AgentManager.ts:207-208`):
///
///     const inactiveTag = storedAgent.status === "inactive"
///         ? chalk.dim("[inactive] ")
///         : "";
///     return `${inactiveTag}${storedAgent.slug} ${chalk.dim("·")} ${chalk.dim(`projects: ${formatProjects(projects)}`)}`;
///
/// `inactiveTag = chalk.dim("[inactive] ")` — TRAILING space inside
/// the dim wrap, no leading space. The TS template prepends the tag
/// with the trailing space providing the separator between `]` and
/// the slug. So an inactive agent renders as
/// `[inactive] <slug> · projects: <csv>`.
///
/// **Distinct from** the multi-line `formatManagedAgentLabel`
/// (`AgentManager.ts:196`): that helper uses LEADING-space tag
/// (`chalk.dim(" [inactive]")`) appended AFTER the slug to render
/// `<slug> [inactive]`. Both shapes coexist in TS — keep them
/// separate here too.
pub fn format_managed_agent_list_line(entry: &ManagedAgent) -> String {
    let dim = console::Style::new().dim();
    let inactive_tag = if entry.is_inactive() {
        dim.apply_to("[inactive] ").to_string()
    } else {
        String::new()
    };
    let middle_dot = dim.apply_to("·").to_string();
    let projects_chunk = dim
        .apply_to(format!("projects: {}", format_projects(&entry.projects)))
        .to_string();
    format!("{inactive_tag}{slug} {middle_dot} {projects_chunk}", slug = entry.slug)
}

/// `pickMergeSurvivor` (`AgentManager.ts:209-228`).
///
/// Sort key:
/// 1. **More projects first** — `b.projects.length - a.projects.length`
/// 2. **Active before inactive**
/// 3. **Slug ascending**
///
/// Returns the first element after that sort. Panics on empty input,
/// matching TS `throw new Error("pickMergeSurvivor requires at least one agent")`.
pub fn pick_merge_survivor(agents: &[ManagedAgent]) -> &ManagedAgent {
    assert!(
        !agents.is_empty(),
        "pickMergeSurvivor requires at least one agent"
    );
    agents
        .iter()
        .min_by(|a, b| {
            // Reverse on project count: higher count = "less" in the sort.
            match b.projects.len().cmp(&a.projects.len()) {
                Ordering::Equal => match (a.is_inactive(), b.is_inactive()) {
                    (true, false) => Ordering::Greater,
                    (false, true) => Ordering::Less,
                    _ => a.slug.cmp(&b.slug),
                },
                other => other,
            }
        })
        .expect("non-empty checked above")
}

/// `findDuplicateSlugGroups` (`AgentManager.ts:230-244`):
/// group by slug, return only groups of size ≥ 2. Insertion order from
/// the input is preserved within each group; the order of groups follows
/// the first occurrence of each duplicated slug (the TS `Map` iteration
/// order semantics).
pub fn find_duplicate_slug_groups(agents: &[ManagedAgent]) -> Vec<Vec<&ManagedAgent>> {
    let mut groups: IndexMap<String, Vec<&ManagedAgent>> = IndexMap::new();
    for agent in agents {
        groups
            .entry(agent.slug.clone())
            .or_default()
            .push(agent);
    }
    groups
        .into_values()
        .filter(|g| g.len() > 1)
        .collect()
}

/// `loadAgents` (`AgentManager.ts:306-337`).
///
/// Composition: scan every stored agent, look up each one's project
/// membership via the persisted kind:31933 events, drop projects whose
/// event is marked deleted (cached per dTag), then sort with
/// [`compare_agents`].
///
/// All substrates are local file reads — no NDK needed. The visibility
/// cache mirrors the TS `projectVisibility = new Map<string, boolean>()`
/// at line 310 — one filesystem hit per project per call rather than per
/// agent.
pub fn load_agents(base_dir: &std::path::Path) -> Result<Vec<ManagedAgent>> {
    let storage = AgentStorage::open(base_dir)?;
    let stored = storage.get_all_stored_agents()?;

    // dTag → "is this project visible (i.e., not deleted)?"
    let mut visibility_cache: IndexMap<String, bool> = IndexMap::new();
    let mut managed: Vec<ManagedAgent> = Vec::with_capacity(stored.len());

    for (_filename_pubkey, agent) in stored {
        let nsec = agent
            .nsec()
            .ok_or_else(|| anyhow!("stored agent missing nsec"))?;
        let pubkey = derive_agent_pubkey_from_nsec(nsec)?;
        let slug = agent
            .slug()
            .ok_or_else(|| anyhow!("stored agent missing slug"))?
            .to_owned();
        let role = agent.role().unwrap_or("").to_owned();
        let name = agent.name().unwrap_or("").to_owned();
        let status = agent.status().map(str::to_owned);

        let projects = list_projects_for_agent(base_dir, &pubkey)?;
        let mut visible_projects: Vec<String> = Vec::with_capacity(projects.len());
        for project_id in projects {
            let visible = match visibility_cache.get(&project_id) {
                Some(v) => *v,
                None => {
                    let v = get_project_visibility(base_dir, &project_id)?
                        != ProjectVisibility::Deleted;
                    visibility_cache.insert(project_id.clone(), v);
                    v
                }
            };
            if visible {
                visible_projects.push(project_id);
            }
        }

        managed.push(ManagedAgent {
            slug,
            name,
            status,
            role,
            pubkey,
            projects: visible_projects,
        });
    }

    managed.sort_by(compare_agents);
    Ok(managed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(slug: &str, status: Option<&str>, projects: Vec<&str>) -> ManagedAgent {
        ManagedAgent {
            slug: slug.to_owned(),
            name: format!("{slug}-name"),
            status: status.map(str::to_owned),
            role: "thinker".into(),
            pubkey: format!("pk-of-{slug}"),
            projects: projects.into_iter().map(str::to_owned).collect(),
        }
    }

    #[test]
    fn is_inactive_only_inactive_status_string() {
        // Mirror `isAgentActive` semantics — only the literal "inactive"
        // string flips it; missing or "active" or anything else is active.
        assert!(agent("a", Some("inactive"), vec![]).is_inactive());
        assert!(!agent("a", Some("active"), vec![]).is_inactive());
        assert!(!agent("a", None, vec![]).is_inactive());
        assert!(!agent("a", Some("paused"), vec![]).is_inactive());
    }

    #[test]
    fn compare_active_before_inactive() {
        let a = agent("alpha", Some("active"), vec![]);
        let b = agent("alpha", Some("inactive"), vec![]);
        assert_eq!(compare_agents(&a, &b), Ordering::Less);
        assert_eq!(compare_agents(&b, &a), Ordering::Greater);
    }

    #[test]
    fn compare_alphabetical_within_status() {
        let a = agent("alpha", None, vec![]);
        let b = agent("beta", None, vec![]);
        assert_eq!(compare_agents(&a, &b), Ordering::Less);
    }

    #[test]
    fn compare_missing_status_treated_as_active() {
        // Missing status sorts before "inactive".
        let no_status = agent("alpha", None, vec![]);
        let inactive = agent("alpha", Some("inactive"), vec![]);
        assert_eq!(compare_agents(&no_status, &inactive), Ordering::Less);
    }

    #[test]
    fn format_projects_empty_returns_literal_none() {
        assert_eq!(format_projects(&[]), "none");
    }

    #[test]
    fn format_projects_joins_with_comma_space() {
        assert_eq!(
            format_projects(&["P1".into(), "P2".into(), "P3".into()]),
            "P1, P2, P3"
        );
    }

    #[test]
    fn format_managed_agent_list_line_includes_slug_and_projects() {
        // Strip ANSI for content checks.
        let entry = agent("alpha", None, vec!["P1", "P2"]);
        let line = format_managed_agent_list_line(&entry);
        let plain = console::strip_ansi_codes(&line);
        assert_eq!(plain, "alpha · projects: P1, P2");
    }

    #[test]
    fn format_managed_agent_list_line_prepends_inactive_tag() {
        // TS at AgentManager.ts:207 — `inactiveTag = chalk.dim("[inactive] ")`
        // with a TRAILING space inside the dim wrap. The trailing
        // space provides the separator between `]` and the slug.
        // Stripped output is `[inactive] alpha · …`.
        let entry = agent("alpha", Some("inactive"), vec![]);
        let line = format_managed_agent_list_line(&entry);
        let plain = console::strip_ansi_codes(&line);
        assert_eq!(plain, "[inactive] alpha · projects: none");
    }

    #[test]
    fn format_managed_agent_list_line_emits_dim_runs_when_styling_forced() {
        // `console` auto-detects TTY; in tests it returns plain output, which
        // would mask whether we wrap the right segments. Force styling on a
        // fresh Style and re-check.
        let dim = console::Style::new().force_styling(true).dim();
        let entry = agent("alpha", None, vec!["P1".into()]);
        let inactive_tag = if entry.is_inactive() {
            dim.apply_to("[inactive] ").to_string()
        } else {
            String::new()
        };
        let middle_dot = dim.apply_to("·").to_string();
        let projects_chunk = dim
            .apply_to(format!("projects: {}", format_projects(&entry.projects)))
            .to_string();
        let line = format!(
            "{inactive_tag}{slug} {middle_dot} {projects_chunk}",
            slug = entry.slug
        );
        // Two dim runs in the active branch: `·`, `projects: P1`.
        let dim_starts = line.matches("\x1b[2m").count();
        assert_eq!(
            dim_starts, 2,
            "expected 2 dim runs (· and projects:…) in: {line:?}"
        );
    }

    #[test]
    fn format_managed_agent_label_is_three_lines() {
        let entry = agent("alpha", None, vec!["P1".into()]);
        let label = format_managed_agent_label(&entry);
        let lines: Vec<&str> = label.split('\n').collect();
        assert_eq!(lines.len(), 3);
        let plain: Vec<String> = lines
            .iter()
            .map(|l| console::strip_ansi_codes(l).into_owned())
            .collect();
        assert_eq!(plain[0], "alpha");
        assert_eq!(plain[1], "    role: thinker");
        assert_eq!(plain[2], "    projects: P1");
    }

    #[test]
    fn format_managed_agent_label_appends_inactive_dim_to_first_line() {
        let entry = agent("alpha", Some("inactive"), vec![]);
        let label = format_managed_agent_label(&entry);
        let plain = console::strip_ansi_codes(&label);
        let first_line = plain.split('\n').next().unwrap();
        assert_eq!(first_line, "alpha [inactive]");
    }

    #[test]
    fn pick_merge_survivor_prefers_more_projects() {
        let many = agent("alpha", None, vec!["P1", "P2", "P3"]);
        let few = agent("alpha", None, vec!["P1"]);
        assert_eq!(pick_merge_survivor(&[few.clone(), many.clone()]).pubkey, many.pubkey);
        assert_eq!(pick_merge_survivor(&[many.clone(), few.clone()]).pubkey, many.pubkey);
    }

    #[test]
    fn pick_merge_survivor_active_beats_inactive_at_equal_project_count() {
        let active = agent("alpha", None, vec!["P1"]);
        let inactive = agent("beta", Some("inactive"), vec!["P1"]);
        // Both have 1 project; active wins regardless of slug ordering.
        assert_eq!(
            pick_merge_survivor(&[inactive.clone(), active.clone()]).pubkey,
            active.pubkey
        );
    }

    #[test]
    fn pick_merge_survivor_alphabetical_tiebreak() {
        let alpha = agent("alpha", None, vec!["P1"]);
        let beta = agent("beta", None, vec!["P1"]);
        assert_eq!(pick_merge_survivor(&[beta.clone(), alpha.clone()]).pubkey, alpha.pubkey);
    }

    #[test]
    #[should_panic(expected = "requires at least one agent")]
    fn pick_merge_survivor_panics_on_empty() {
        let _ = pick_merge_survivor(&[]);
    }

    #[test]
    fn find_duplicate_slug_groups_returns_only_size_ge_2() {
        let agents = vec![
            agent("alpha", None, vec![]),
            agent("alpha", None, vec![]),
            agent("beta", None, vec![]),
            agent("gamma", None, vec![]),
            agent("gamma", None, vec![]),
            agent("gamma", None, vec![]),
        ];
        let groups = find_duplicate_slug_groups(&agents);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].len(), 2); // alpha
        assert_eq!(groups[1].len(), 3); // gamma
        for entry in &groups[0] {
            assert_eq!(entry.slug, "alpha");
        }
        for entry in &groups[1] {
            assert_eq!(entry.slug, "gamma");
        }
    }

    #[test]
    fn find_duplicate_slug_groups_empty_when_no_dupes() {
        let agents = vec![
            agent("alpha", None, vec![]),
            agent("beta", None, vec![]),
            agent("gamma", None, vec![]),
        ];
        assert!(find_duplicate_slug_groups(&agents).is_empty());
    }

    // ─────────── load_agents (composition) ───────────

    use crate::store::agent_storage::{generate_nsec_bech32, AgentDoc};
    use serde_json::Value;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    fn unique_temp() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-manager-load-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn save_stored_agent(
        base: &std::path::Path,
        slug: &str,
        status: &str,
    ) -> String {
        let mut storage = AgentStorage::open(base).unwrap();
        let nsec = generate_nsec_bech32().unwrap();
        let mut raw = indexmap::IndexMap::<String, Value>::new();
        raw.insert("nsec".into(), Value::String(nsec));
        raw.insert("slug".into(), Value::String(slug.into()));
        raw.insert("name".into(), Value::String(slug.into()));
        raw.insert("role".into(), Value::String("thinker".into()));
        raw.insert("status".into(), Value::String(status.into()));
        let doc = AgentDoc::from_raw(raw);
        storage.save_agent(&doc).unwrap()
    }

    fn write_project_event(
        base: &std::path::Path,
        dtag: &str,
        agent_pubkeys: &[&str],
        deleted: bool,
    ) {
        let dir = base.join("projects").join(dtag);
        std::fs::create_dir_all(&dir).unwrap();
        let mut tags: Vec<Value> = vec![Value::Array(vec![
            Value::String("d".into()),
            Value::String(dtag.into()),
        ])];
        for pk in agent_pubkeys {
            tags.push(Value::Array(vec![
                Value::String("p".into()),
                Value::String((*pk).into()),
            ]));
        }
        if deleted {
            tags.push(Value::Array(vec![
                Value::String("deleted".into()),
                Value::String("".into()),
            ]));
        }
        let event = serde_json::json!({"tags": tags});
        std::fs::write(dir.join("event.json"), event.to_string()).unwrap();
    }

    #[test]
    fn load_agents_empty_when_storage_empty() {
        let base = unique_temp();
        let agents = load_agents(&base).unwrap();
        assert!(agents.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn load_agents_returns_sorted_active_first() {
        let base = unique_temp();
        save_stored_agent(&base, "zebra", "active");
        save_stored_agent(&base, "alpha", "inactive");
        save_stored_agent(&base, "mango", "active");
        let agents = load_agents(&base).unwrap();
        let slugs: Vec<&str> = agents.iter().map(|a| a.slug.as_str()).collect();
        // inactive last + alphabetical within group → mango, zebra, alpha
        assert_eq!(slugs, vec!["mango", "zebra", "alpha"]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn load_agents_filters_out_deleted_projects() {
        let base = unique_temp();
        let pk_alpha = save_stored_agent(&base, "alpha", "active");
        write_project_event(&base, "live-project", &[&pk_alpha], false);
        write_project_event(&base, "rip-project", &[&pk_alpha], true);

        let agents = load_agents(&base).unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].projects, vec!["live-project".to_string()]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn load_agents_visibility_cache_works_across_agents() {
        // Two agents in the same project should share the visibility lookup.
        let base = unique_temp();
        let pk_a = save_stored_agent(&base, "alpha", "active");
        let pk_b = save_stored_agent(&base, "beta", "active");
        write_project_event(&base, "shared", &[&pk_a, &pk_b], false);

        let agents = load_agents(&base).unwrap();
        assert_eq!(agents.len(), 2);
        for agent in &agents {
            assert_eq!(agent.projects, vec!["shared".to_string()]);
        }
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn load_agents_handles_no_project_events() {
        // Agent in storage but no projects directory → empty projects list.
        let base = unique_temp();
        save_stored_agent(&base, "alpha", "active");
        let agents = load_agents(&base).unwrap();
        assert_eq!(agents.len(), 1);
        assert!(agents[0].projects.is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn load_agents_carries_role_and_pubkey_through() {
        let base = unique_temp();
        let pk = save_stored_agent(&base, "alpha", "active");
        let agents = load_agents(&base).unwrap();
        assert_eq!(agents[0].pubkey, pk);
        assert_eq!(agents[0].role, "thinker");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn find_duplicate_slug_groups_preserves_first_occurrence_order() {
        let agents = vec![
            agent("z", None, vec![]),
            agent("a", None, vec![]),
            agent("z", None, vec![]),
            agent("a", None, vec![]),
        ];
        let groups = find_duplicate_slug_groups(&agents);
        assert_eq!(groups[0][0].slug, "z");
        assert_eq!(groups[1][0].slug, "a");
    }
}
