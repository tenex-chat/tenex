use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use thiserror::Error;
use tracing;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectRepositoryInitAction {
    AlreadyGit,
    GitInit,
    GitClone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepositoryInitOutcome {
    pub project_d_tag: String,
    pub project_base_path: PathBuf,
    pub action: ProjectRepositoryInitAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_url: Option<String>,
}

#[derive(Debug, Error)]
pub enum ProjectRepositoryInitError {
    #[error("failed to create project directory {path:?}: {source}")]
    CreateProjectDir { path: PathBuf, source: io::Error },
    #[error("failed to inspect project directory {path:?}: {source}")]
    InspectProjectDir { path: PathBuf, source: io::Error },
    #[error("git command `{command}` failed in {cwd:?}: {detail}")]
    GitCommandFailed {
        command: String,
        cwd: PathBuf,
        detail: String,
    },
}

/// Ensures the project repository at `project_base_path` is initialised.
/// Callers supply the base path (derived from `projectsBase` + d-tag) and
/// the optional repo URL (from the 31933 event's `repo` tag); there is no
/// descriptor file to read.
pub fn ensure_project_repository_on_boot(
    project_d_tag: &str,
    project_base_path: &Path,
    repo_url: Option<&str>,
) -> Result<ProjectRepositoryInitOutcome, ProjectRepositoryInitError> {
    let repo_url = repo_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let action = if is_git_repository(project_base_path) {
        ProjectRepositoryInitAction::AlreadyGit
    } else if repo_url.is_some() && project_dir_is_cloneable(project_base_path)? {
        clone_project_repository(
            repo_url.as_deref().expect("repo_url checked"),
            project_base_path,
        )?
    } else {
        init_project_repository(project_base_path)?
    };

    tracing::info!(
        project_d_tag = %project_d_tag,
        project_base_path = %project_base_path.display(),
        repo_url = ?repo_url,
        action = ?action,
        "project repository ready"
    );

    Ok(ProjectRepositoryInitOutcome {
        project_d_tag: project_d_tag.to_string(),
        project_base_path: project_base_path.to_path_buf(),
        action,
        repo_url,
    })
}

fn project_dir_is_cloneable(path: &Path) -> Result<bool, ProjectRepositoryInitError> {
    match fs::read_dir(path) {
        Ok(mut entries) => Ok(entries.next().is_none()),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(source) => Err(ProjectRepositoryInitError::InspectProjectDir {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn init_project_repository(
    project_base_path: &Path,
) -> Result<ProjectRepositoryInitAction, ProjectRepositoryInitError> {
    fs::create_dir_all(project_base_path).map_err(|source| {
        ProjectRepositoryInitError::CreateProjectDir {
            path: project_base_path.to_path_buf(),
            source,
        }
    })?;
    run_git_command(project_base_path, ["init"])?;
    Ok(ProjectRepositoryInitAction::GitInit)
}

fn clone_project_repository(
    repo_url: &str,
    project_base_path: &Path,
) -> Result<ProjectRepositoryInitAction, ProjectRepositoryInitError> {
    if let Some(parent) = project_base_path.parent() {
        fs::create_dir_all(parent).map_err(|source| {
            ProjectRepositoryInitError::CreateProjectDir {
                path: parent.to_path_buf(),
                source,
            }
        })?;
    }
    let parent = project_base_path.parent().unwrap_or_else(|| Path::new("."));
    let target = project_base_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_else(|| project_base_path.as_os_str().to_str().unwrap_or(""));
    run_git_command(parent, ["clone", repo_url, target])?;
    Ok(ProjectRepositoryInitAction::GitClone)
}

fn is_git_repository(project_base_path: &Path) -> bool {
    Command::new("git")
        .arg("rev-parse")
        .arg("--git-dir")
        .current_dir(project_base_path)
        .output()
        .is_ok_and(|output| output.status.success())
}

fn run_git_command<const N: usize>(
    cwd: &Path,
    args: [&str; N],
) -> Result<(), ProjectRepositoryInitError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|source| ProjectRepositoryInitError::GitCommandFailed {
            command: git_command_display(&args),
            cwd: cwd.to_path_buf(),
            detail: source.to_string(),
        })?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        output.status.to_string()
    };
    Err(ProjectRepositoryInitError::GitCommandFailed {
        command: git_command_display(&args),
        cwd: cwd.to_path_buf(),
        detail,
    })
}

fn git_command_display(args: &[&str]) -> String {
    let mut parts = vec!["git".to_string()];
    parts.extend(args.iter().map(|arg| (*arg).to_string()));
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn boot_initializes_missing_project_git_repository() {
        let temp = tempdir().expect("temp dir");
        let project_path = temp.path().join("work").join("demo");

        let outcome = ensure_project_repository_on_boot("demo", &project_path, None).expect("init");

        assert_eq!(outcome.action, ProjectRepositoryInitAction::GitInit);
        assert!(project_path.join(".git").exists());
        assert_eq!(outcome.project_base_path, project_path);
    }

    #[test]
    fn boot_keeps_existing_git_repository() {
        let temp = tempdir().expect("temp dir");
        let project_path = temp.path().join("work").join("demo");
        fs::create_dir_all(&project_path).expect("project dir");
        run_git_command(&project_path, ["init"]).expect("git init");

        let outcome = ensure_project_repository_on_boot("demo", &project_path, None).expect("init");

        assert_eq!(outcome.action, ProjectRepositoryInitAction::AlreadyGit);
    }

    #[test]
    fn boot_clones_repo_tag_into_empty_project_directory() {
        let temp = tempdir().expect("temp dir");
        let source = temp.path().join("source");
        fs::create_dir_all(&source).expect("source dir");
        run_git_command(&source, ["init"]).expect("source git init");
        let project_path = temp.path().join("work").join("demo");

        let outcome = ensure_project_repository_on_boot(
            "demo",
            &project_path,
            Some(source.to_str().expect("source path utf8")),
        )
        .expect("clone");

        assert_eq!(outcome.action, ProjectRepositoryInitAction::GitClone);
        assert!(project_path.join(".git").exists());
    }
}
