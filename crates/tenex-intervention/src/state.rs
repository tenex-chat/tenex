use std::fs;

use anyhow::{Context, Result};

use crate::model::InterventionState;
use crate::paths;

const NOTIFIED_TTL_MS: u64 = 24 * 60 * 60 * 1000;

/// Extract dTag from a project coordinate "31933:<pubkey>:<dTag>".
/// Returns the input unchanged when it isn't a project coordinate.
pub fn d_tag_from_project_id(project_id: &str) -> &str {
    let parts: Vec<&str> = project_id.splitn(3, ':').collect();
    if parts.len() == 3 && parts[0] == "31933" {
        parts[2]
    } else {
        project_id
    }
}

/// Load state for a project, falling back to legacy path if canonical is absent.
/// Returns (state, loaded_from_legacy).
pub fn load_state(project_id: &str) -> Result<(InterventionState, bool)> {
    let d_tag = d_tag_from_project_id(project_id);
    let canonical = paths::intervention_state_file(d_tag);

    if canonical.exists() {
        let bytes = fs::read(&canonical)
            .with_context(|| format!("read {}", canonical.display()))?;
        let state: InterventionState = serde_json::from_slice(&bytes)
            .with_context(|| format!("parse {}", canonical.display()))?;
        return Ok((prune_notified(state), false));
    }

    // Legacy path: the full project_id was used as the filename component.
    let legacy = paths::intervention_state_file_legacy(project_id);
    if legacy.exists() {
        let bytes = fs::read(&legacy)
            .with_context(|| format!("read {}", legacy.display()))?;
        let state: InterventionState = serde_json::from_slice(&bytes)
            .with_context(|| format!("parse {}", legacy.display()))?;
        // Migrate pending entries that used "projectPubkey" instead of "projectId".
        let state = migrate_pending(state, project_id);
        return Ok((prune_notified(state), true));
    }

    Ok((InterventionState::default(), false))
}

/// Save state atomically via write-temp-then-rename.
pub fn save_state(project_id: &str, state: &InterventionState) -> Result<()> {
    let d_tag = d_tag_from_project_id(project_id);
    let path = paths::intervention_state_file(d_tag);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create {}", parent.display()))?;
    }

    let pruned = prune_notified(state.clone());
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&pruned).context("serialize intervention state")?;
    fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, &path).with_context(|| format!("rename to {}", path.display()))?;
    Ok(())
}

fn prune_notified(mut state: InterventionState) -> InterventionState {
    let now = now_ms();
    if let Some(notified) = &mut state.notified {
        notified.retain(|e| now.saturating_sub(e.notified_at) < NOTIFIED_TTL_MS);
        if notified.is_empty() {
            state.notified = None;
        }
    }
    state
}

fn migrate_pending(mut state: InterventionState, project_id: &str) -> InterventionState {
    for p in &mut state.pending {
        if p.project_id.is_empty() {
            p.project_id = project_id.to_string();
        }
    }
    state
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn notified_ttl_ms() -> u64 {
    NOTIFIED_TTL_MS
}
