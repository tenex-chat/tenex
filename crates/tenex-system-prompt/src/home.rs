pub struct InjectedFile {
    pub filename: String,
    pub content: String,
    pub truncated: bool,
}

pub struct HomeDirectoryInfo<'a> {
    pub home_dir: &'a str,
    pub file_count: &'a str,
    pub injected_files: &'a [InjectedFile],
}

pub(crate) fn render_home_directory(info: &HomeDirectoryInfo) -> String {
    let mut parts = vec![
        "<home-directory>".to_string(),
        format!(
            "You have a personal home directory at: `{}`. This is *your* space to use as you see fit. The contents of this directory are persistent and private to you.",
            info.home_dir
        ),
        String::new(),
        format!("**Current contents:** {}", info.file_count),
        String::new(),
        "Use this space for notes, helper scripts, temporary files, or any personal workspace needs. Use descriptive names for your files so you can easily find them later.".to_string(),
        String::new(),
        "**Shell env files:** Shell sessions automatically load environment variables from `.env` files with precedence `agent > project > global`. Your nsec is in your home directory's `.env` file as `NSEC`. `.env` contents are NOT injected into your prompt. Reference them in shell commands with normal shell expansion such as `$NSEC` or `$OPENAI_API_KEY`.".to_string(),
        String::new(),
        "**Note on ~:** The shell `~` expands to the user's real home directory (via `$HOME`), NOT your agent home. To access your agent home directory in shell commands, use `$AGENT_HOME`.".to_string(),
        String::new(),
        "**Auto-injected files:** Files starting with `+` (e.g., `+NOTES.md`) are automatically injected into your system prompt on every execution. Keep `+` files **lean and poignant** — only include things you genuinely need at *every* execution (standing rules, critical reminders, active constraints). Do NOT use `+` files for: status reports, task logs, one-off findings, transient state, or detailed reference material. Instead, write that content in a regular (non-`+`) file and add a brief reference to it from your `+` file so you can read it when relevant. Keep each `+` file under **100 lines** — if it exceeds that, extract the detail into a non-`+` file and replace it with a pointer.".to_string(),
    ];

    if !info.injected_files.is_empty() {
        parts.push(String::new());
        parts.push("<memorized-files>".to_string());
        for file in info.injected_files {
            let truncated_attr = if file.truncated {
                " truncated=\"true\""
            } else {
                ""
            };
            parts.push(format!(
                "  <file name=\"{}\"{}>{}</file>",
                file.filename, truncated_attr, file.content
            ));
        }
        parts.push("</memorized-files>".to_string());
    }

    parts.push("</home-directory>".to_string());
    parts.join("\n")
}
