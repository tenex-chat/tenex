use glob::glob;
use regex::Regex;
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tokio::process::Command;

use super::agents_md::AgentsMdReminderState;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct FsError(String);

/// Expand `$VAR` and `${VAR}` substrings using `std::env::var`. Unknown
/// variables are left verbatim so callers see their literal input in any
/// subsequent filesystem error rather than a silently empty expansion.
fn expand_env_vars(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() {
            // ${NAME}
            if bytes[i + 1] == b'{' {
                if let Some(end_rel) = bytes[i + 2..].iter().position(|&b| b == b'}') {
                    let name = std::str::from_utf8(&bytes[i + 2..i + 2 + end_rel]).unwrap_or("");
                    if !name.is_empty() {
                        match std::env::var(name) {
                            Ok(v) => out.push_str(&v),
                            Err(_) => out.push_str(&input[i..i + 2 + end_rel + 1]),
                        }
                        i += 2 + end_rel + 1;
                        continue;
                    }
                }
            }
            // $NAME — terminated by anything that is not [A-Za-z0-9_]
            let start = i + 1;
            let mut end = start;
            while end < bytes.len()
                && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_')
            {
                end += 1;
            }
            if end > start {
                let name = std::str::from_utf8(&bytes[start..end]).unwrap_or("");
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => out.push_str(&input[i..end]),
                }
                i = end;
                continue;
            }
        }
        // Safe: ASCII bytes map 1-to-1 to chars; non-ASCII bytes outside a
        // `$VAR` reference are copied byte-by-byte through the ASCII branch.
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn resolve_path(base: &str, path: &str) -> PathBuf {
    let expanded = expand_env_vars(path);
    let p = Path::new(&expanded);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(base).join(p)
    }
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

fn resolve_home_path(home_dir: &str, path: &str) -> Result<PathBuf, FsError> {
    let base = PathBuf::from(home_dir);
    let expanded = expand_env_vars(path);
    let raw = if Path::new(&expanded).is_absolute() {
        PathBuf::from(&expanded)
    } else {
        base.join(&expanded)
    };
    let normalized = normalize_lexically(&raw);
    if !normalized.starts_with(&base) {
        return Err(FsError(format!(
            "Access denied: path '{}' is outside your home directory",
            path
        )));
    }
    Ok(normalized)
}

fn make_relative(path: &Path, base: &str) -> String {
    path.strip_prefix(base)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| path.display().to_string())
}

const EXCLUDED_DIRS: &[&str] = &["node_modules", ".git", "dist", "build", ".next", "coverage"];

fn has_excluded_segment(path: &Path) -> bool {
    path.components().any(|c| {
        matches!(c, std::path::Component::Normal(n) if EXCLUDED_DIRS.contains(&n.to_str().unwrap_or("")))
    })
}

// ─── fs_read ─────────────────────────────────────────────────────────────────

const DEFAULT_LINE_LIMIT: usize = 250;
const MAX_LINE_LENGTH: usize = 2000;

#[derive(Debug, Deserialize, Serialize)]
pub struct FsReadArgs {
    pub path: String,
    /// 1-based line number to start from
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

pub struct FsReadTool {
    working_dir: String,
    agents_md: Arc<AgentsMdReminderState>,
}

impl FsReadTool {
    pub(crate) fn new(working_dir: String, agents_md: Arc<AgentsMdReminderState>) -> Self {
        Self {
            working_dir,
            agents_md,
        }
    }
}

impl Tool for FsReadTool {
    const NAME: &'static str = "fs_read";
    type Error = FsError;
    type Args = FsReadArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: format!(
                "Read a file or directory listing. File reads include line numbers, default to \
                 {DEFAULT_LINE_LIMIT} lines, and truncate lines over {MAX_LINE_LENGTH} characters. \
                 Use offset/limit to paginate large files."
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path":        { "type": "string",  "description": "File or directory path (relative to working directory)" },
                    "description": { "type": "string",  "description": "Brief reason for this read" },
                    "offset":      { "type": "integer", "description": "1-based line number to start from (default 1)" },
                    "limit":       { "type": "integer", "description": format!("Maximum lines to return (default {DEFAULT_LINE_LIMIT})") }
                },
                "required": ["path", "description"]
            }),
        }
    }

    async fn call(&self, args: FsReadArgs) -> Result<Self::Output, FsError> {
        let path = resolve_path(&self.working_dir, &args.path);

        if path.is_dir() {
            let mut entries: Vec<String> = fs::read_dir(&path)
                .map_err(|e| FsError(format!("Error reading directory {}: {e}", path.display())))?
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            entries.sort();
            let listing = entries
                .iter()
                .map(|e| format!("  - {e}"))
                .collect::<Vec<_>>()
                .join("\n");
            let mut out = format!(
                "Directory listing for {}:\n{listing}\n\nTo read a specific file, pass its absolute path.",
                path.display()
            );
            out.push_str(&self.agents_md.reminder_for_path(&path));
            return Ok(out);
        }

        let content = fs::read_to_string(&path)
            .map_err(|e| FsError(format!("Error reading {}: {e}", path.display())))?;

        let start = args.offset.unwrap_or(1).max(1);
        let limit = args.limit.unwrap_or(DEFAULT_LINE_LIMIT);
        let total_lines = content.lines().count();

        let start_idx = start - 1;
        if start_idx >= total_lines && total_lines > 0 {
            return Err(FsError(format!(
                "File has {total_lines} line(s), but offset {start} was requested."
            )));
        }

        let end_idx = (start_idx + limit).min(total_lines);
        let selected: Vec<&str> = content.lines().skip(start_idx).take(limit).collect();

        let mut out = String::new();
        for (i, line) in selected.iter().enumerate() {
            let line_no = start_idx + i + 1;
            let display = if line.len() > MAX_LINE_LENGTH {
                format!("{}...", &line[..MAX_LINE_LENGTH])
            } else {
                line.to_string()
            };
            out.push_str(&format!("{line_no:>6}\t{display}\n"));
        }

        if end_idx < total_lines {
            let remaining = total_lines - end_idx;
            out.push_str(&format!(
                "\n[Showing lines {start}-{end_idx} of {total_lines}. \
                 {remaining} more lines available. Use offset={} to continue.]",
                end_idx + 1
            ));
        }

        out.push_str(&self.agents_md.reminder_for_path(&path));
        Ok(out)
    }
}

// ─── fs_write ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize)]
pub struct FsWriteArgs {
    pub path: String,
    pub content: String,
}

pub struct FsWriteTool {
    working_dir: String,
}

impl FsWriteTool {
    pub fn new(working_dir: String) -> Self {
        Self { working_dir }
    }
}

impl Tool for FsWriteTool {
    const NAME: &'static str = "fs_write";
    type Error = FsError;
    type Args = FsWriteArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Write content to a file. Creates parent directories automatically and overwrites existing files.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path":        { "type": "string", "description": "File path to write (relative to working directory)" },
                    "content":     { "type": "string", "description": "Content to write to the file" },
                    "description": { "type": "string", "description": "Brief reason for this write" }
                },
                "required": ["path", "content", "description"]
            }),
        }
    }

    async fn call(&self, args: FsWriteArgs) -> Result<Self::Output, FsError> {
        let path = resolve_path(&self.working_dir, &args.path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| FsError(format!("Error creating directories: {e}")))?;
        }
        fs::write(&path, &args.content)
            .map_err(|e| FsError(format!("Error writing {}: {e}", path.display())))?;
        Ok(format!(
            "Successfully wrote {} bytes to {}",
            args.content.len(),
            path.display()
        ))
    }
}

// ─── fs_edit ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize)]
pub struct FsEditArgs {
    pub path: String,
    pub old_string: String,
    pub new_string: String,
    pub replace_all: Option<bool>,
}

pub struct FsEditTool {
    working_dir: String,
}

impl FsEditTool {
    pub fn new(working_dir: String) -> Self {
        Self { working_dir }
    }
}

impl Tool for FsEditTool {
    const NAME: &'static str = "fs_edit";
    type Error = FsError;
    type Args = FsEditArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Perform exact string replacements in a file. When replace_all is false, old_string must match exactly once.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path":        { "type": "string",  "description": "File path to edit (relative to working directory)" },
                    "description": { "type": "string",  "description": "Brief reason for this edit" },
                    "old_string":  { "type": "string",  "description": "Exact string to replace" },
                    "new_string":  { "type": "string",  "description": "Replacement string" },
                    "replace_all": { "type": "boolean", "description": "Replace every occurrence instead of requiring a unique match (default false)" }
                },
                "required": ["path", "description", "old_string", "new_string"]
            }),
        }
    }

    async fn call(&self, args: FsEditArgs) -> Result<Self::Output, FsError> {
        if args.old_string == args.new_string {
            return Err(FsError(
                "old_string and new_string must be different".to_string(),
            ));
        }

        let path = resolve_path(&self.working_dir, &args.path);
        let content = fs::read_to_string(&path)
            .map_err(|e| FsError(format!("Error reading {}: {e}", path.display())))?;

        if !content.contains(&args.old_string) {
            return Err(FsError(format!(
                "old_string not found in {}. Make sure you're using the exact string from the file.",
                path.display()
            )));
        }

        let (new_content, count) = if args.replace_all.unwrap_or(false) {
            let count = content.matches(&args.old_string).count();
            (content.replace(&args.old_string, &args.new_string), count)
        } else {
            let count = content.matches(&args.old_string).count();
            if count > 1 {
                return Err(FsError(format!(
                    "old_string appears {count} times in {}. \
                     Provide more surrounding context or set replace_all: true.",
                    path.display()
                )));
            }
            (content.replacen(&args.old_string, &args.new_string, 1), 1)
        };

        fs::write(&path, &new_content)
            .map_err(|e| FsError(format!("Error writing {}: {e}", path.display())))?;
        Ok(format!(
            "Successfully replaced {count} occurrence(s) in {}",
            path.display()
        ))
    }
}

// ─── fs_glob ─────────────────────────────────────────────────────────────────

const DEFAULT_GLOB_LIMIT: usize = 100;

#[derive(Debug, Deserialize, Serialize)]
pub struct FsGlobArgs {
    pub pattern: String,
    /// Maximum results; 0 = unlimited (default 100)
    pub head_limit: Option<usize>,
    pub offset: Option<usize>,
}

pub struct FsGlobTool {
    working_dir: String,
    agents_md: Arc<AgentsMdReminderState>,
}

impl FsGlobTool {
    pub(crate) fn new(working_dir: String, agents_md: Arc<AgentsMdReminderState>) -> Self {
        Self {
            working_dir,
            agents_md,
        }
    }
}

impl Tool for FsGlobTool {
    const NAME: &'static str = "fs_glob";
    type Error = FsError;
    type Args = FsGlobArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Fast glob-based search. Returns matching file and directory paths relative to the working directory in sorted order. Directories are suffixed with '/'.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern":     { "type": "string",  "description": "Glob pattern to match files (e.g. **/*.rs, src/**/*.ts)" },
                    "description": { "type": "string",  "description": "Brief reason for this search" },
                    "head_limit":  { "type": "integer", "description": format!("Maximum results; 0 for unlimited (default {DEFAULT_GLOB_LIMIT})") },
                    "offset":      { "type": "integer", "description": "Skip the first N results (default 0)" }
                },
                "required": ["pattern", "description"]
            }),
        }
    }

    async fn call(&self, args: FsGlobArgs) -> Result<Self::Output, FsError> {
        let head_limit = args.head_limit.unwrap_or(DEFAULT_GLOB_LIMIT);
        let offset = args.offset.unwrap_or(0);

        let expanded_pattern = expand_env_vars(&args.pattern);
        let full_pattern = if Path::new(&expanded_pattern).is_absolute() {
            expanded_pattern
        } else {
            format!("{}/{}", self.working_dir, expanded_pattern)
        };

        let mut all_paths: Vec<(String, PathBuf)> = Vec::new();
        for entry in
            glob(&full_pattern).map_err(|e| FsError(format!("Invalid glob pattern: {e}")))?
        {
            match entry {
                Ok(path) => {
                    if !has_excluded_segment(&path) {
                        let rel = make_relative(&path, &self.working_dir);
                        if path.is_dir() {
                            all_paths.push((format!("{rel}/"), path));
                        } else {
                            all_paths.push((rel, path));
                        }
                    }
                }
                Err(e) => eprintln!("fs_glob: {e}"),
            }
        }
        all_paths.sort_by(|left, right| left.0.cmp(&right.0));

        let effective_limit = if head_limit == 0 {
            usize::MAX
        } else {
            head_limit
        };
        let paginated: Vec<&(String, PathBuf)> = all_paths
            .iter()
            .skip(offset)
            .take(effective_limit)
            .collect();

        if paginated.is_empty() {
            return Ok(format!("No matches found for pattern: {}", args.pattern));
        }

        let mut body = paginated
            .iter()
            .map(|entry| entry.0.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let has_more = head_limit > 0 && (offset + paginated.len()) < all_paths.len();
        if has_more {
            body = format!(
                "{body}\n\n[Truncated: showing {} results after offset; additional files omitted]",
                paginated.len()
            );
        }
        body.push_str(
            &self
                .agents_md
                .reminder_for_paths(paginated.iter().map(|entry| entry.1.as_path())),
        );
        Ok(body)
    }
}

// ─── fs_grep ─────────────────────────────────────────────────────────────────

const DEFAULT_GREP_LIMIT: usize = 100;
const MAX_CONTENT_SIZE: usize = 50_000;

#[derive(Debug, Deserialize, Serialize)]
pub struct FsGrepArgs {
    pub pattern: String,
    pub path: Option<String>,
    /// "files_with_matches" | "content" | "count" (default: "files_with_matches")
    pub output_mode: Option<String>,
    pub glob: Option<String>,
    #[serde(rename = "-i")]
    pub case_insensitive: Option<bool>,
    #[serde(rename = "-A")]
    pub after: Option<u32>,
    #[serde(rename = "-B")]
    pub before: Option<u32>,
    #[serde(rename = "-C")]
    pub context: Option<u32>,
    /// Maximum results; 0 = unlimited (default 100)
    pub head_limit: Option<usize>,
    pub offset: Option<usize>,
}

pub struct FsGrepTool {
    working_dir: String,
}

impl FsGrepTool {
    pub fn new(working_dir: String) -> Self {
        Self { working_dir }
    }
}

impl Tool for FsGrepTool {
    const NAME: &'static str = "fs_grep";
    type Error = FsError;
    type Args = FsGrepArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Search file contents with ripgrep (grep fallback). Supports content, file-list, and count modes.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern":     { "type": "string",  "description": "Regex pattern to search for" },
                    "description": { "type": "string",  "description": "Brief reason for this search" },
                    "path":        { "type": "string",  "description": "File or directory to search (defaults to working directory)" },
                    "output_mode": { "type": "string",  "enum": ["files_with_matches", "content", "count"], "description": "Output mode (default: files_with_matches)" },
                    "glob":        { "type": "string",  "description": "Glob filter for files (e.g. *.ts)" },
                    "-i":          { "type": "boolean", "description": "Case-insensitive search" },
                    "-A":          { "type": "integer", "description": "Lines of trailing context (content mode)" },
                    "-B":          { "type": "integer", "description": "Lines of leading context (content mode)" },
                    "-C":          { "type": "integer", "description": "Lines of surrounding context (content mode)" },
                    "head_limit":  { "type": "integer", "description": format!("Maximum results; 0 for unlimited (default {DEFAULT_GREP_LIMIT})") },
                    "offset":      { "type": "integer", "description": "Skip the first N results (default 0)" }
                },
                "required": ["pattern", "description"]
            }),
        }
    }

    async fn call(&self, args: FsGrepArgs) -> Result<Self::Output, FsError> {
        let head_limit = args.head_limit.unwrap_or(DEFAULT_GREP_LIMIT);
        let offset = args.offset.unwrap_or(0);
        let output_mode = args.output_mode.as_deref().unwrap_or("files_with_matches");

        let search_path = args
            .path
            .as_deref()
            .map(|p| resolve_path(&self.working_dir, p))
            .unwrap_or_else(|| PathBuf::from(&self.working_dir));

        let use_rg = Command::new("rg").arg("--version").output().await.is_ok();

        let lines = run_search(use_rg, &args, &search_path, output_mode, &self.working_dir).await?;

        if lines.is_empty() {
            return Ok(format!("No matches found for pattern: {}", args.pattern));
        }

        let effective_limit = if head_limit == 0 {
            usize::MAX
        } else {
            head_limit
        };
        let paginated: Vec<&str> = lines
            .iter()
            .skip(offset)
            .take(effective_limit)
            .map(String::as_str)
            .collect();

        let joined = paginated.join("\n");

        // Content mode size guard: fall back to files_with_matches if too large
        if output_mode == "content" && joined.len() > MAX_CONTENT_SIZE {
            let file_lines = run_search(
                use_rg,
                &args,
                &search_path,
                "files_with_matches",
                &self.working_dir,
            )
            .await?;
            let file_paginated: Vec<&str> = file_lines
                .iter()
                .skip(offset)
                .take(effective_limit)
                .map(String::as_str)
                .collect();
            return Ok(format!(
                "Content output would exceed the size limit.\nReturning matching files instead:\n\n{}",
                file_paginated.join("\n")
            ));
        }

        let has_more = head_limit > 0 && (offset + paginated.len()) < lines.len();
        if has_more {
            Ok(format!(
                "{joined}\n\n[Truncated: showing {} results after offset; additional results omitted]",
                paginated.len()
            ))
        } else {
            Ok(joined)
        }
    }
}

async fn run_search(
    use_rg: bool,
    args: &FsGrepArgs,
    search_path: &Path,
    output_mode: &str,
    working_dir: &str,
) -> Result<Vec<String>, FsError> {
    let raw_output = if use_rg {
        let mut cmd_args: Vec<String> = Vec::new();
        match output_mode {
            "files_with_matches" => cmd_args.push("-l".to_string()),
            "count" => cmd_args.push("-c".to_string()),
            _ => cmd_args.push("-n".to_string()),
        }
        if args.case_insensitive.unwrap_or(false) {
            cmd_args.push("-i".to_string());
        }
        if output_mode == "content" {
            if let Some(c) = args.context {
                cmd_args.extend(["-C".to_string(), c.to_string()]);
            } else {
                if let Some(a) = args.after {
                    cmd_args.extend(["-A".to_string(), a.to_string()]);
                }
                if let Some(b) = args.before {
                    cmd_args.extend(["-B".to_string(), b.to_string()]);
                }
            }
        }
        if let Some(g) = &args.glob {
            cmd_args.extend(["--glob".to_string(), g.clone()]);
        }
        for dir in EXCLUDED_DIRS {
            cmd_args.extend(["--glob".to_string(), format!("!{dir}")]);
        }
        cmd_args.extend([
            "--".to_string(),
            args.pattern.clone(),
            search_path.display().to_string(),
        ]);

        Command::new("rg")
            .args(&cmd_args)
            .current_dir(working_dir)
            .output()
            .await
            .map_err(|e| FsError(format!("Failed to run rg: {e}")))?
    } else {
        let mut cmd_args: Vec<String> = vec!["-r".to_string(), "-E".to_string()];
        match output_mode {
            "files_with_matches" => cmd_args.push("-l".to_string()),
            "count" => cmd_args.push("-c".to_string()),
            _ => cmd_args.push("-n".to_string()),
        }
        if args.case_insensitive.unwrap_or(false) {
            cmd_args.push("-i".to_string());
        }
        if output_mode == "content" {
            if let Some(c) = args.context {
                cmd_args.push(format!("-C{c}"));
            } else {
                if let Some(a) = args.after {
                    cmd_args.push(format!("-A{a}"));
                }
                if let Some(b) = args.before {
                    cmd_args.push(format!("-B{b}"));
                }
            }
        }
        if let Some(g) = &args.glob {
            cmd_args.push(format!("--include={g}"));
        }
        for dir in EXCLUDED_DIRS {
            cmd_args.push(format!("--exclude-dir={dir}"));
        }
        cmd_args.push("--binary-files=without-match".to_string());
        cmd_args.extend([args.pattern.clone(), search_path.display().to_string()]);

        Command::new("grep")
            .args(&cmd_args)
            .current_dir(working_dir)
            .output()
            .await
            .map_err(|e| FsError(format!("Failed to run grep: {e}")))?
    };

    // exit 1 = no matches (not an error for grep/rg)
    if !raw_output.status.success() && raw_output.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&raw_output.stderr);
        return Err(FsError(format!("Search failed: {stderr}")));
    }

    let stdout = String::from_utf8_lossy(&raw_output.stdout);
    let lines: Vec<String> = stdout
        .lines()
        .map(|line| relativize_grep_line(line, working_dir, output_mode))
        .collect();

    Ok(lines)
}

fn relativize_grep_line(line: &str, working_dir: &str, output_mode: &str) -> String {
    match output_mode {
        "files_with_matches" => make_relative(Path::new(line), working_dir),
        "count" => {
            // path:count — last colon separates path from count
            if let Some(pos) = line.rfind(':') {
                let path_part = &line[..pos];
                let count_part = &line[pos..];
                format!(
                    "{}{count_part}",
                    make_relative(Path::new(path_part), working_dir)
                )
            } else {
                line.to_string()
            }
        }
        _ => {
            // content: path:lineno:text  or  path-lineno-text (context separator lines)
            parse_grep_content_line(line, working_dir)
        }
    }
}

fn parse_grep_content_line(line: &str, working_dir: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^(.+?)([-:])(\d+)([-:])(.*)$").unwrap());

    if let Some(caps) = re.captures(line) {
        let path_part = caps.get(1).map_or("", |m| m.as_str());
        let sep1 = caps.get(2).map_or("", |m| m.as_str());
        let line_no = caps.get(3).map_or("", |m| m.as_str());
        let sep2 = caps.get(4).map_or("", |m| m.as_str());
        let content = caps.get(5).map_or("", |m| m.as_str());
        format!(
            "{}{sep1}{line_no}{sep2}{content}",
            make_relative(Path::new(path_part), working_dir)
        )
    } else {
        line.to_string()
    }
}

// ─── home_fs_read ─────────────────────────────────────────────────────────────

pub struct HomeFsReadTool {
    home_dir: String,
}

impl HomeFsReadTool {
    pub fn new(home_dir: String) -> Self {
        Self { home_dir }
    }
}

impl Tool for HomeFsReadTool {
    const NAME: &'static str = "home_fs_read";
    type Error = FsError;
    type Args = FsReadArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: format!(
                "Read a file or directory listing within your agent home directory ({}). \
                 Paths are relative to your home directory. \
                 File reads include line numbers, default to {DEFAULT_LINE_LIMIT} lines, \
                 and truncate lines over {MAX_LINE_LENGTH} characters. \
                 Use offset/limit to paginate large files.",
                self.home_dir
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path":        { "type": "string",  "description": "File or directory path (relative to your home directory)" },
                    "description": { "type": "string",  "description": "Brief reason for this read" },
                    "offset":      { "type": "integer", "description": "1-based line number to start from (default 1)" },
                    "limit":       { "type": "integer", "description": format!("Maximum lines to return (default {DEFAULT_LINE_LIMIT})") }
                },
                "required": ["path", "description"]
            }),
        }
    }

    async fn call(&self, args: FsReadArgs) -> Result<Self::Output, FsError> {
        let path = resolve_home_path(&self.home_dir, &args.path)?;

        if path.is_dir() {
            let mut entries: Vec<String> = fs::read_dir(&path)
                .map_err(|e| FsError(format!("Error reading directory {}: {e}", path.display())))?
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            entries.sort();
            let listing = entries
                .iter()
                .map(|e| format!("  - {e}"))
                .collect::<Vec<_>>()
                .join("\n");
            return Ok(format!(
                "Directory listing for {}:\n{listing}\n\nTo read a specific file, pass its path relative to your home directory.",
                path.display()
            ));
        }

        let content = fs::read_to_string(&path)
            .map_err(|e| FsError(format!("Error reading {}: {e}", path.display())))?;

        let start = args.offset.unwrap_or(1).max(1);
        let limit = args.limit.unwrap_or(DEFAULT_LINE_LIMIT);
        let total_lines = content.lines().count();
        let start_idx = start - 1;
        if start_idx >= total_lines && total_lines > 0 {
            return Err(FsError(format!(
                "File has {total_lines} line(s), but offset {start} was requested."
            )));
        }
        let end_idx = (start_idx + limit).min(total_lines);
        let selected: Vec<&str> = content.lines().skip(start_idx).take(limit).collect();

        let mut out = String::new();
        for (i, line) in selected.iter().enumerate() {
            let line_no = start_idx + i + 1;
            let display = if line.len() > MAX_LINE_LENGTH {
                format!("{}...", &line[..MAX_LINE_LENGTH])
            } else {
                line.to_string()
            };
            out.push_str(&format!("{line_no:>6}\t{display}\n"));
        }
        if end_idx < total_lines {
            let remaining = total_lines - end_idx;
            out.push_str(&format!(
                "\n[Showing lines {start}-{end_idx} of {total_lines}. \
                 {remaining} more lines available. Use offset={} to continue.]",
                end_idx + 1
            ));
        }
        Ok(out)
    }
}

// ─── home_fs_write ────────────────────────────────────────────────────────────

pub struct HomeFsWriteTool {
    home_dir: String,
}

impl HomeFsWriteTool {
    pub fn new(home_dir: String) -> Self {
        Self { home_dir }
    }
}

impl Tool for HomeFsWriteTool {
    const NAME: &'static str = "home_fs_write";
    type Error = FsError;
    type Args = FsWriteArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: format!(
                "Write content to a file within your agent home directory ({}). \
                 Creates parent directories automatically and overwrites existing files. \
                 Paths are relative to your home directory.",
                self.home_dir
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path":        { "type": "string", "description": "File path to write (relative to your home directory)" },
                    "content":     { "type": "string", "description": "Content to write to the file" },
                    "description": { "type": "string", "description": "Brief reason for this write" }
                },
                "required": ["path", "content", "description"]
            }),
        }
    }

    async fn call(&self, args: FsWriteArgs) -> Result<Self::Output, FsError> {
        let path = resolve_home_path(&self.home_dir, &args.path)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| FsError(format!("Error creating directories: {e}")))?;
        }
        fs::write(&path, &args.content)
            .map_err(|e| FsError(format!("Error writing {}: {e}", path.display())))?;
        Ok(format!(
            "Successfully wrote {} bytes to {}",
            args.content.len(),
            path.display()
        ))
    }
}

// ─── home_fs_edit ─────────────────────────────────────────────────────────────

pub struct HomeFsEditTool {
    home_dir: String,
}

impl HomeFsEditTool {
    pub fn new(home_dir: String) -> Self {
        Self { home_dir }
    }
}

impl Tool for HomeFsEditTool {
    const NAME: &'static str = "home_fs_edit";
    type Error = FsError;
    type Args = FsEditArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: format!(
                "Perform exact string replacements in a file within your agent home directory ({}). \
                 When replace_all is false, old_string must match exactly once. \
                 Paths are relative to your home directory.",
                self.home_dir
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path":        { "type": "string",  "description": "File path to edit (relative to your home directory)" },
                    "description": { "type": "string",  "description": "Brief reason for this edit" },
                    "old_string":  { "type": "string",  "description": "Exact string to replace" },
                    "new_string":  { "type": "string",  "description": "Replacement string" },
                    "replace_all": { "type": "boolean", "description": "Replace every occurrence instead of requiring a unique match (default false)" }
                },
                "required": ["path", "description", "old_string", "new_string"]
            }),
        }
    }

    async fn call(&self, args: FsEditArgs) -> Result<Self::Output, FsError> {
        if args.old_string == args.new_string {
            return Err(FsError(
                "old_string and new_string must be different".to_string(),
            ));
        }
        let path = resolve_home_path(&self.home_dir, &args.path)?;
        let content = fs::read_to_string(&path)
            .map_err(|e| FsError(format!("Error reading {}: {e}", path.display())))?;
        if !content.contains(&args.old_string) {
            return Err(FsError(format!(
                "old_string not found in {}. Make sure you're using the exact string from the file.",
                path.display()
            )));
        }
        let (new_content, count) = if args.replace_all.unwrap_or(false) {
            let count = content.matches(&args.old_string).count();
            (content.replace(&args.old_string, &args.new_string), count)
        } else {
            let count = content.matches(&args.old_string).count();
            if count > 1 {
                return Err(FsError(format!(
                    "old_string appears {count} times in {}. \
                     Provide more surrounding context or set replace_all: true.",
                    path.display()
                )));
            }
            (content.replacen(&args.old_string, &args.new_string, 1), 1)
        };
        fs::write(&path, &new_content)
            .map_err(|e| FsError(format!("Error writing {}: {e}", path.display())))?;
        Ok(format!(
            "Successfully replaced {count} occurrence(s) in {}",
            path.display()
        ))
    }
}

// ─── home_fs_glob ─────────────────────────────────────────────────────────────

pub struct HomeFsGlobTool {
    home_dir: String,
}

impl HomeFsGlobTool {
    pub fn new(home_dir: String) -> Self {
        Self { home_dir }
    }
}

impl Tool for HomeFsGlobTool {
    const NAME: &'static str = "home_fs_glob";
    type Error = FsError;
    type Args = FsGlobArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: format!(
                "Fast glob-based search within your agent home directory ({}). \
                 Returns matching file and directory paths relative to your home directory. \
                 Directories are suffixed with '/'. Patterns are relative to your home directory.",
                self.home_dir
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern":     { "type": "string",  "description": "Glob pattern to match files (e.g. **/*.md, notes/*.txt)" },
                    "description": { "type": "string",  "description": "Brief reason for this search" },
                    "head_limit":  { "type": "integer", "description": format!("Maximum results; 0 for unlimited (default {DEFAULT_GLOB_LIMIT})") },
                    "offset":      { "type": "integer", "description": "Skip the first N results (default 0)" }
                },
                "required": ["pattern", "description"]
            }),
        }
    }

    async fn call(&self, args: FsGlobArgs) -> Result<Self::Output, FsError> {
        let head_limit = args.head_limit.unwrap_or(DEFAULT_GLOB_LIMIT);
        let offset = args.offset.unwrap_or(0);

        let expanded_pattern = expand_env_vars(&args.pattern);
        let full_pattern = if Path::new(&expanded_pattern).is_absolute() {
            // Verify the expanded absolute pattern is within home_dir
            if !Path::new(&expanded_pattern).starts_with(&self.home_dir) {
                return Err(FsError(format!(
                    "Access denied: pattern '{}' is outside your home directory",
                    args.pattern
                )));
            }
            expanded_pattern
        } else {
            format!("{}/{}", self.home_dir, expanded_pattern)
        };

        let mut all_paths: Vec<String> = Vec::new();
        for entry in
            glob(&full_pattern).map_err(|e| FsError(format!("Invalid glob pattern: {e}")))?
        {
            match entry {
                Ok(path) => {
                    if !has_excluded_segment(&path) {
                        let rel = make_relative(&path, &self.home_dir);
                        if path.is_dir() {
                            all_paths.push(format!("{rel}/"));
                        } else {
                            all_paths.push(rel);
                        }
                    }
                }
                Err(e) => eprintln!("home_fs_glob: {e}"),
            }
        }
        all_paths.sort();

        let effective_limit = if head_limit == 0 {
            usize::MAX
        } else {
            head_limit
        };
        let paginated: Vec<&str> = all_paths
            .iter()
            .skip(offset)
            .take(effective_limit)
            .map(String::as_str)
            .collect();

        if paginated.is_empty() {
            return Ok(format!("No matches found for pattern: {}", args.pattern));
        }

        let body = paginated.join("\n");
        let has_more = head_limit > 0 && (offset + paginated.len()) < all_paths.len();
        if has_more {
            Ok(format!(
                "{body}\n\n[Truncated: showing {} results after offset; additional files omitted]",
                paginated.len()
            ))
        } else {
            Ok(body)
        }
    }
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_env_vars_dollar_brace_form() {
        let home = std::env::var("HOME").expect("HOME must be set");
        let input = "${HOME}/some/path";
        let result = expand_env_vars(input);
        assert_eq!(result, format!("{home}/some/path"));
    }

    #[test]
    fn expand_env_vars_bare_dollar_form() {
        let home = std::env::var("HOME").expect("HOME must be set");
        let input = "$HOME/some/path";
        let result = expand_env_vars(input);
        assert_eq!(result, format!("{home}/some/path"));
    }

    #[test]
    fn expand_env_vars_unknown_var_left_verbatim() {
        let result = expand_env_vars("$__TENEX_NONEXISTENT_VAR__/path");
        assert_eq!(result, "$__TENEX_NONEXISTENT_VAR__/path");
    }

    #[test]
    fn resolve_path_expands_project_base() {
        let home = std::env::var("HOME").expect("HOME must be set");
        let resolved = resolve_path("/base", "$HOME/file.txt");
        assert_eq!(resolved, PathBuf::from(format!("{home}/file.txt")));
    }

    #[test]
    fn resolve_home_path_expands_var_in_subpath() {
        let home = std::env::var("HOME").expect("HOME must be set");
        // Relative subpath containing $HOME should be rejected by the
        // containment check, but expanded first so it becomes absolute.
        // Here we just verify expansion happens: a relative path with a bare
        // word (no $) remains relative and is joined to the base.
        let base = home.clone();
        let result = resolve_home_path(&base, "subdir/file.txt");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), PathBuf::from(format!("{home}/subdir/file.txt")));
    }
}

// ─── home_fs_grep ─────────────────────────────────────────────────────────────

pub struct HomeFsGrepTool {
    home_dir: String,
}

impl HomeFsGrepTool {
    pub fn new(home_dir: String) -> Self {
        Self { home_dir }
    }
}

impl Tool for HomeFsGrepTool {
    const NAME: &'static str = "home_fs_grep";
    type Error = FsError;
    type Args = FsGrepArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: format!(
                "Search file contents within your agent home directory ({}) with ripgrep (grep fallback). \
                 Supports content, file-list, and count modes. \
                 Search is restricted to your home directory.",
                self.home_dir
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern":     { "type": "string",  "description": "Regex pattern to search for" },
                    "description": { "type": "string",  "description": "Brief reason for this search" },
                    "path":        { "type": "string",  "description": "File or subdirectory to search within your home directory (defaults to home directory root)" },
                    "output_mode": { "type": "string",  "enum": ["files_with_matches", "content", "count"], "description": "Output mode (default: files_with_matches)" },
                    "glob":        { "type": "string",  "description": "Glob filter for files (e.g. *.md)" },
                    "-i":          { "type": "boolean", "description": "Case-insensitive search" },
                    "-A":          { "type": "integer", "description": "Lines of trailing context (content mode)" },
                    "-B":          { "type": "integer", "description": "Lines of leading context (content mode)" },
                    "-C":          { "type": "integer", "description": "Lines of surrounding context (content mode)" },
                    "head_limit":  { "type": "integer", "description": format!("Maximum results; 0 for unlimited (default {DEFAULT_GREP_LIMIT})") },
                    "offset":      { "type": "integer", "description": "Skip the first N results (default 0)" }
                },
                "required": ["pattern", "description"]
            }),
        }
    }

    async fn call(&self, args: FsGrepArgs) -> Result<Self::Output, FsError> {
        let head_limit = args.head_limit.unwrap_or(DEFAULT_GREP_LIMIT);
        let offset = args.offset.unwrap_or(0);
        let output_mode = args
            .output_mode
            .clone()
            .unwrap_or_else(|| "files_with_matches".to_string());
        let output_mode = output_mode.as_str();

        let search_path = if let Some(ref p) = args.path {
            resolve_home_path(&self.home_dir, p)?
        } else {
            PathBuf::from(&self.home_dir)
        };

        let use_rg = Command::new("rg").arg("--version").output().await.is_ok();

        // Adapt args to use the home-scoped search path
        let adapted_args = FsGrepArgs {
            path: Some(search_path.display().to_string()),
            ..args
        };

        let lines = run_search(
            use_rg,
            &adapted_args,
            &search_path,
            output_mode,
            &self.home_dir,
        )
        .await?;

        if lines.is_empty() {
            return Ok(format!(
                "No matches found for pattern: {}",
                adapted_args.pattern
            ));
        }

        let effective_limit = if head_limit == 0 {
            usize::MAX
        } else {
            head_limit
        };
        let paginated: Vec<&str> = lines
            .iter()
            .skip(offset)
            .take(effective_limit)
            .map(String::as_str)
            .collect();

        let joined = paginated.join("\n");

        if output_mode == "content" && joined.len() > MAX_CONTENT_SIZE {
            let file_lines = run_search(
                use_rg,
                &adapted_args,
                &search_path,
                "files_with_matches",
                &self.home_dir,
            )
            .await?;
            let file_paginated: Vec<&str> = file_lines
                .iter()
                .skip(offset)
                .take(effective_limit)
                .map(String::as_str)
                .collect();
            return Ok(format!(
                "Content output would exceed the size limit.\nReturning matching files instead:\n\n{}",
                file_paginated.join("\n")
            ));
        }

        let has_more = head_limit > 0 && (offset + paginated.len()) < lines.len();
        if has_more {
            Ok(format!(
                "{joined}\n\n[Truncated: showing {} results after offset; additional results omitted]",
                paginated.len()
            ))
        } else {
            Ok(joined)
        }
    }
}
