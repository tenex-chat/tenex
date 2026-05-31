//! Project-local `.tenex-hooks.json` shell commands that fire at `pre-execute`,
//! `pre-tool`, and `post-tool` boundaries.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Maximum wall-clock time a single hook process may run before it is
/// abandoned. A flaky hook must never wedge the agent.
const HOOK_TIMEOUT: Duration = Duration::from_secs(30);

/// File name read from the agent's workspace directory.
pub const PROJECT_HOOKS_FILE_NAME: &str = ".tenex-hooks.json";

/// Agent lifecycle boundary a hook subscribes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    /// Fires once at agent bootstrap, before the first LLM call. Stdout is
    /// injected into the system prompt. Non-zero exit is logged and ignored
    /// (the agent still runs).
    PreExecute,
    PreTool,
    PostTool,
}

impl HookEvent {
    /// The string written into the hook's stdin `event` field, matching the
    /// Claude Code hook vocabulary.
    fn wire_name(self) -> &'static str {
        match self {
            HookEvent::PreExecute => "pre-execute",
            HookEvent::PreTool => "pre-tool",
            HookEvent::PostTool => "post-tool",
        }
    }
}

/// One configured hook: a named shell command subscribed to a set of events.
#[derive(Debug, Clone)]
pub struct HookEntry {
    pub name: String,
    pub command: Vec<String>,
    pub events: Vec<HookEvent>,
}

impl HookEntry {
    fn subscribes_to(&self, event: HookEvent) -> bool {
        self.events.contains(&event)
    }
}

/// Parsed `.tenex-hooks.json` contents.
#[derive(Debug, Clone, Default)]
pub struct ProjectHooksConfig {
    pub hooks: Vec<HookEntry>,
}

#[derive(Debug, Deserialize)]
struct RawProjectHooksConfig {
    #[serde(default)]
    hooks: Vec<RawHookEntry>,
}

#[derive(Debug, Deserialize)]
struct RawHookEntry {
    name: String,
    command: Vec<String>,
    events: Vec<String>,
}

impl ProjectHooksConfig {
    /// Load `.tenex-hooks.json` from `working_dir`. A missing file yields an
    /// empty config; a malformed file is a hard error (matching the
    /// `tenex-mcp` project-config pattern).
    pub fn load(working_dir: &Path) -> Result<Self> {
        let path = working_dir.join(PROJECT_HOOKS_FILE_NAME);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        let raw: RawProjectHooksConfig = serde_json::from_slice(&bytes)
            .with_context(|| format!("parsing {}", path.display()))?;
        Self::from_raw(raw, &path)
    }

    fn from_raw(raw: RawProjectHooksConfig, path: &Path) -> Result<Self> {
        let mut hooks = Vec::with_capacity(raw.hooks.len());
        for hook in raw.hooks {
            if hook.name.trim().is_empty() {
                anyhow::bail!("hook name cannot be empty in {}", path.display());
            }
            if hook.command.is_empty() {
                anyhow::bail!("hook '{}' has an empty command", hook.name);
            }
            let mut events = Vec::with_capacity(hook.events.len());
            for event in &hook.events {
                let parsed = match event.as_str() {
                    "pre-execute" => HookEvent::PreExecute,
                    "pre-tool" => HookEvent::PreTool,
                    "post-tool" => HookEvent::PostTool,
                    other => anyhow::bail!(
                        "hook '{}' subscribes to unsupported event '{}'; supported events are 'pre-execute', 'pre-tool', and 'post-tool'",
                        hook.name,
                        other
                    ),
                };
                events.push(parsed);
            }
            if events.is_empty() {
                anyhow::bail!("hook '{}' subscribes to no events", hook.name);
            }
            hooks.push(HookEntry {
                name: hook.name,
                command: hook.command,
                events,
            });
        }
        Ok(Self { hooks })
    }

    pub fn is_empty(&self) -> bool {
        self.hooks.is_empty()
    }
}

/// Outcome of firing all `pre-tool` hooks for a single tool call.
#[derive(Debug, PartialEq, Eq)]
pub enum PreToolOutcome {
    /// No hook blocked the call. Any stdout the hooks produced is collected
    /// here for injection into the next LLM call.
    Continue { injections: Vec<String> },
    /// A hook blocked the call; the contained string is the reason surfaced
    /// to the model as the tool result.
    Block(String),
}

/// Spawns and drives project hooks at tool-call boundaries. Owns the workspace
/// directory used as the hooks' cwd and the parsed hook entries.
pub struct ProjectHooksRunner {
    hooks: Vec<HookEntry>,
    working_dir: PathBuf,
    /// Conversation id, surfaced to hooks as the Claude Code `session_id`.
    session_id: String,
    /// The conversation's root user message, surfaced to hooks as the Claude
    /// Code `prompt`. Stable across re-engagements within the conversation.
    prompt: String,
}

impl ProjectHooksRunner {
    pub fn new(
        config: ProjectHooksConfig,
        working_dir: PathBuf,
        session_id: String,
        prompt: String,
    ) -> Self {
        Self {
            hooks: config.hooks,
            working_dir,
            session_id,
            prompt,
        }
    }

    /// Fire every `pre-execute` hook once at agent bootstrap. Non-zero exit is
    /// logged and ignored — the agent still runs. Stdout on exit 0 is collected
    /// and returned for injection into the system prompt.
    pub async fn fire_pre_execute(&self) -> Vec<String> {
        let stdin = self.pre_execute_stdin();
        let mut injections = Vec::new();
        for hook in self.hooks.iter().filter(|h| h.subscribes_to(HookEvent::PreExecute)) {
            match self.run_hook(hook, &stdin).await {
                HookRun::Completed { exit_ok, stdout, .. } => {
                    if exit_ok {
                        if !stdout.is_empty() {
                            injections.push(stdout);
                        }
                    } else {
                        eprintln!(
                            "[tenex-agent] warn: pre-execute hook '{}' exited non-zero; continuing",
                            hook.name
                        );
                    }
                }
                HookRun::TimedOut => {
                    eprintln!(
                        "[tenex-agent] warn: pre-execute hook '{}' timed out after {}s; continuing",
                        hook.name,
                        HOOK_TIMEOUT.as_secs()
                    );
                }
                HookRun::SpawnFailed(e) => {
                    eprintln!(
                        "[tenex-agent] warn: pre-execute hook '{}' could not run: {e}; continuing",
                        hook.name
                    );
                }
            }
        }
        injections
    }

    /// Fire every `pre-tool` hook in order. The first hook to exit non-zero
    /// blocks the tool call. Hooks that exit 0 with stdout contribute an
    /// injection. A hook that times out is treated as non-blocking.
    pub async fn fire_pre_tool(&self, tool_name: &str, args_json: &str) -> PreToolOutcome {
        let stdin = self.pre_tool_stdin(tool_name, args_json);
        let mut injections = Vec::new();
        for hook in self.hooks.iter().filter(|h| h.subscribes_to(HookEvent::PreTool)) {
            match self.run_hook(hook, &stdin).await {
                HookRun::Completed {
                    exit_ok,
                    stdout,
                    stderr,
                } => {
                    if exit_ok {
                        if !stdout.is_empty() {
                            injections.push(stdout);
                        }
                    } else {
                        // A blocking hook explains itself on stderr; fall back
                        // to a generic message when it stays silent.
                        let reason = if stderr.is_empty() {
                            format!("Tool call blocked by project hook '{}'", hook.name)
                        } else {
                            stderr
                        };
                        return PreToolOutcome::Block(reason);
                    }
                }
                HookRun::TimedOut => {
                    eprintln!(
                        "[tenex-agent] warn: pre-tool hook '{}' timed out after {}s; continuing",
                        hook.name,
                        HOOK_TIMEOUT.as_secs()
                    );
                }
                HookRun::SpawnFailed(e) => {
                    return PreToolOutcome::Block(format!(
                        "pre-tool hook '{}' could not run: {e}",
                        hook.name
                    ));
                }
            }
        }
        PreToolOutcome::Continue { injections }
    }

    /// Fire every `post-tool` hook in order. The tool has already run, so a
    /// non-zero exit cannot abort it — it is logged and ignored. Stdout on a
    /// successful exit contributes an injection.
    pub async fn fire_post_tool(
        &self,
        tool_name: &str,
        args_json: &str,
        result: &str,
    ) -> Vec<String> {
        let stdin = self.post_tool_stdin(tool_name, args_json, result);
        let mut injections = Vec::new();
        for hook in self.hooks.iter().filter(|h| h.subscribes_to(HookEvent::PostTool)) {
            match self.run_hook(hook, &stdin).await {
                HookRun::Completed {
                    exit_ok,
                    stdout,
                    stderr: _,
                } => {
                    if exit_ok {
                        if !stdout.is_empty() {
                            injections.push(stdout);
                        }
                    } else {
                        eprintln!(
                            "[tenex-agent] warn: post-tool hook '{}' exited non-zero; the tool already ran so the failure is ignored",
                            hook.name
                        );
                    }
                }
                HookRun::TimedOut => {
                    eprintln!(
                        "[tenex-agent] warn: post-tool hook '{}' timed out after {}s",
                        hook.name,
                        HOOK_TIMEOUT.as_secs()
                    );
                }
                HookRun::SpawnFailed(e) => {
                    eprintln!(
                        "[tenex-agent] warn: post-tool hook '{}' failed to run: {e}",
                        hook.name
                    );
                }
            }
        }
        injections
    }

    /// Spawn one hook, feed it `stdin`, and capture its exit status + stdout,
    /// bounded by [`HOOK_TIMEOUT`]. stderr is forwarded to the agent's stderr
    /// for operator visibility.
    async fn run_hook(&self, hook: &HookEntry, stdin: &str) -> HookRun {
        let (program, rest) = hook.command.split_first().expect("config rejects empty command");
        let mut command = Command::new(program);
        command
            .args(rest)
            .current_dir(&self.working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // On timeout the wait future is dropped; without this the OS
            // process would be detached and orphaned.
            .kill_on_drop(true);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => return HookRun::SpawnFailed(e.to_string()),
        };

        if let Some(mut child_stdin) = child.stdin.take() {
            if let Err(e) = child_stdin.write_all(stdin.as_bytes()).await {
                return HookRun::SpawnFailed(format!("writing hook stdin: {e}"));
            }
            // Drop closes the pipe so the hook sees EOF.
            drop(child_stdin);
        }

        match tokio::time::timeout(HOOK_TIMEOUT, child.wait_with_output()).await {
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                if !stderr.is_empty() {
                    eprintln!("[tenex-agent] hook '{}' stderr: {stderr}", hook.name);
                }
                HookRun::Completed {
                    exit_ok: output.status.success(),
                    stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
                    stderr,
                }
            }
            Ok(Err(e)) => HookRun::SpawnFailed(format!("awaiting hook: {e}")),
            Err(_) => HookRun::TimedOut,
        }
    }

    /// Build the `pre-execute` stdin payload. Matches the Claude Code
    /// `UserPromptSubmit` hook schema so tools like `proactive-context inject`
    /// work without adaptation.
    fn pre_execute_stdin(&self) -> String {
        let payload = serde_json::json!({
            "event": HookEvent::PreExecute.wire_name(),
            "session_id": self.session_id,
            "cwd": self.working_dir.to_string_lossy(),
            "transcript_path": serde_json::Value::Null,
            "prompt": self.prompt,
        });
        payload.to_string()
    }

    /// Build the `pre-tool` stdin payload. `args_json` is the tool's argument
    /// string; it is embedded as parsed JSON when valid, else as a JSON string.
    /// The `session_id`, `cwd`, `transcript_path`, and `prompt` fields make the
    /// payload Claude Code-compatible; `transcript_path` is always `null`
    /// because TENEX persists transcripts in SQLite, not a JSONL file.
    fn pre_tool_stdin(&self, tool_name: &str, args_json: &str) -> String {
        let payload = serde_json::json!({
            "event": HookEvent::PreTool.wire_name(),
            "tool": tool_name,
            "args": parse_args(args_json),
            "session_id": self.session_id,
            "cwd": self.working_dir.to_string_lossy(),
            "transcript_path": serde_json::Value::Null,
            "prompt": self.prompt,
        });
        payload.to_string()
    }

    /// Build the `post-tool` stdin payload, carrying the tool's textual result
    /// alongside the same Claude Code-compatible fields as the `pre-tool`
    /// payload.
    fn post_tool_stdin(&self, tool_name: &str, args_json: &str, result: &str) -> String {
        let payload = serde_json::json!({
            "event": HookEvent::PostTool.wire_name(),
            "tool": tool_name,
            "args": parse_args(args_json),
            "result": result,
            "session_id": self.session_id,
            "cwd": self.working_dir.to_string_lossy(),
            "transcript_path": serde_json::Value::Null,
            "prompt": self.prompt,
        });
        payload.to_string()
    }
}

/// Internal result of running one hook process.
enum HookRun {
    Completed {
        exit_ok: bool,
        stdout: String,
        stderr: String,
    },
    TimedOut,
    SpawnFailed(String),
}

/// Parse a tool's argument string into JSON. A non-JSON string is wrapped as a
/// JSON string so the `args` field is always present and well-formed.
fn parse_args(args_json: &str) -> serde_json::Value {
    serde_json::from_str(args_json)
        .unwrap_or_else(|_| serde_json::Value::String(args_json.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_config(dir: &Path, body: &str) {
        std::fs::write(dir.join(PROJECT_HOOKS_FILE_NAME), body).unwrap();
    }

    #[test]
    fn missing_file_yields_empty_config() {
        let tmp = tempfile::tempdir().unwrap();
        let config = ProjectHooksConfig::load(tmp.path()).unwrap();
        assert!(config.is_empty());
    }

    #[test]
    fn malformed_json_is_hard_error() {
        let tmp = tempfile::tempdir().unwrap();
        write_config(tmp.path(), "{ not json");
        assert!(ProjectHooksConfig::load(tmp.path()).is_err());
    }

    #[test]
    fn parses_hook_entries() {
        let tmp = tempfile::tempdir().unwrap();
        write_config(
            tmp.path(),
            r#"{"hooks":[{"name":"guard","command":["./guard.sh"],"events":["pre-tool","post-tool"]}]}"#,
        );
        let config = ProjectHooksConfig::load(tmp.path()).unwrap();
        assert_eq!(config.hooks.len(), 1);
        let hook = &config.hooks[0];
        assert_eq!(hook.name, "guard");
        assert_eq!(hook.command, vec!["./guard.sh"]);
        assert!(hook.subscribes_to(HookEvent::PreTool));
        assert!(hook.subscribes_to(HookEvent::PostTool));
    }

    #[test]
    fn rejects_unsupported_event() {
        let tmp = tempfile::tempdir().unwrap();
        write_config(
            tmp.path(),
            r#"{"hooks":[{"name":"x","command":["true"],"events":["pre-execute"]}]}"#,
        );
        assert!(ProjectHooksConfig::load(tmp.path()).is_err());
    }

    #[test]
    fn rejects_empty_command() {
        let tmp = tempfile::tempdir().unwrap();
        write_config(
            tmp.path(),
            r#"{"hooks":[{"name":"x","command":[],"events":["pre-tool"]}]}"#,
        );
        assert!(ProjectHooksConfig::load(tmp.path()).is_err());
    }

    #[tokio::test]
    async fn pre_tool_block_on_nonzero_exit() {
        let tmp = tempfile::tempdir().unwrap();
        let config = ProjectHooksConfig {
            hooks: vec![HookEntry {
                name: "block-shell".into(),
                command: vec![
                    "sh".into(),
                    "-c".into(),
                    // Block when the tool is `shell`, otherwise allow.
                    "if grep -q '\"tool\":\"shell\"'; then printf hook-blocked >&2; exit 1; fi"
                        .into(),
                ],
                events: vec![HookEvent::PreTool],
            }],
        };
        let runner = ProjectHooksRunner::new(
            config,
            tmp.path().to_path_buf(),
            "test-session".into(),
            "test prompt".into(),
        );

        let blocked = runner.fire_pre_tool("shell", r#"{"command":"ls"}"#).await;
        // The block reason must surface the hook's stderr, not a generic
        // fallback, so the model learns why the call was denied.
        match blocked {
            PreToolOutcome::Block(reason) => assert_eq!(reason, "hook-blocked"),
            other => panic!("expected block, got {other:?}"),
        }

        let allowed = runner.fire_pre_tool("fs_read", r#"{"path":"a"}"#).await;
        assert_eq!(allowed, PreToolOutcome::Continue { injections: vec![] });
    }

    #[tokio::test]
    async fn pre_tool_block_without_stderr_uses_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let config = ProjectHooksConfig {
            hooks: vec![HookEntry {
                name: "silent-block".into(),
                command: vec!["sh".into(), "-c".into(), "exit 1".into()],
                events: vec![HookEvent::PreTool],
            }],
        };
        let runner = ProjectHooksRunner::new(
            config,
            tmp.path().to_path_buf(),
            "test-session".into(),
            "test prompt".into(),
        );
        match runner.fire_pre_tool("shell", "{}").await {
            PreToolOutcome::Block(reason) => assert!(reason.contains("silent-block")),
            other => panic!("expected block, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn pre_tool_spawn_failure_blocks() {
        let tmp = tempfile::tempdir().unwrap();
        let config = ProjectHooksConfig {
            hooks: vec![HookEntry {
                name: "missing".into(),
                command: vec!["/nonexistent/hook-binary".into()],
                events: vec![HookEvent::PreTool],
            }],
        };
        let runner = ProjectHooksRunner::new(
            config,
            tmp.path().to_path_buf(),
            "test-session".into(),
            "test prompt".into(),
        );
        match runner.fire_pre_tool("shell", "{}").await {
            PreToolOutcome::Block(reason) => assert!(reason.contains("missing")),
            other => panic!("expected block, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn pre_tool_stdout_becomes_injection() {
        let tmp = tempfile::tempdir().unwrap();
        let config = ProjectHooksConfig {
            hooks: vec![HookEntry {
                name: "context".into(),
                command: vec!["sh".into(), "-c".into(), "echo injected-context".into()],
                events: vec![HookEvent::PreTool],
            }],
        };
        let runner = ProjectHooksRunner::new(
            config,
            tmp.path().to_path_buf(),
            "test-session".into(),
            "test prompt".into(),
        );
        let outcome = runner.fire_pre_tool("fs_read", r#"{"path":"a"}"#).await;
        assert_eq!(
            outcome,
            PreToolOutcome::Continue {
                injections: vec!["injected-context".into()]
            }
        );
    }

    #[tokio::test]
    async fn post_tool_stdout_becomes_injection() {
        let tmp = tempfile::tempdir().unwrap();
        let config = ProjectHooksConfig {
            hooks: vec![HookEntry {
                name: "context".into(),
                command: vec!["sh".into(), "-c".into(), "echo post-context".into()],
                events: vec![HookEvent::PostTool],
            }],
        };
        let runner = ProjectHooksRunner::new(
            config,
            tmp.path().to_path_buf(),
            "test-session".into(),
            "test prompt".into(),
        );
        let injections = runner
            .fire_post_tool("fs_read", r#"{"path":"a"}"#, "file contents")
            .await;
        assert_eq!(injections, vec!["post-context".to_string()]);
    }

    #[tokio::test]
    async fn post_tool_nonzero_exit_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let config = ProjectHooksConfig {
            hooks: vec![HookEntry {
                name: "noisy".into(),
                command: vec!["sh".into(), "-c".into(), "exit 3".into()],
                events: vec![HookEvent::PostTool],
            }],
        };
        let runner = ProjectHooksRunner::new(
            config,
            tmp.path().to_path_buf(),
            "test-session".into(),
            "test prompt".into(),
        );
        let injections = runner.fire_post_tool("fs_read", "{}", "ok").await;
        assert!(injections.is_empty());
    }

    #[tokio::test]
    async fn hook_receives_parsed_args_on_stdin() {
        let tmp = tempfile::tempdir().unwrap();
        // The hook echoes its stdin back; we assert the args were embedded as
        // parsed JSON (object), not a re-serialized string.
        let config = ProjectHooksConfig {
            hooks: vec![HookEntry {
                name: "echo".into(),
                command: vec!["cat".into()],
                events: vec![HookEvent::PreTool],
            }],
        };
        let runner = ProjectHooksRunner::new(
            config,
            tmp.path().to_path_buf(),
            "test-session".into(),
            "test prompt".into(),
        );
        let outcome = runner.fire_pre_tool("shell", r#"{"command":"ls"}"#).await;
        let PreToolOutcome::Continue { injections } = outcome else {
            panic!("expected continue");
        };
        let payload: serde_json::Value = serde_json::from_str(&injections[0]).unwrap();
        assert_eq!(payload["event"], "pre-tool");
        assert_eq!(payload["tool"], "shell");
        assert_eq!(payload["args"]["command"], "ls");
        // Claude Code-compatible fields must be present so tools like
        // proactive-context can read them. `transcript_path` is always null
        // because TENEX stores transcripts in SQLite, not a JSONL file.
        assert_eq!(payload["session_id"], "test-session");
        assert_eq!(payload["cwd"], tmp.path().to_string_lossy().as_ref());
        assert_eq!(payload["transcript_path"], serde_json::Value::Null);
        assert_eq!(payload["prompt"], "test prompt");
    }
}
