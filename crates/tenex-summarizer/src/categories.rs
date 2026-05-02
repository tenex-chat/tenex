//! Category tally at `~/.tenex/data/conversation-categories.json`.
//! Format: `{ "<name>": <count> }`. The tally is global rather than
//! per-project despite the file living under `data/`.

use std::collections::HashMap;
use std::fs;

use anyhow::{Context, Result};

use crate::paths;

pub type Tally = HashMap<String, u64>;

pub fn load() -> Result<Tally> {
    let path = paths::categories_file();
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let tally: Tally =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    Ok(tally)
}

pub fn record(new: &[String]) -> Result<()> {
    if new.is_empty() {
        return Ok(());
    }
    let path = paths::categories_file();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let mut tally = load().unwrap_or_default();
    for c in new {
        let normalized = c.trim().to_lowercase();
        if normalized.is_empty() {
            continue;
        }
        *tally.entry(normalized).or_insert(0) += 1;
    }
    let serialized = serde_json::to_vec_pretty(&tally)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, &path)
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

/// Top categories by descending usage count (matches `getCategories`).
pub fn top(n: usize) -> Result<Vec<String>> {
    let tally = load()?;
    let mut pairs: Vec<(String, u64)> = tally.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(pairs.into_iter().take(n).map(|(k, _)| k).collect())
}
