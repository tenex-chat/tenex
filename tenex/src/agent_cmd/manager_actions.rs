//! Bulk-action orchestrators for the interactive agent manager.
//!
//! Mirrors the private `bulkDeleteAgents`, `bulkMergeAgents`, `mergeAgents`,
//! and `confirmAndDelete` methods on `AgentManager`
//! (`src/commands/agent/AgentManager.ts:456-609`). Each is a pure
//! composition over substrates that already exist:
//!
//! - [`crate::agent_cmd::provisioning::delete_stored_agent`] — local file +
//!   index removal + optional kind:24011 inventory publish
//! - [`crate::store::agent_storage::AgentStorage::add_agent_to_project`] —
//!   local index mutation + status flip
//! - [`crate::nostr_pub::project_mutation::sync_many_project_memberships`]
//!   — kind:31933 republish per affected project
//! - [`crate::tui::prompts::confirm`] — TENEX-themed yes/no prompt
//! - [`crate::tui::display`] — `blank()` / `success()` / `hint()` /
//!   `context()` print helpers
//!
//! Every prompt string and success/hint message is verbatim from the TS
//! source — including the singular/plural toggles
//! (`agent`/`agents`, `project`/`projects`).
//!
//! These functions take a resolved owner [`Keys`] from the caller; they
//! do not run [`crate::nostr_pub::owner_signer::resolve_owner_signer`]
//! themselves. The TS source resolves the signer per-call inside
//! `getOwnerSigner`; the Rust port lifts that to the caller so the
//! manager can resolve once at the start of an interactive session and
//! reuse it across many actions.

use anyhow::{anyhow, Result};
use nostr_sdk::Keys;

use crate::agent_cmd::manager_logic::{
    find_duplicate_slug_groups, format_managed_agent_list_line, format_projects,
    load_agents, pick_merge_survivor, ManagedAgent,
};
use crate::agent_cmd::provisioning::{delete_stored_agent, DeleteOptions};
use crate::nostr_pub::owner_signer::resolve_owner_signer;
use crate::nostr_pub::project_mutation::sync_many_project_memberships;
use crate::store::agent_storage::AgentStorage;
use crate::store::project_members::list_assignable_project_dtags;
use crate::tui::custom_prompts::agent_select_prompt::{
    agent_select_prompt, get_agent_list_height, ActionItem, AgentItem,
};
use crate::tui::display;
use crate::tui::prompts;

/// Mirror `bulkDeleteAgents` (`AgentManager.ts:456-490`).
///
/// 1. Guard — if `agents` or `selected_pubkeys` is empty: print
///    `"Select one or more agents first."` hint and return.
/// 2. Compute the selected subset.
/// 3. Confirm prompt: `"Permanently delete N agent(s)?"` (default false).
///    User-cancel returns silently.
/// 4. Collect affected project dTags = unique union of every selected
///    agent's `projects` field.
/// 5. Delete each (publishing inventory after each — TS default behavior).
/// 6. Re-publish every affected project's kind:31933 with the post-delete
///    local membership.
/// 7. Success line: `"Deleted N agent(s)"`.
pub async fn bulk_delete_agents(
    base_dir: &std::path::Path,
    keys: &Keys,
    agents: &[ManagedAgent],
    selected_pubkeys: &[String],
) -> Result<()> {
    if agents.is_empty() || selected_pubkeys.is_empty() {
        display::blank();
        display::hint("Select one or more agents first.");
        return Ok(());
    }

    let selected: Vec<&ManagedAgent> = agents
        .iter()
        .filter(|a| selected_pubkeys.iter().any(|p| p == &a.pubkey))
        .collect();
    if selected.is_empty() {
        display::blank();
        display::hint("Select one or more agents first.");
        return Ok(());
    }

    let n = selected.len();
    let plural = if n == 1 { "" } else { "s" };
    let confirmed = match prompts::confirm(&format!(
        "Permanently delete {n} agent{plural}?"
    ))
    .with_default(false)
    .prompt()
    {
        Ok(b) => b,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => false,
        Err(e) => return Err(anyhow!("bulk-delete confirm: {e}")),
    };
    if !confirmed {
        return Ok(());
    }

    let affected: Vec<String> = unique_ordered_projects(&selected);

    let mut deleted_count = 0usize;
    for agent in &selected {
        let was_deleted = delete_stored_agent(
            base_dir,
            &agent.pubkey,
            DeleteOptions::new(),
        )
        .await?;
        if was_deleted {
            deleted_count += 1;
        }
    }

    sync_many_project_memberships(base_dir, keys, &affected).await?;

    display::blank();
    let plural = if deleted_count == 1 { "" } else { "s" };
    display::success(&format!("Deleted {deleted_count} agent{plural}"));
    Ok(())
}

/// Mirror `bulkMergeAgents` (`AgentManager.ts:492-500`).
///
/// Guard — fewer than 2 agents loaded OR fewer than 2 selected → print
/// `"Select at least 2 agents first."` and return. Otherwise delegate
/// to [`merge_agents`] with `confirm = true`.
pub async fn bulk_merge_agents(
    base_dir: &std::path::Path,
    keys: &Keys,
    agents: &[ManagedAgent],
    selected_pubkeys: &[String],
) -> Result<()> {
    if agents.len() < 2 || selected_pubkeys.len() < 2 {
        display::blank();
        display::hint("Select at least 2 agents first.");
        return Ok(());
    }
    let selected: Vec<ManagedAgent> = agents
        .iter()
        .filter(|a| selected_pubkeys.iter().any(|p| p == &a.pubkey))
        .cloned()
        .collect();
    if selected.len() < 2 {
        display::blank();
        display::hint("Select at least 2 agents first.");
        return Ok(());
    }
    merge_agents(base_dir, keys, &selected, true).await
}

/// Mirror `mergeAgents` (`AgentManager.ts:538-581`).
///
/// Steps:
/// 1. Need ≥ 2 agents (silent return otherwise — matches TS `:539-541`).
/// 2. Pick the survivor via [`pick_merge_survivor`].
/// 3. Compute the union of all merged project dTags.
/// 4. List the agents to be deleted (everyone except the survivor).
/// 5. If `confirm`: prompt
///    `"Keep <slug> and merge N project(s) from M other agent(s)?"`
///    (default false). User-cancel returns silently.
/// 6. Add the survivor to every merged project (idempotent).
/// 7. Delete each non-survivor — `publish_inventory` is set to `true`
///    only on the **last** deletion to avoid spamming the relay
///    (matches TS `:567-571`).
/// 8. Re-publish all affected project events.
/// 9. If `confirm`: success line `"Merged N agents into <slug>"` plus a
///    `"Projects: <csv>"` context line.
pub async fn merge_agents(
    base_dir: &std::path::Path,
    keys: &Keys,
    agents: &[ManagedAgent],
    confirm: bool,
) -> Result<()> {
    if agents.len() < 2 {
        return Ok(());
    }

    let survivor = pick_merge_survivor(agents).clone();
    let merged_project_ids = unique_ordered_projects(&agents.iter().collect::<Vec<_>>());
    let agents_to_delete: Vec<&ManagedAgent> = agents
        .iter()
        .filter(|a| a.pubkey != survivor.pubkey)
        .collect();

    if confirm {
        let project_n = merged_project_ids.len();
        let project_plural = if project_n == 1 { "" } else { "s" };
        let other_n = agents_to_delete.len();
        let other_plural = if other_n == 1 { "" } else { "s" };
        let message = format!(
            "Keep {} and merge {project_n} project{project_plural} from {other_n} other agent{other_plural}?",
            survivor.slug,
        );
        let confirmed = match prompts::confirm(&message).with_default(false).prompt() {
            Ok(b) => b,
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => false,
            Err(e) => return Err(anyhow!("merge confirm: {e}")),
        };
        if !confirmed {
            return Ok(());
        }
    }

    {
        let mut storage = AgentStorage::open(base_dir)?;
        for project_id in &merged_project_ids {
            storage.add_agent_to_project(&survivor.pubkey, project_id)?;
        }
    }

    let last_idx = agents_to_delete.len().saturating_sub(1);
    for (index, agent) in agents_to_delete.iter().enumerate() {
        let is_last = index == last_idx;
        delete_stored_agent(
            base_dir,
            &agent.pubkey,
            DeleteOptions::new().with_publish_inventory(is_last),
        )
        .await?;
    }

    sync_many_project_memberships(base_dir, keys, &merged_project_ids).await?;

    if confirm {
        display::blank();
        display::success(&format!(
            "Merged {} agents into {}",
            agents.len(),
            survivor.slug,
        ));
        display::context(&format!(
            "Projects: {}",
            crate::agent_cmd::manager_logic::format_projects(&merged_project_ids),
        ));
    }
    Ok(())
}

/// Mirror `assignAgentToProjects` (`AgentManager.ts:393-454`).
///
/// 1. If `entry` is None: `"Agent no longer exists."` hint.
/// 2. Compute the union of locally-assignable project dTags
///    (`listAssignableProjectDTags`) ∪ the agent's current projects,
///    deduped and alphabetically sorted.
/// 3. If empty: `"No projects available to assign."` hint.
/// 4. Render checkbox prompt with `"Assigned to projects"` message and
///    the agent's current memberships pre-checked. `page_size` mirrors
///    `getAgentListHeight()` (caller-supplied — typically `max(8, 60% of
///    rows, 24 fallback)`).
/// 5. Compute add/remove deltas vs `entry.projects`.
/// 6. If both empty: `"No project changes."` hint.
/// 7. Apply: `add_agent_to_project` for adds, `remove_agent_from_project`
///    for removes (storage-level mutation; status flips when last
///    project is removed).
/// 8. Sync the affected projects (`add ∪ remove`) via
///    [`sync_many_project_memberships`].
/// 9. Success line `"Updated projects for <slug>"` plus a context line
///    `"Projects: <selected csv>"`.
pub async fn assign_agent_to_projects(
    base_dir: &std::path::Path,
    keys: &Keys,
    entry: Option<&ManagedAgent>,
    page_size: usize,
) -> Result<()> {
    let Some(entry) = entry else {
        display::blank();
        display::hint("Agent no longer exists.");
        return Ok(());
    };

    let available = list_assignable_project_dtags(base_dir)?;
    let mut all: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for p in &available {
        all.insert(p.clone());
    }
    for p in &entry.projects {
        all.insert(p.clone());
    }
    let mut choices: Vec<String> = all.into_iter().collect();
    choices.sort();

    if choices.is_empty() {
        display::blank();
        display::hint("No projects available to assign.");
        return Ok(());
    }

    // Indices of items the user is currently in — these are the
    // checked defaults.
    let current_set: indexmap::IndexSet<&String> = entry.projects.iter().collect();
    let default_indices: Vec<usize> = choices
        .iter()
        .enumerate()
        .filter_map(|(i, c)| if current_set.contains(c) { Some(i) } else { None })
        .collect();

    let selected = match prompts::multi_select("Assigned to projects", choices.clone())
        .with_default(&default_indices)
        .with_page_size(page_size.max(1))
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("assign-projects prompt: {e}")),
    };

    let selected_set: indexmap::IndexSet<&String> = selected.iter().collect();
    let to_add: Vec<String> = selected
        .iter()
        .filter(|p| !current_set.contains(*p))
        .cloned()
        .collect();
    let to_remove: Vec<String> = entry
        .projects
        .iter()
        .filter(|p| !selected_set.contains(*p))
        .cloned()
        .collect();

    if to_add.is_empty() && to_remove.is_empty() {
        display::blank();
        display::hint("No project changes.");
        return Ok(());
    }

    {
        let mut storage = AgentStorage::open(base_dir)?;
        for project_id in &to_add {
            storage.add_agent_to_project(&entry.pubkey, project_id)?;
        }
        for project_id in &to_remove {
            storage.remove_agent_from_project(&entry.pubkey, project_id)?;
        }
    }

    let affected: Vec<String> = to_add.iter().chain(to_remove.iter()).cloned().collect();
    sync_many_project_memberships(base_dir, keys, &affected).await?;

    display::blank();
    display::success(&format!("Updated projects for {}", entry.slug));
    display::context(&format!("Projects: {}", format_projects(&selected)));
    Ok(())
}

/// Mirror `confirmAndDelete` (`AgentManager.ts:583-609`).
///
/// 1. If no managed entry for `pubkey` was loaded: print
///    `"Agent no longer exists."` hint and return.
/// 2. Confirm prompt:
///    `"Permanently delete <slug> from storage?"` (default false).
///    User-cancel returns silently.
/// 3. Capture affected projects from the entry, delete locally, sync the
///    affected projects.
/// 4. Success line: `"Deleted \"<name>\" (<slug>)"` — note the quoted
///    name + parenthesised slug shape (TS `:608`).
pub async fn confirm_and_delete(
    base_dir: &std::path::Path,
    keys: &Keys,
    entry: Option<&ManagedAgent>,
) -> Result<()> {
    let Some(entry) = entry else {
        display::blank();
        display::hint("Agent no longer exists.");
        return Ok(());
    };

    let confirmed = match prompts::confirm(&format!(
        "Permanently delete {} from storage?",
        entry.slug,
    ))
    .with_default(false)
    .prompt()
    {
        Ok(b) => b,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => false,
        Err(e) => return Err(anyhow!("confirm-and-delete: {e}")),
    };
    if !confirmed {
        return Ok(());
    }

    let affected = entry.projects.clone();
    delete_stored_agent(base_dir, &entry.pubkey, DeleteOptions::new()).await?;
    sync_many_project_memberships(base_dir, keys, &affected).await?;

    display::blank();
    display::success(&format!("Deleted \"{}\" ({})", entry.name, entry.slug));
    Ok(())
}

/// Outcome of [`offer_auto_merge_for_duplicate_slugs`]. Tracks whether
/// the user dismissed the prompt so the caller can suppress re-prompting
/// within the same session.
#[derive(Debug, Clone)]
pub struct AutoMergeOutcome {
    /// Re-loaded agents after any merges (or the original list when no
    /// merges happened).
    pub agents: Vec<ManagedAgent>,
    /// `true` iff the user answered "no" to the merge prompt — caller
    /// should set its session-scope dismissal flag.
    pub dismissed: bool,
}

/// Mirror `offerAutoMergeForDuplicateSlugs` (`AgentManager.ts:502-536`).
///
/// 1. If `dismissed` is already `true` (caller's session-scope flag):
///    return the input unchanged.
/// 2. Find duplicate slug groups via [`find_duplicate_slug_groups`].
///    No duplicates → return unchanged.
/// 3. Build summary: `"<slug1> (<count1>), <slug2> (<count2>)…"`.
/// 4. Confirm prompt:
///    `"Detected duplicate slugs: <summary>. Auto-merge them now?"`
///    (default `true` — opposite of the bulk-delete confirm).
/// 5. User declines → set `dismissed = true`, return unchanged.
/// 6. User accepts → for each group call [`merge_agents`] with
///    `confirm = false` (suppresses the per-merge prompt).
/// 7. After all merges: `"Auto-merged N duplicate slug group(s)"`
///    success line, then re-load via [`load_agents`].
///
/// `caller_dismissed` short-circuits the entire path — pass the manager's
/// session-scope flag in.
pub async fn offer_auto_merge_for_duplicate_slugs(
    base_dir: &std::path::Path,
    keys: &Keys,
    agents: Vec<ManagedAgent>,
    caller_dismissed: bool,
) -> Result<AutoMergeOutcome> {
    if caller_dismissed {
        return Ok(AutoMergeOutcome {
            agents,
            dismissed: true,
        });
    }

    let groups = find_duplicate_slug_groups(&agents);
    if groups.is_empty() {
        return Ok(AutoMergeOutcome {
            agents,
            dismissed: false,
        });
    }

    let summary = groups
        .iter()
        .map(|g| {
            let slug = g
                .first()
                .map(|a| a.slug.as_str())
                .unwrap_or("");
            format!("{slug} ({})", g.len())
        })
        .collect::<Vec<_>>()
        .join(", ");

    let confirmed = match prompts::confirm(&format!(
        "Detected duplicate slugs: {summary}. Auto-merge them now?"
    ))
    .with_default(true)
    .prompt()
    {
        Ok(b) => b,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => false,
        Err(e) => return Err(anyhow!("auto-merge confirm: {e}")),
    };

    if !confirmed {
        return Ok(AutoMergeOutcome {
            agents,
            dismissed: true,
        });
    }

    // Clone groups out as owned Vec<ManagedAgent> for the merge calls,
    // since `merge_agents` takes `&[ManagedAgent]` and the references in
    // `groups` borrow from `agents`.
    let owned_groups: Vec<Vec<ManagedAgent>> = groups
        .iter()
        .map(|g| g.iter().map(|a| (*a).clone()).collect())
        .collect();
    let group_count = owned_groups.len();
    for group in &owned_groups {
        merge_agents(base_dir, keys, group, false).await?;
    }

    display::blank();
    let plural = if group_count == 1 { "" } else { "s" };
    display::success(&format!(
        "Auto-merged {group_count} duplicate slug group{plural}"
    ));

    let reloaded = load_agents(base_dir)?;
    Ok(AutoMergeOutcome {
        agents: reloaded,
        dismissed: false,
    })
}

/// Mirror `showAgentDetail` (`AgentManager.ts:349-391`).
///
/// Outer loop: re-resolve the entry on every iteration (so user actions
/// that modify state are reflected). Steps per iteration:
///
/// 1. Re-load the agents list and find the matching pubkey. None →
///    `"Agent no longer exists."` hint, return.
/// 2. Print step header `(0/0  <slug>)` plus context lines:
///    `Name: <name>`, `Role: <role>`, `Status: <active|inactive>`,
///    `Projects: <csv>`.
/// 3. Select prompt `"Agent"` with three choices:
///    `"Assign to projects"` → `assign-projects`
///    `"Delete permanently"` → `delete`
///    `"Back"` → `back`
/// 4. Branch:
///    - `back` → return
///    - `assign-projects` → [`assign_agent_to_projects`], continue loop
///    - `delete` → [`confirm_and_delete`], return
pub async fn show_agent_detail(
    base_dir: &std::path::Path,
    keys: &Keys,
    pubkey: &str,
    page_size: usize,
) -> Result<()> {
    const CHOICE_ASSIGN: &str = "Assign to projects";
    const CHOICE_DELETE: &str = "Delete permanently";
    const CHOICE_BACK: &str = "Back";

    loop {
        let agents = load_agents(base_dir)?;
        let entry = agents.iter().find(|a| a.pubkey == pubkey);
        let Some(entry) = entry else {
            display::blank();
            display::hint("Agent no longer exists.");
            return Ok(());
        };

        display::blank();
        display::step(0, 0, &entry.slug);
        display::context(&format!("Name: {}", entry.name));
        display::context(&format!("Role: {}", entry.role));
        let status_text = entry.status.as_deref().unwrap_or("active");
        display::context(&format!("Status: {status_text}"));
        display::context(&format!("Projects: {}", format_projects(&entry.projects)));

        let action = match prompts::select(
            "Agent",
            vec![
                CHOICE_ASSIGN.to_owned(),
                CHOICE_DELETE.to_owned(),
                CHOICE_BACK.to_owned(),
            ],
        )
        .prompt()
        {
            Ok(s) => s,
            Err(inquire::InquireError::OperationCanceled)
            | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
            Err(e) => return Err(anyhow!("agent-detail action prompt: {e}")),
        };

        match action.as_str() {
            CHOICE_BACK => return Ok(()),
            CHOICE_ASSIGN => {
                // Snapshot the entry for the call; the loop will re-load
                // on the next iteration to reflect the mutation.
                let snapshot = entry.clone();
                assign_agent_to_projects(base_dir, keys, Some(&snapshot), page_size)
                    .await?;
                continue;
            }
            CHOICE_DELETE => {
                let snapshot = entry.clone();
                confirm_and_delete(base_dir, keys, Some(&snapshot)).await?;
                return Ok(());
            }
            other => {
                return Err(anyhow!(
                    "show_agent_detail: unexpected action {other:?}"
                ));
            }
        }
    }
}

/// Top-level interactive entry point — `tenex agent manage` (and the
/// default `tenex agent` invocation) hand off to this. Mirrors
/// `AgentManager.showMainMenu` (`AgentManager.ts:259-311`) end-to-end.
///
/// Iterates a loop:
/// 1. `load_agents` — read storage + project visibility
/// 2. `offer_auto_merge_for_duplicate_slugs` — opportunistic clean-up
/// 3. Print step header `(0/0  Agent Manager)` plus context line
/// 4. Build `agent_select_prompt` items from `format_managed_agent_list_line`
///    plus two action rows: `Delete selected (x)`, `Merge selected (m)`
///    (the `(x)` / `(m)` shortcut hints are dim-styled per TS at
///    `:265-267`)
/// 5. Run the prompt with message `Agents (N)` (count dim)
/// 6. Dispatch:
///    - `done` (Enter on the `Done` row, or Cancel) → return
///    - `delete-selected` → [`bulk_delete_agents`], loop
///    - `merge-selected` → [`bulk_merge_agents`], loop
///    - `agent:<pubkey>` → [`show_agent_detail`], loop
///    - `delete:<pubkey>` → [`confirm_and_delete`], loop (TS supports
///      this even though the live menu doesn't currently emit it)
///
/// Owner signer is resolved lazily on the first mutating action so that a
/// session that just wants to read can skip the nsec prompt. The
/// `duplicate_merge_dismissed` flag is session-scope: once the user
/// declines the auto-merge suggestion, we stop offering it for the rest
/// of the session.
pub async fn show_main_menu(base_dir: &std::path::Path) -> Result<()> {
    use console::Style;
    let dim = Style::new().dim();

    let mut owner_keys: Option<Keys> = None;
    let mut duplicate_merge_dismissed = false;
    let page_size = get_agent_list_height();

    loop {
        let mut agents = load_agents(base_dir)?;

        // Auto-merge pass — may need the signer (because mergeAgents calls
        // syncManyProjectMemberships). Resolve lazily here only if a
        // duplicate group is actually present.
        if !duplicate_merge_dismissed && !find_duplicate_slug_groups(&agents).is_empty() {
            let keys = ensure_owner_signer(&mut owner_keys, base_dir)?;
            let outcome = offer_auto_merge_for_duplicate_slugs(
                base_dir,
                &keys,
                agents,
                duplicate_merge_dismissed,
            )
            .await?;
            agents = outcome.agents;
            duplicate_merge_dismissed = outcome.dismissed;
        }

        display::blank();
        display::step(0, 0, "Agent Manager");
        display::context(
            "Inspect current agent memberships or permanently delete stored agents.",
        );

        let items: Vec<AgentItem> = agents
            .iter()
            .map(|entry| AgentItem {
                name: format_managed_agent_list_line(entry),
                value: format!("agent:{}", entry.pubkey),
                pubkey: Some(entry.pubkey.clone()),
            })
            .collect();

        let actions: Vec<ActionItem> = vec![
            ActionItem {
                name: format!("Delete selected {}", dim.apply_to("(x)")),
                value: "delete-selected".to_owned(),
                key: 'x',
            },
            ActionItem {
                name: format!("Merge selected {}", dim.apply_to("(m)")),
                value: "merge-selected".to_owned(),
                key: 'm',
            },
        ];

        let message = format!("Agents {}", dim.apply_to(format!("({})", agents.len())));
        let result = match agent_select_prompt(&message, &actions, &items)? {
            Some(r) => r,
            None => return Ok(()), // Esc / Ctrl-C → done
        };

        match result.action.as_str() {
            "done" => return Ok(()),
            "delete-selected" => {
                let keys = ensure_owner_signer(&mut owner_keys, base_dir)?;
                bulk_delete_agents(base_dir, &keys, &agents, &result.selected_pubkeys).await?;
                continue;
            }
            "merge-selected" => {
                let keys = ensure_owner_signer(&mut owner_keys, base_dir)?;
                bulk_merge_agents(base_dir, &keys, &agents, &result.selected_pubkeys).await?;
                continue;
            }
            other if other.starts_with("agent:") => {
                let pubkey = &other["agent:".len()..];
                let keys = ensure_owner_signer(&mut owner_keys, base_dir)?;
                show_agent_detail(base_dir, &keys, pubkey, page_size).await?;
                continue;
            }
            other if other.starts_with("delete:") => {
                let pubkey = &other["delete:".len()..];
                let keys = ensure_owner_signer(&mut owner_keys, base_dir)?;
                let entry_clone = agents.iter().find(|a| a.pubkey == pubkey).cloned();
                confirm_and_delete(base_dir, &keys, entry_clone.as_ref()).await?;
                continue;
            }
            other => {
                return Err(anyhow!(
                    "show_main_menu: unexpected action {other:?}"
                ));
            }
        }
    }
}

/// Resolve the owner signer once per session, then return cached keys.
/// Mirrors `AgentManager.getOwnerSigner` (`AgentManager.ts:252-257`).
fn ensure_owner_signer(
    cache: &mut Option<Keys>,
    base_dir: &std::path::Path,
) -> Result<Keys> {
    if cache.is_none() {
        *cache = Some(resolve_owner_signer(base_dir)?);
    }
    Ok(cache.clone().expect("just populated"))
}

/// Union of every agent's `projects` field, deduped while preserving
/// first-occurrence order. Mirrors the TS pattern
/// `Array.from(new Set(agents.flatMap(e => e.projects)))`.
fn unique_ordered_projects(agents: &[&ManagedAgent]) -> Vec<String> {
    let mut seen: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for agent in agents {
        for p in &agent.projects {
            seen.insert(p.clone());
        }
    }
    seen.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_cmd::manager_logic::ManagedAgent;
    use crate::store::agent_storage::generate_nsec_bech32;
    use nostr_sdk::Keys;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique_temp() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-manager-actions-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn agent(slug: &str, projects: Vec<&str>) -> ManagedAgent {
        // Generate a random pubkey so Set-based dedupe across tests doesn't
        // bleed; we only use this in tests that don't read the storage.
        let nsec = generate_nsec_bech32().unwrap();
        let pubkey =
            crate::store::agent_storage::derive_agent_pubkey_from_nsec(&nsec).unwrap();
        ManagedAgent {
            slug: slug.to_owned(),
            name: format!("{slug}-name"),
            status: Some("active".to_owned()),
            role: "thinker".to_owned(),
            pubkey,
            projects: projects.into_iter().map(str::to_owned).collect(),
        }
    }

    #[test]
    fn unique_ordered_projects_preserves_first_occurrence_and_dedupes() {
        let a = agent("a", vec!["P1", "P2"]);
        let b = agent("b", vec!["P2", "P3"]);
        let c = agent("c", vec!["P1"]);
        let result = unique_ordered_projects(&[&a, &b, &c]);
        assert_eq!(result, vec!["P1".to_string(), "P2".into(), "P3".into()]);
    }

    #[test]
    fn unique_ordered_projects_empty_input_returns_empty() {
        let result = unique_ordered_projects(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn unique_ordered_projects_handles_no_projects() {
        let a = agent("a", vec![]);
        let result = unique_ordered_projects(&[&a]);
        assert!(result.is_empty());
    }

    // ── bulk_delete_agents guards ──────────────────────────────────────

    #[tokio::test]
    async fn bulk_delete_empty_agents_is_noop() {
        let base = unique_temp();
        let keys = Keys::generate();
        // No agents, no selection — guard fires, no prompt invoked.
        let result = bulk_delete_agents(&base, &keys, &[], &[]).await;
        assert!(result.is_ok());
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn bulk_delete_empty_selection_is_noop() {
        let base = unique_temp();
        let keys = Keys::generate();
        let a = agent("alpha", vec!["P1"]);
        let result = bulk_delete_agents(&base, &keys, &[a], &[]).await;
        assert!(result.is_ok());
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn bulk_delete_selection_does_not_match_any_agent_is_noop() {
        // selected_pubkeys non-empty but none match — TS doesn't have this
        // guard at the `selected.length === 0` level explicitly, but the
        // resulting filter produces an empty `selectedAgents`. Our Rust
        // version short-circuits early so we never hit a prompt-in-tests
        // path.
        let base = unique_temp();
        let keys = Keys::generate();
        let a = agent("alpha", vec!["P1"]);
        let result =
            bulk_delete_agents(&base, &keys, &[a], &["does-not-match".to_owned()]).await;
        assert!(result.is_ok());
        std::fs::remove_dir_all(&base).ok();
    }

    // ── bulk_merge_agents guards ───────────────────────────────────────

    #[tokio::test]
    async fn bulk_merge_with_one_total_agent_is_noop() {
        let base = unique_temp();
        let keys = Keys::generate();
        let a = agent("alpha", vec![]);
        let result =
            bulk_merge_agents(&base, &keys, &[a.clone()], &[a.pubkey.clone()]).await;
        assert!(result.is_ok());
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn bulk_merge_with_one_selected_is_noop() {
        let base = unique_temp();
        let keys = Keys::generate();
        let a = agent("alpha", vec![]);
        let b = agent("beta", vec![]);
        let result = bulk_merge_agents(
            &base,
            &keys,
            &[a.clone(), b],
            &[a.pubkey.clone()],
        )
        .await;
        assert!(result.is_ok());
        std::fs::remove_dir_all(&base).ok();
    }

    // ── merge_agents guards ─────────────────────────────────────────────

    #[tokio::test]
    async fn merge_agents_below_two_is_silent_noop() {
        // TS `:539-541` returns silently when `agents.length < 2`.
        let base = unique_temp();
        let keys = Keys::generate();
        let a = agent("alpha", vec![]);
        let result = merge_agents(&base, &keys, &[a], false).await;
        assert!(result.is_ok());
        std::fs::remove_dir_all(&base).ok();
    }

    // ── confirm_and_delete guard ────────────────────────────────────────

    #[tokio::test]
    async fn confirm_and_delete_no_entry_emits_no_longer_exists_hint() {
        let base = unique_temp();
        let keys = Keys::generate();
        let result = confirm_and_delete(&base, &keys, None).await;
        assert!(result.is_ok());
        std::fs::remove_dir_all(&base).ok();
    }

    // ── offer_auto_merge_for_duplicate_slugs ───────────────────────────

    #[tokio::test]
    async fn offer_auto_merge_short_circuits_when_caller_dismissed() {
        // Even with duplicates present, a previously-dismissed flag means
        // we never prompt — return the input unchanged.
        let base = unique_temp();
        let keys = Keys::generate();
        let dup1 = agent("dupe", vec!["P1"]);
        let dup2 = agent("dupe", vec!["P2"]);
        let agents = vec![dup1, dup2];
        let outcome = offer_auto_merge_for_duplicate_slugs(
            &base,
            &keys,
            agents.clone(),
            true, // caller_dismissed
        )
        .await
        .unwrap();
        assert!(outcome.dismissed);
        assert_eq!(outcome.agents.len(), agents.len());
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn offer_auto_merge_no_duplicates_returns_unchanged() {
        let base = unique_temp();
        let keys = Keys::generate();
        let a = agent("alpha", vec![]);
        let b = agent("beta", vec![]);
        let outcome = offer_auto_merge_for_duplicate_slugs(
            &base,
            &keys,
            vec![a, b],
            false,
        )
        .await
        .unwrap();
        assert!(!outcome.dismissed);
        assert_eq!(outcome.agents.len(), 2);
        std::fs::remove_dir_all(&base).ok();
    }

    // ── assign_agent_to_projects guards ────────────────────────────────

    #[tokio::test]
    async fn assign_no_entry_emits_no_longer_exists_hint() {
        let base = unique_temp();
        let keys = Keys::generate();
        let result = assign_agent_to_projects(&base, &keys, None, 8).await;
        assert!(result.is_ok());
        std::fs::remove_dir_all(&base).ok();
    }

    #[tokio::test]
    async fn assign_no_projects_available_emits_hint() {
        // Empty projects dir, agent has no current projects either —
        // choices list is empty → "No projects available to assign."
        // Returns Ok without prompting (so test runs offline).
        let base = unique_temp();
        let keys = Keys::generate();
        let entry = agent("alpha", vec![]);
        let result = assign_agent_to_projects(&base, &keys, Some(&entry), 8).await;
        assert!(result.is_ok());
        std::fs::remove_dir_all(&base).ok();
    }
}
