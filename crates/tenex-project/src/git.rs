use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git command failed: {0}")]
    CommandFailed(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Information about a single git worktree entry.
#[derive(Debug, Clone, PartialEq)]
pub struct WorktreeInfo {
    /// Absolute path to the worktree.
    pub path: PathBuf,
    /// Branch checked out in this worktree. `None` for detached HEAD.
    pub branch: Option<String>,
    /// HEAD commit hash.
    pub commit: String,
    /// `true` for the main (primary) worktree.
    pub is_main: bool,
}

/// Metadata for a git worktree, persisted to disk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorktreeMetadata {
    pub path: String,
    pub branch: String,
    pub created_by: String,
    pub conversation_id: String,
    pub parent_branch: String,
    pub created_at: i64,
    pub merged_at: Option<i64>,
    pub deleted_at: Option<i64>,
}

/// Replaces forward slashes in a branch name with underscores so the name can
/// be used as a single directory component.
fn sanitize_branch_name(branch: &str) -> String {
    branch.replace('/', "_")
}

/// Parse the output of `git worktree list --porcelain` into `WorktreeInfo` entries.
///
/// Format per entry (blank line separates entries):
/// ```text
/// worktree <path>
/// HEAD <hash>
/// branch refs/heads/<name>   <- or "detached"  <- or absent for bare repos
/// ```
pub fn parse_worktree_list(output: &str) -> Vec<WorktreeInfo> {
    let mut result = Vec::new();
    let mut is_first = true;

    // Entries are separated by blank lines.
    for block in output.split("\n\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }

        let mut path: Option<PathBuf> = None;
        let mut commit: Option<String> = None;
        let mut branch: Option<String> = None;
        let mut bare = false;

        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(rest));
            } else if let Some(rest) = line.strip_prefix("HEAD ") {
                commit = Some(rest.to_string());
            } else if let Some(rest) = line.strip_prefix("branch ") {
                let name = rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string();
                branch = Some(name);
            } else if line == "detached" {
                branch = None; // already None; explicit for clarity
            } else if line == "bare" {
                bare = true;
            }
        }

        // Skip bare repos — they have no checked-out branch and are not useful here.
        if bare {
            is_first = false;
            continue;
        }

        if let (Some(p), Some(c)) = (path, commit) {
            result.push(WorktreeInfo {
                path: p,
                branch,
                commit: c,
                is_main: is_first,
            });
            is_first = false;
        }
    }

    result
}

/// Run `git worktree list --porcelain` and return parsed worktree info.
pub fn list_worktrees(repo_path: &Path) -> Result<Vec<WorktreeInfo>, GitError> {
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(GitError::CommandFailed(stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    Ok(parse_worktree_list(&stdout))
}

/// Return the current branch name of `repo_path`.
///
/// Returns `None` when HEAD is detached (i.e. `git rev-parse` outputs `"HEAD"`).
pub fn current_branch(repo_path: &Path) -> Result<Option<String>, GitError> {
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(repo_path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(GitError::CommandFailed(stderr));
    }

    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name == "HEAD" {
        Ok(None)
    } else {
        Ok(Some(name))
    }
}

/// Return `true` when the working tree at `path` has no uncommitted changes
/// (no modified, staged, or untracked files).
///
/// Implemented via `git status --porcelain`: empty stdout ⇔ clean.
pub fn is_worktree_clean(path: &Path) -> Result<bool, GitError> {
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(GitError::CommandFailed(stderr));
    }

    Ok(output.stdout.iter().all(u8::is_ascii_whitespace))
}

/// Resolve `refs/heads/<branch>` to its commit hash. Errors when the branch
/// does not exist locally.
pub fn branch_head_commit(repo_path: &Path, branch: &str) -> Result<String, GitError> {
    let output = Command::new("git")
        .args(["rev-parse", &format!("refs/heads/{branch}")])
        .current_dir(repo_path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(GitError::CommandFailed(stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Resolve `HEAD` to its commit hash within `path` (a worktree or main repo).
fn head_commit(path: &Path) -> Result<String, GitError> {
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(path)
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(GitError::CommandFailed(stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Push `branch` to `origin`, setting upstream on first push.
///
/// We try `git push origin <branch>` first; if the branch has no upstream
/// configured (`fatal: The current branch ... has no upstream`), retry with
/// `-u`. Both succeed silently when the remote already has the same commit.
pub fn push_branch_to_origin(repo_path: &Path, branch: &str) -> Result<(), GitError> {
    let output = Command::new("git")
        .args(["push", "origin", branch])
        .current_dir(repo_path)
        .output()?;
    if output.status.success() {
        return Ok(());
    }

    // Retry with -u to establish upstream when first push for this branch.
    let output = Command::new("git")
        .args(["push", "-u", "origin", branch])
        .current_dir(repo_path)
        .output()?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    Err(GitError::CommandFailed(format!(
        "git push origin {branch} failed: {stderr}"
    )))
}

/// Fetch `branch` from `origin`. Best-effort: returns `Ok(())` when the
/// remote does not yet have the branch (first-time receive on a host).
pub fn fetch_branch_from_origin(repo_path: &Path, branch: &str) -> Result<(), GitError> {
    let output = Command::new("git")
        .args(["fetch", "origin", branch])
        .current_dir(repo_path)
        .output()?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    Err(GitError::CommandFailed(format!(
        "git fetch origin {branch} failed: {stderr}"
    )))
}

/// Hard-reset the worktree at `path` to `commit`. Caller is responsible for
/// confirming the worktree is clean — this discards any working-tree state.
pub fn reset_worktree_to_commit(path: &Path, commit: &str) -> Result<(), GitError> {
    let status = Command::new("git")
        .args(["reset", "--hard", commit])
        .current_dir(path)
        .status()?;
    if !status.success() {
        return Err(GitError::CommandFailed(format!(
            "git reset --hard {commit} failed in {}",
            path.display()
        )));
    }
    Ok(())
}

/// Sync the worktree at `path` to `expected_commit`.
///
/// 1. Fetch `branch` from origin (so the commit is locally available).
/// 2. If HEAD already matches, no-op.
/// 3. Else require the worktree to be clean and `git reset --hard` to the
///    expected commit. A dirty worktree is a hard error — the delegation flow
///    refuses to clobber in-progress work.
pub fn sync_worktree_to_commit(
    path: &Path,
    branch: &str,
    expected_commit: &str,
) -> Result<(), GitError> {
    // Best-effort fetch — failure is fine if origin lacks the branch and the
    // commit is already present locally; we'll catch missing commits at reset.
    let _ = fetch_branch_from_origin(path, branch);

    let head = head_commit(path)?;
    if head == expected_commit {
        return Ok(());
    }

    if !is_worktree_clean(path)? {
        return Err(GitError::CommandFailed(format!(
            "worktree {} is dirty; refusing to sync branch '{branch}' to commit {expected_commit}",
            path.display()
        )));
    }

    reset_worktree_to_commit(path, expected_commit)
}

/// Returns `true` if the branch already exists as a local ref.
fn branch_exists_locally(repo_path: &Path, branch: &str) -> bool {
    Command::new("git")
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .current_dir(repo_path)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Create (or reuse) a worktree at `{repo_path}/.worktrees/{sanitized_branch}`.
///
/// - If the branch already exists locally: `git worktree add <path> <branch>`
/// - Otherwise: `git worktree add -b <branch> <path> <base>` (base defaults to `HEAD`)
///
/// Returns the `WorktreeInfo` for the newly created (or already-existing) worktree.
pub fn create_worktree(
    repo_path: &Path,
    branch: &str,
    base_branch: Option<&str>,
) -> Result<WorktreeInfo, GitError> {
    let sanitized = sanitize_branch_name(branch);
    let worktree_path = repo_path.join(".worktrees").join(&sanitized);

    // If already registered, return immediately.
    let existing = list_worktrees(repo_path)?;
    if let Some(info) = existing
        .into_iter()
        .find(|w| w.branch.as_deref() == Some(branch))
    {
        return Ok(info);
    }

    std::fs::create_dir_all(repo_path.join(".worktrees"))?;

    let status = if branch_exists_locally(repo_path, branch) {
        Command::new("git")
            .args([
                "worktree",
                "add",
                worktree_path.to_str().unwrap_or_default(),
                branch,
            ])
            .current_dir(repo_path)
            .status()?
    } else {
        let base = base_branch.unwrap_or("HEAD");
        Command::new("git")
            .args([
                "worktree",
                "add",
                "-b",
                branch,
                worktree_path.to_str().unwrap_or_default(),
                base,
            ])
            .current_dir(repo_path)
            .status()?
    };

    if !status.success() {
        return Err(GitError::CommandFailed(format!(
            "git worktree add failed for branch '{branch}'"
        )));
    }

    // Return fresh info from the new worktree list.
    list_worktrees(repo_path)?
        .into_iter()
        .find(|w| w.branch.as_deref() == Some(branch))
        .ok_or_else(|| {
            GitError::CommandFailed(format!(
                "worktree for branch '{branch}' not found after creation"
            ))
        })
}

/// Resolve the working directory and current branch for an agent startup.
///
/// If `branch_tag` is `None`, the agent runs in the project root and the
/// current branch is read from there. If `branch_tag` is `Some(branch)`, an
/// existing worktree for that branch is reused; if none exists, one is created
/// under `{repo_path}/.worktrees/<sanitized>`. On worktree creation failure
/// the function falls back to the project root.
///
/// When `commit_tag` is set alongside `branch_tag`, the worktree is fetched
/// and synced to that commit (see [`sync_worktree_to_commit`]). Sync failures
/// — e.g. a dirty worktree, or a commit not reachable on the local remote —
/// are logged at error level and the worktree is returned as-is; the caller's
/// environment will surface the divergence to the agent.
///
/// Returns `(working_directory, current_branch)`.
pub fn resolve_working_dir(
    project_base: &Path,
    branch_tag: Option<&str>,
    commit_tag: Option<&str>,
) -> (PathBuf, Option<String>) {
    let Some(branch) = branch_tag else {
        let current = current_branch(project_base).ok().flatten();
        return (project_base.to_owned(), current);
    };

    match create_worktree(project_base, branch, None) {
        Ok(wt) => {
            if let Some(commit) = commit_tag {
                if let Err(e) = sync_worktree_to_commit(&wt.path, branch, commit) {
                    tracing::error!(
                        "failed to sync worktree for branch {branch} to commit {commit}: {e}"
                    );
                }
            }
            (wt.path, Some(branch.to_owned()))
        }
        Err(e) => {
            tracing::warn!(
                "failed to create worktree for branch {branch}: {e}, falling back to project root"
            );
            let current = current_branch(project_base).ok().flatten();
            (project_base.to_owned(), current)
        }
    }
}

// ─── Metadata persistence ────────────────────────────────────────────────────

pub struct WorktreeMetadataStore;

impl WorktreeMetadataStore {
    fn metadata_path(base_dir: &Path, project_dtag: &str) -> PathBuf {
        base_dir
            .join("projects")
            .join(project_dtag)
            .join("worktrees.json")
    }

    pub fn load(base_dir: &Path, project_dtag: &str) -> Result<Vec<WorktreeMetadata>, GitError> {
        let path = Self::metadata_path(base_dir, project_dtag);
        match std::fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).map_err(|e| {
                GitError::CommandFailed(format!("failed to parse worktrees.json: {e}"))
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(GitError::Io(e)),
        }
    }

    /// Atomic write: serialize to a `.tmp` sibling then rename.
    pub fn save(
        base_dir: &Path,
        project_dtag: &str,
        entries: &[WorktreeMetadata],
    ) -> Result<(), GitError> {
        let path = Self::metadata_path(base_dir, project_dtag);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        let content = serde_json::to_string_pretty(entries)
            .map_err(|e| GitError::CommandFailed(format!("failed to serialize worktrees: {e}")))?;
        std::fs::write(&tmp, content)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Load, append if not already present (matched by path), save.
    pub fn track_creation(
        base_dir: &Path,
        project_dtag: &str,
        metadata: WorktreeMetadata,
    ) -> Result<(), GitError> {
        let mut entries = Self::load(base_dir, project_dtag)?;
        if !entries.iter().any(|e| e.path == metadata.path) {
            entries.push(metadata);
            Self::save(base_dir, project_dtag, &entries)?;
        }
        Ok(())
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::TempDir;

    // ── parse_worktree_list fixture tests ──────────────────────────────────

    fn main_only_output() -> &'static str {
        "worktree /home/user/repo\nHEAD abc123def456\nbranch refs/heads/main\n"
    }

    fn two_worktrees_output() -> &'static str {
        "worktree /home/user/repo\n\
         HEAD abc123def456\n\
         branch refs/heads/main\n\
         \n\
         worktree /home/user/repo/.worktrees/feature_auth\n\
         HEAD 111222333444\n\
         branch refs/heads/feature/auth\n"
    }

    fn detached_worktree_output() -> &'static str {
        "worktree /home/user/repo\n\
         HEAD abc123def456\n\
         branch refs/heads/main\n\
         \n\
         worktree /home/user/repo/.worktrees/detached\n\
         HEAD deadbeefcafe\n\
         detached\n"
    }

    fn bare_repo_output() -> &'static str {
        "worktree /home/user/repo.git\n\
         HEAD abc123\n\
         bare\n\
         \n\
         worktree /home/user/repo/.worktrees/feature\n\
         HEAD 999888777\n\
         branch refs/heads/feature\n"
    }

    #[test]
    fn parse_single_main_worktree() {
        let worktrees = parse_worktree_list(main_only_output());
        assert_eq!(worktrees.len(), 1);
        let w = &worktrees[0];
        assert_eq!(w.path, PathBuf::from("/home/user/repo"));
        assert_eq!(w.branch.as_deref(), Some("main"));
        assert_eq!(w.commit, "abc123def456");
        assert!(w.is_main);
    }

    #[test]
    fn parse_two_worktrees_first_is_main() {
        let worktrees = parse_worktree_list(two_worktrees_output());
        assert_eq!(worktrees.len(), 2);

        let main = &worktrees[0];
        assert!(main.is_main);
        assert_eq!(main.branch.as_deref(), Some("main"));

        let feat = &worktrees[1];
        assert!(!feat.is_main);
        assert_eq!(feat.branch.as_deref(), Some("feature/auth"));
        assert_eq!(
            feat.path,
            PathBuf::from("/home/user/repo/.worktrees/feature_auth")
        );
    }

    #[test]
    fn parse_detached_head_gives_none_branch() {
        let worktrees = parse_worktree_list(detached_worktree_output());
        assert_eq!(worktrees.len(), 2);
        let detached = &worktrees[1];
        assert!(detached.branch.is_none());
        assert_eq!(detached.commit, "deadbeefcafe");
    }

    #[test]
    fn parse_bare_repo_skipped() {
        // The bare entry is skipped; the linked worktree is not main
        // because we track `is_first` including skipped entries.
        let worktrees = parse_worktree_list(bare_repo_output());
        // Bare entry skipped, feature worktree remains but is_main=false
        assert_eq!(worktrees.len(), 1);
        assert!(!worktrees[0].is_main);
        assert_eq!(worktrees[0].branch.as_deref(), Some("feature"));
    }

    // ── Helpers for real-git tests ─────────────────────────────────────────

    fn init_repo(dir: &Path) {
        for (args, msg) in [
            (vec!["init"], "git init failed"),
            (
                vec!["config", "user.email", "test@test.com"],
                "set email failed",
            ),
            (vec!["config", "user.name", "Test"], "set name failed"),
            (
                vec!["config", "commit.gpgsign", "false"],
                "disable gpgsign failed",
            ),
        ] {
            let status = Command::new("git")
                .args(&args)
                .current_dir(dir)
                .status()
                .expect(msg);
            assert!(status.success(), "{}", msg);
        }
        // Create a first commit so HEAD exists.
        std::fs::write(dir.join("README.md"), "init").unwrap();
        for (args, msg) in [
            (vec!["add", "."], "git add failed"),
            (vec!["commit", "-m", "init"], "git commit failed"),
        ] {
            let status = Command::new("git")
                .args(&args)
                .current_dir(dir)
                .status()
                .expect(msg);
            assert!(status.success(), "{}", msg);
        }
    }

    // ── current_branch tests ───────────────────────────────────────────────

    #[test]
    fn current_branch_returns_branch_name() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        let branch = current_branch(dir.path()).unwrap();
        // Git may default to "main" or "master"
        assert!(branch.is_some());
        let name = branch.unwrap();
        assert!(name == "main" || name == "master");
    }

    #[test]
    fn current_branch_detached_returns_none() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        // Get current commit hash and detach HEAD.
        let output = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Command::new("git")
            .args(["checkout", "--detach", &hash])
            .current_dir(dir.path())
            .status()
            .unwrap();
        let branch = current_branch(dir.path()).unwrap();
        assert!(branch.is_none());
    }

    // ── is_worktree_clean / branch_head_commit tests ──────────────────────

    #[test]
    fn is_worktree_clean_reports_dirty_after_untracked_file() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        assert!(is_worktree_clean(dir.path()).unwrap());
        std::fs::write(dir.path().join("untracked.txt"), "x").unwrap();
        assert!(!is_worktree_clean(dir.path()).unwrap());
    }

    #[test]
    fn branch_head_commit_matches_rev_parse() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        let head = current_branch(dir.path()).unwrap().unwrap();
        let via_helper = branch_head_commit(dir.path(), &head).unwrap();
        let via_git = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let expected = String::from_utf8_lossy(&via_git.stdout).trim().to_string();
        assert_eq!(via_helper, expected);
    }

    #[test]
    fn branch_head_commit_errors_for_missing_branch() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        assert!(branch_head_commit(dir.path(), "no-such-branch").is_err());
    }

    // ── create_worktree tests ─────────────────────────────────────────────

    #[test]
    fn create_worktree_new_branch() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        let info = create_worktree(dir.path(), "feature/test", None).unwrap();
        assert_eq!(info.branch.as_deref(), Some("feature/test"));
        assert!(info.path.exists());
        let expected = dir.path().join(".worktrees").join("feature_test");
        assert_eq!(info.path, expected);
    }

    #[test]
    fn create_worktree_idempotent() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        let info1 = create_worktree(dir.path(), "feature/dup", None).unwrap();
        let info2 = create_worktree(dir.path(), "feature/dup", None).unwrap();
        assert_eq!(info1.path, info2.path);
    }

    #[test]
    fn create_worktree_existing_branch() {
        let dir = TempDir::new().unwrap();
        init_repo(dir.path());
        // Create the branch first without creating a worktree.
        let status = Command::new("git")
            .args(["branch", "existing-branch"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        assert!(status.success());
        let info = create_worktree(dir.path(), "existing-branch", None).unwrap();
        assert_eq!(info.branch.as_deref(), Some("existing-branch"));
        assert!(info.path.exists());
    }

    // ── WorktreeMetadataStore tests ────────────────────────────────────────

    fn make_metadata(path: &str) -> WorktreeMetadata {
        WorktreeMetadata {
            path: path.to_string(),
            branch: "feature/x".to_string(),
            created_by: "deadbeef".to_string(),
            conversation_id: "cafebabe".to_string(),
            parent_branch: "main".to_string(),
            created_at: 1_000_000,
            merged_at: None,
            deleted_at: None,
        }
    }

    #[test]
    fn metadata_load_missing_returns_empty() {
        let dir = TempDir::new().unwrap();
        let entries = WorktreeMetadataStore::load(dir.path(), "my-project").unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn metadata_save_and_load_roundtrip() {
        let dir = TempDir::new().unwrap();
        let m = make_metadata("/repo/.worktrees/feature_x");
        WorktreeMetadataStore::save(dir.path(), "proj", &[m.clone()]).unwrap();
        let loaded = WorktreeMetadataStore::load(dir.path(), "proj").unwrap();
        assert_eq!(loaded, vec![m]);
    }

    #[test]
    fn metadata_track_creation_appends() {
        let dir = TempDir::new().unwrap();
        let m1 = make_metadata("/repo/.worktrees/feat_a");
        let m2 = make_metadata("/repo/.worktrees/feat_b");
        WorktreeMetadataStore::track_creation(dir.path(), "proj", m1.clone()).unwrap();
        WorktreeMetadataStore::track_creation(dir.path(), "proj", m2.clone()).unwrap();
        let loaded = WorktreeMetadataStore::load(dir.path(), "proj").unwrap();
        assert_eq!(loaded.len(), 2);
    }

    #[test]
    fn metadata_track_creation_idempotent() {
        let dir = TempDir::new().unwrap();
        let m = make_metadata("/repo/.worktrees/feat_a");
        WorktreeMetadataStore::track_creation(dir.path(), "proj", m.clone()).unwrap();
        WorktreeMetadataStore::track_creation(dir.path(), "proj", m.clone()).unwrap();
        let loaded = WorktreeMetadataStore::load(dir.path(), "proj").unwrap();
        assert_eq!(loaded.len(), 1);
    }
}
