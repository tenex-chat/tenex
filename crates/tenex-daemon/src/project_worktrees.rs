use std::path::Path;
use std::process::Command;

pub fn read_project_worktrees(project_path: impl AsRef<Path>) -> Vec<String> {
    let project_path = project_path.as_ref();
    if !project_path.is_dir() {
        return Vec::new();
    }

    let Some(output) = run_git(project_path, &["worktree", "list", "--porcelain"]) else {
        return Vec::new();
    };
    let worktrees = parse_git_worktree_porcelain(&output);
    if worktrees.is_empty() {
        return Vec::new();
    }

    order_worktrees_default_first(worktrees, detect_default_branch(project_path))
}

fn detect_default_branch(project_path: &Path) -> String {
    if let Some(output) = run_git(project_path, &["symbolic-ref", "refs/remotes/origin/HEAD"])
        && let Some(branch) = output
            .trim()
            .strip_prefix("refs/remotes/origin/")
            .filter(|branch| !branch.is_empty())
    {
        return branch.to_string();
    }

    if let Some(output) = run_git(project_path, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        let branch = output.trim();
        if !branch.is_empty() && branch != "HEAD" {
            return branch.to_string();
        }
    }

    if let Some(output) = run_git(project_path, &["config", "--get", "init.defaultBranch"]) {
        let branch = output.trim();
        if !branch.is_empty() {
            return branch.to_string();
        }
    }

    "main".to_string()
}

fn run_git(project_path: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(project_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

fn parse_git_worktree_porcelain(output: &str) -> Vec<String> {
    let mut worktrees = Vec::new();
    let mut current_path = None::<&str>;
    let mut current_branch = None::<String>;

    for line in output.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path);
        } else if let Some(branch) = line.strip_prefix("branch ") {
            let branch = branch.strip_prefix("refs/heads/").unwrap_or(branch);
            current_branch = Some(branch.to_string());
        } else if line.is_empty() {
            if current_path.is_some()
                && let Some(branch) = current_branch.take()
                && !branch.is_empty()
            {
                worktrees.push(branch);
            }
            current_path = None;
        }
    }

    if current_path.is_some()
        && let Some(branch) = current_branch.take()
        && !branch.is_empty()
    {
        worktrees.push(branch);
    }

    worktrees
}

fn order_worktrees_default_first(
    mut worktrees: Vec<String>,
    default_branch: String,
) -> Vec<String> {
    worktrees.sort();
    worktrees.dedup();

    let mut ordered = Vec::new();
    if let Some(default_index) = worktrees
        .iter()
        .position(|branch| branch == &default_branch)
    {
        ordered.push(worktrees.remove(default_index));
    }
    ordered.extend(worktrees);
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn parses_git_worktree_porcelain_branch_names() {
        let output = "\
worktree /repo/project
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo/project/.worktrees/feature_rust
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature/rust

worktree /repo/project/.worktrees/detached
HEAD 3333333333333333333333333333333333333333
detached
";

        assert_eq!(
            parse_git_worktree_porcelain(output),
            vec!["main".to_string(), "feature/rust".to_string()]
        );
    }

    #[test]
    fn orders_default_branch_first_and_sorts_remaining_branches() {
        let ordered = order_worktrees_default_first(
            vec![
                "feature/z".to_string(),
                "main".to_string(),
                "feature/a".to_string(),
                "feature/a".to_string(),
            ],
            "main".to_string(),
        );

        assert_eq!(
            ordered,
            vec![
                "main".to_string(),
                "feature/a".to_string(),
                "feature/z".to_string(),
            ]
        );
    }

    #[test]
    fn missing_project_path_returns_empty_worktree_list() {
        assert!(read_project_worktrees("/path/that/does/not/exist").is_empty());
    }

    #[test]
    fn reads_initialized_git_repository_branch() {
        let repo_dir = unique_temp_dir("project-worktrees-git");
        fs::create_dir_all(&repo_dir).expect("repo dir must create");
        let status = Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(&repo_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("git init must run");
        assert!(status.success(), "git init must succeed");

        assert_eq!(read_project_worktrees(&repo_dir), vec!["main".to_string()]);

        fs::remove_dir_all(repo_dir).expect("repo dir cleanup must succeed");
    }

    fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time must be after UNIX_EPOCH")
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{counter}"))
    }
}
