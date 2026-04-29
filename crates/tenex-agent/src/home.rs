use std::fs;
use std::path::{Path, PathBuf};

pub use tenex_system_prompt::InjectedFile;

const MAX_INJECTED_FILES: usize = 10;
const MAX_INJECTED_FILE_LENGTH: usize = 1500;

pub fn agent_home_dir(base_dir: &Path, pubkey_hex: &str) -> PathBuf {
    base_dir
        .join("home")
        .join(&pubkey_hex[..8.min(pubkey_hex.len())])
}

pub fn ensure_agent_home_dir(home_dir: &Path) -> bool {
    fs::create_dir_all(home_dir).is_ok()
}

/// Return files from `home_dir` whose names start with `+`.
/// Reads at most `MAX_INJECTED_FILES`, truncating content to `MAX_INJECTED_FILE_LENGTH`.
pub fn get_injected_files(home_dir: &Path) -> Vec<InjectedFile> {
    let Ok(read_dir) = fs::read_dir(home_dir) else {
        return Vec::new();
    };

    let mut candidates: Vec<String> = read_dir
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let s = name.to_string_lossy();
            s.starts_with('+') && e.file_type().map(|t| t.is_file()).unwrap_or(false)
        })
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    candidates.sort();
    candidates.truncate(MAX_INJECTED_FILES);

    candidates
        .into_iter()
        .filter_map(|filename| {
            let content = fs::read_to_string(home_dir.join(&filename)).ok()?;
            let truncated = content.len() > MAX_INJECTED_FILE_LENGTH;
            let content: String = content.chars().take(MAX_INJECTED_FILE_LENGTH).collect();
            Some(InjectedFile {
                filename,
                content,
                truncated,
            })
        })
        .collect()
}

/// Summarise the visible (non-dotfile) contents of `home_dir`.
pub fn count_home_files(home_dir: &Path) -> String {
    let Ok(read_dir) = fs::read_dir(home_dir) else {
        return "(home directory unavailable)".to_string();
    };

    let entries: Vec<_> = read_dir
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .collect();

    if entries.is_empty() {
        return "(empty)".to_string();
    }

    let file_count = entries
        .iter()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .count();
    let dir_count = entries
        .iter()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .count();

    let mut parts: Vec<String> = Vec::new();
    if file_count > 0 {
        parts.push(format!(
            "{file_count} file{}",
            if file_count != 1 { "s" } else { "" }
        ));
    }
    if dir_count > 0 {
        parts.push(format!(
            "{dir_count} director{}",
            if dir_count != 1 { "ies" } else { "y" }
        ));
    }
    parts.join(", ")
}
