use std::collections::HashSet;
use std::path::{Path, PathBuf};
use parking_lot::Mutex;

const AGENTS_MD_FILENAME: &str = "AGENTS.md";

#[derive(Debug)]
struct AgentsMdFile {
    path: PathBuf,
    directory: PathBuf,
    content: String,
}

#[derive(Debug)]
pub(crate) struct AgentsMdReminderState {
    project_root: PathBuf,
    visible_paths: Mutex<HashSet<PathBuf>>,
}

impl AgentsMdReminderState {
    pub(crate) fn new(project_root: PathBuf) -> Self {
        Self {
            project_root: normalize_lexically(&project_root),
            visible_paths: Mutex::new(HashSet::new()),
        }
    }

    pub(crate) fn reminder_for_path(&self, target_path: &Path) -> String {
        self.reminder_for_paths(std::iter::once(target_path))
    }

    pub(crate) fn reminder_for_paths<'a>(
        &self,
        target_paths: impl IntoIterator<Item = &'a Path>,
    ) -> String {
        let mut seen = HashSet::new();
        let mut files = Vec::new();
        for target_path in target_paths {
            for file in self.find_files(target_path) {
                if seen.insert(file.path.clone()) {
                    files.push(file);
                }
            }
        }

        let mut visible = self.visible_paths.lock();
        let new_files: Vec<AgentsMdFile> = files
            .into_iter()
            .filter(|file| !visible.contains(&file.path))
            .collect();
        if new_files.is_empty() {
            return String::new();
        }
        for file in &new_files {
            visible.insert(file.path.clone());
        }
        drop(visible);

        self.format_reminder(&new_files)
    }

    fn find_files(&self, target_path: &Path) -> Vec<AgentsMdFile> {
        let target_path = normalize_lexically(target_path);
        if !within_or_equal(&target_path, &self.project_root) {
            return Vec::new();
        }

        let mut current_dir = if target_path.is_dir() {
            target_path
        } else {
            target_path
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| target_path.clone())
        };

        let mut files = Vec::new();
        let mut visited = HashSet::new();
        while within_or_equal(&current_dir, &self.project_root)
            && visited.insert(current_dir.clone())
        {
            if current_dir != self.project_root {
                let path = current_dir.join(AGENTS_MD_FILENAME);
                if let Ok(content) = std::fs::read_to_string(&path) {
                    files.push(AgentsMdFile {
                        path,
                        directory: current_dir.clone(),
                        content,
                    });
                }
            }

            let Some(parent) = current_dir.parent() else {
                break;
            };
            if parent == current_dir {
                break;
            }
            current_dir = parent.to_path_buf();
        }

        files.reverse();
        files
    }

    fn format_reminder(&self, files: &[AgentsMdFile]) -> String {
        let sections = files
            .iter()
            .map(|file| {
                let rel = file
                    .directory
                    .strip_prefix(&self.project_root)
                    .unwrap_or(&file.directory);
                let display_path = if rel.as_os_str().is_empty() {
                    "/".to_string()
                } else {
                    format!("/{}", rel.display()).replace('\\', "/")
                };
                format!(
                    "<agents.md path=\"{display_path}\">\n{}\n</agents.md>",
                    file.content.trim()
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        format!("\n\n<system-reminder type=\"agents-md\">\n{sections}\n</system-reminder>")
    }
}

fn within_or_equal(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::AgentsMdReminderState;

    #[test]
    fn returns_nested_agents_md_and_skips_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "root rules").unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/AGENTS.md"), "src rules\n").unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "").unwrap();

        let state = AgentsMdReminderState::new(dir.path().to_path_buf());
        let reminder = state.reminder_for_path(&dir.path().join("src/lib.rs"));

        assert!(reminder.contains("<system-reminder type=\"agents-md\">"));
        assert!(reminder.contains("<agents.md path=\"/src\">\nsrc rules\n</agents.md>"));
        assert!(!reminder.contains("root rules"));
    }

    #[test]
    fn returns_parent_before_child_and_only_once() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/nested")).unwrap();
        std::fs::write(dir.path().join("src/AGENTS.md"), "src rules").unwrap();
        std::fs::write(dir.path().join("src/nested/AGENTS.md"), "nested rules").unwrap();
        std::fs::write(dir.path().join("src/nested/lib.rs"), "").unwrap();

        let state = AgentsMdReminderState::new(dir.path().to_path_buf());
        let first = state.reminder_for_path(&dir.path().join("src/nested/lib.rs"));
        let second = state.reminder_for_path(&dir.path().join("src/nested/lib.rs"));

        let src_pos = first.find("src rules").unwrap();
        let nested_pos = first.find("nested rules").unwrap();
        assert!(src_pos < nested_pos);
        assert!(second.is_empty());
    }

    #[test]
    fn ignores_paths_outside_project_root() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("AGENTS.md"), "outside rules").unwrap();
        std::fs::write(outside.path().join("file.rs"), "").unwrap();

        let state = AgentsMdReminderState::new(project.path().to_path_buf());
        let reminder = state.reminder_for_path(&outside.path().join("file.rs"));

        assert!(reminder.is_empty());
    }
}
