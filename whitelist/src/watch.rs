use anyhow::Result;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::cache::TrustCache;
use crate::paths;

/// Spawn the fs watcher on a background thread. Watches:
///   * `~/.tenex/config.json`             -> reload `whitelistedPubkeys`
///   * `~/.tenex/whitelist/pubkeys.txt`   -> reload backend pubkeys
///   * `~/.tenex/projects/<dtag>/event.json` (any) -> reload p-tags union
///
/// Project subdirs come and go, so we watch the projects/ dir recursively to
/// pick up `event.json` files inside newly-created project dirs without having
/// to add per-dir watches.
pub fn spawn(cache: Arc<TrustCache>) -> Result<()> {
    thread::spawn(move || {
        if let Err(e) = run(cache) {
            eprintln!("[whitelist] watcher exited: {e:#}");
        }
    });
    Ok(())
}

fn run(cache: Arc<TrustCache>) -> Result<()> {
    let (tx, rx) = channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })?;

    let base = paths::base_dir();
    let whitelist_dir = paths::whitelist_dir();
    let projects = paths::projects_dir();
    let config = paths::config_path();
    let backend = paths::backend_pubkeys_path();

    // Watch the base dir non-recursively so we observe config.json
    // create/modify/rename. Atomic writes (tmp + rename) show up here.
    if base.exists() {
        watcher.watch(&base, RecursiveMode::NonRecursive)?;
    }
    if whitelist_dir.exists() {
        watcher.watch(&whitelist_dir, RecursiveMode::NonRecursive)?;
    }
    if projects.exists() {
        watcher.watch(&projects, RecursiveMode::Recursive)?;
    }

    while let Ok(res) = rx.recv() {
        let event = match res {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[whitelist] watch error: {e}");
                continue;
            }
        };
        if !is_relevant(&event.kind) {
            continue;
        }
        let mut hit_config = false;
        let mut hit_backend = false;
        let mut hit_p_tags = false;
        for path in &event.paths {
            if same_path(path, &config) {
                hit_config = true;
            } else if same_path(path, &backend) {
                hit_backend = true;
            } else if path.starts_with(&projects) && is_event_json(path) {
                hit_p_tags = true;
            }
        }

        // Coalesce a short burst of follow-up events to avoid reloading
        // multiple times for a single editor save / atomic rename.
        thread::sleep(Duration::from_millis(50));
        while let Ok(more) = rx.try_recv() {
            if let Ok(ev) = more {
                if !is_relevant(&ev.kind) {
                    continue;
                }
                for path in &ev.paths {
                    if same_path(path, &config) {
                        hit_config = true;
                    } else if same_path(path, &backend) {
                        hit_backend = true;
                    } else if path.starts_with(&projects) && is_event_json(path) {
                        hit_p_tags = true;
                    }
                }
            }
        }

        if hit_config {
            if let Err(e) = cache.reload_whitelist() {
                eprintln!("[whitelist] reload whitelist failed: {e:#}");
            }
        }
        if hit_backend {
            if let Err(e) = cache.reload_backend() {
                eprintln!("[whitelist] reload backend failed: {e:#}");
            }
        }
        if hit_p_tags {
            if let Err(e) = cache.reload_p_tags() {
                eprintln!("[whitelist] reload p_tags failed: {e:#}");
            }
        }
    }

    Ok(())
}

fn is_relevant(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn is_event_json(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "event.json")
        .unwrap_or(false)
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b
}
