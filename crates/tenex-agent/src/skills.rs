use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum SkillScope {
    BuiltIn,
    Agent,
    AgentProject,
    Project,
    Shared,
}

impl SkillScope {
    pub fn as_key(&self) -> &'static str {
        match self {
            SkillScope::BuiltIn => "builtIn",
            SkillScope::Agent => "agent",
            SkillScope::AgentProject => "agentProject",
            SkillScope::Project => "project",
            SkillScope::Shared => "shared",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SkillFrontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
    pub tools: Vec<String>,
    pub only_tools: Option<Vec<String>>,
    pub allow_tools: Option<Vec<String>>,
    pub deny_tools: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct SkillData {
    pub id: String,
    pub scope: SkillScope,
    pub content: String,
    pub local_dir: PathBuf,
    pub frontmatter: Option<SkillFrontmatter>,
}

pub struct SkillLookupCtx {
    pub agent_pubkey: String,
    pub project_path: String,
    pub base_dir: PathBuf,
    pub agent_config_path: String,
}

// ─── Frontmatter parser ───────────────────────────────────────────────────────

fn strip_quotes(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')))
    {
        return s[1..s.len() - 1].to_string();
    }
    s.to_string()
}

fn parse_yaml_list(lines: &[&str], start: usize, parent_indent: usize) -> (usize, Vec<String>) {
    let mut items = Vec::new();
    let mut i = start;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            i += 1;
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent <= parent_indent {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("- ") {
            let value = strip_quotes(rest);
            if !value.is_empty() {
                items.push(value);
            }
        } else {
            break;
        }
        i += 1;
    }
    (i, items)
}

/// Parse a `---`-delimited SKILL.md into frontmatter + body content.
/// Replicates TypeScript `parseSkillDocument` behavior.
pub fn parse_skill_document(raw: &str) -> (Option<SkillFrontmatter>, String) {
    // Strip BOM, normalize line endings
    let normalized = raw.trim_start_matches('\u{FEFF}').replace("\r\n", "\n");

    if !normalized.starts_with("---\n") {
        return (None, normalized.trim().to_string());
    }

    let lines: Vec<&str> = normalized.splitn(2, '\n').collect();
    if lines.len() < 2 {
        return (None, normalized.trim().to_string());
    }

    // Find closing ---
    let rest = lines[1];
    let rest_lines: Vec<&str> = rest.lines().collect();
    let closing = rest_lines.iter().position(|l| l.trim() == "---");

    let Some(closing_idx) = closing else {
        return (None, normalized.trim().to_string());
    };

    let frontmatter_lines = &rest_lines[..closing_idx];
    let body: String = rest_lines[closing_idx + 1..].join("\n").trim().to_string();

    let fm = parse_frontmatter(frontmatter_lines);
    (Some(fm), body)
}

fn parse_frontmatter(lines: &[&str]) -> SkillFrontmatter {
    let mut fm = SkillFrontmatter::default();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();

        if trimmed.is_empty() || trimmed.starts_with('#') {
            i += 1;
            continue;
        }

        let indent = line.len() - line.trim_start().len();
        if indent > 0 {
            i += 1;
            continue;
        }

        let Some(colon_pos) = line.find(':') else {
            i += 1;
            continue;
        };
        if colon_pos == 0 {
            i += 1;
            continue;
        }

        let key = line[..colon_pos].trim();
        let raw_value = line[colon_pos + 1..].trim();

        // List fields
        if matches!(key, "tools" | "only-tools" | "allow-tools" | "deny-tools")
            && raw_value.is_empty()
        {
            let (next_i, items) = parse_yaml_list(lines, i + 1, indent);
            match key {
                "tools" => fm.tools = items,
                "only-tools" => fm.only_tools = if items.is_empty() { None } else { Some(items) },
                "allow-tools" => fm.allow_tools = if items.is_empty() { None } else { Some(items) },
                "deny-tools" => fm.deny_tools = if items.is_empty() { None } else { Some(items) },
                _ => {}
            }
            i = next_i;
            continue;
        }

        // Scalar fields
        let value = strip_quotes(raw_value);
        match key {
            "name" if !value.is_empty() => fm.name = Some(value),
            "description" if !value.is_empty() => fm.description = Some(value),
            _ => {}
        }

        i += 1;
    }

    fm
}

// ─── Directory discovery ──────────────────────────────────────────────────────

fn short_pubkey(pubkey: &str) -> &str {
    if pubkey.len() >= 8 {
        &pubkey[..8]
    } else {
        pubkey
    }
}

/// Returns skill lookup directories in precedence order (first-seen-wins).
/// Order replicates TypeScript SkillService.getLookupDirectories() exactly:
/// built-in first, then agent, agent-project, project, shared.
pub fn lookup_dirs(ctx: &SkillLookupCtx) -> Vec<(PathBuf, SkillScope)> {
    let short = short_pubkey(&ctx.agent_pubkey);
    let mut dirs = Vec::new();

    // 1. Built-in (shipped with TENEX installation)
    let builtin = ctx.base_dir.join("skills").join("built-in");
    if builtin.exists() {
        dirs.push((builtin, SkillScope::BuiltIn));
    } else {
        // Dev fallback: source tree relative to this crate's manifest directory
        let dev_builtin =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/skills/built-in");
        if dev_builtin.exists() {
            dirs.push((dev_builtin, SkillScope::BuiltIn));
        }
    }

    // 2. Agent home skills
    let agent_dir = ctx.base_dir.join("home").join(short).join("skills");
    dirs.push((agent_dir, SkillScope::Agent));

    // 3. Agent-project skills
    let agent_project_dir = Path::new(&ctx.project_path)
        .join(".agents")
        .join(short)
        .join("skills");
    dirs.push((agent_project_dir, SkillScope::AgentProject));

    // 4. Project shared skills
    let project_dir = Path::new(&ctx.project_path).join(".agents").join("skills");
    dirs.push((project_dir, SkillScope::Project));

    // 5. Global shared skills
    if let Some(home) = dirs_next::home_dir() {
        dirs.push((home.join(".agents").join("skills"), SkillScope::Shared));
    }

    dirs
}

/// Load a single skill from its directory.
fn load_skill_from_dir(id: &str, dir: &Path, scope: SkillScope) -> Option<SkillData> {
    let skill_md = dir.join("SKILL.md");
    let raw = std::fs::read_to_string(&skill_md).ok()?;
    let (frontmatter, content) = parse_skill_document(&raw);
    Some(SkillData {
        id: id.to_string(),
        scope,
        content,
        local_dir: dir.to_path_buf(),
        frontmatter,
    })
}

/// List all available skills, deduped by ID (first directory's version wins).
pub fn list_available_skills(ctx: &SkillLookupCtx) -> Vec<SkillData> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut skills = Vec::new();

    for (dir, scope) in lookup_dirs(ctx) {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        let mut dir_skills: Vec<SkillData> = entries
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let path = entry.path();
                if !path.is_dir() {
                    return None;
                }
                let id = path.file_name()?.to_str()?.to_string();
                if seen.contains(&id) {
                    return None;
                }
                load_skill_from_dir(&id, &path, scope.clone())
            })
            .collect();

        dir_skills.sort_by(|a, b| a.id.cmp(&b.id));

        for skill in dir_skills {
            seen.insert(skill.id.clone());
            skills.push(skill);
        }
    }

    skills.sort_by(|a, b| a.id.cmp(&b.id));
    skills
}

/// Find a single skill by ID, using the same precedence order.
pub fn find_skill(id: &str, ctx: &SkillLookupCtx) -> Option<SkillData> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    for (dir, scope) in lookup_dirs(ctx) {
        let skill_dir = dir.join(id);
        let skill_md = skill_dir.join("SKILL.md");
        if skill_md.exists() {
            return load_skill_from_dir(id, &skill_dir, scope);
        }
    }
    None
}

/// Fetch a set of skills by ID, preserving request order and skipping missing ones.
pub fn fetch_skills(ids: &[String], ctx: &SkillLookupCtx) -> Vec<SkillData> {
    let mut loaded_ids: HashSet<String> = HashSet::new();
    let mut skills = Vec::new();
    for id in ids {
        let trimmed = id.trim().to_string();
        if trimmed.is_empty() || loaded_ids.contains(&trimmed) {
            continue;
        }
        if let Some(skill) = find_skill(&trimmed, ctx) {
            loaded_ids.insert(trimmed);
            skills.push(skill);
        }
    }
    skills
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/// Replace known path prefixes with their env variable names (longest-prefix-wins).
fn compress_path(path: &Path, path_vars: &[(&str, &str)]) -> String {
    let path_str = path.display().to_string();
    let mut best = path_str.clone();
    let mut best_len = 0usize;
    for (var_name, var_value) in path_vars {
        if path_str.starts_with(var_value) && var_value.len() > best_len {
            best = format!("{}{}", var_name, &path_str[var_value.len()..]);
            best_len = var_value.len();
        }
    }
    best
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Render a single skill as `<skill id="..." path="...">content</skill>`.
/// Omits `path` attribute for built-in scope (matching TypeScript behavior).
pub fn render_skill(skill: &SkillData, path_vars: &[(&str, &str)]) -> String {
    let mut attrs = format!(r#"id="{}""#, escape_attr(&skill.id));

    if skill.scope != SkillScope::BuiltIn {
        let compressed = compress_path(&skill.local_dir, path_vars);
        attrs.push_str(&format!(r#" path="{}""#, escape_attr(&compressed)));
    }

    let content = skill.content.trim();
    if content.is_empty() {
        return format!("<skill {attrs} />");
    }

    format!("<skill {attrs}>\n{content}\n</skill>")
}

/// Render tool permissions guidance text (soft enforcement via LLM prompt).
/// only-tools/allow-tools/deny-tools in SKILL.md cannot actually gate rig tool
/// calls (rig builds tool sets at compile time), so this is best-effort LLM guidance only.
fn render_tool_permissions(only: &[String], allow: &[String], deny: &[String]) -> String {
    let mut lines = Vec::new();

    if !only.is_empty() {
        lines.push(format!(
            "Your available tools are restricted to: {}",
            only.join(", ")
        ));
    } else {
        if !allow.is_empty() {
            lines.push(format!("Additional tools enabled: {}", allow.join(", ")));
        }
        if !deny.is_empty() {
            lines.push(format!("Tools disabled: {}", deny.join(", ")));
        }
    }

    if lines.is_empty() {
        return String::new();
    }

    format!(
        "<skill-tool-permissions>\n<!-- Aggregated across all active skills -->\n{}\n</skill-tool-permissions>",
        lines.join("\n")
    )
}

/// Render the full `<loaded-skills>` block for injection into the system prompt.
pub fn render_loaded_skills_block(skills: &[SkillData], path_vars: &[(&str, &str)]) -> String {
    if skills.is_empty() {
        return String::new();
    }

    let mut parts: Vec<String> = Vec::new();

    // Aggregate permissions across all loaded skills
    let mut only_tools: Vec<String> = Vec::new();
    let mut allow_tools: Vec<String> = Vec::new();
    let mut deny_tools: Vec<String> = Vec::new();
    let mut seen_only = HashSet::new();
    let mut seen_allow = HashSet::new();
    let mut seen_deny = HashSet::new();

    for skill in skills {
        if let Some(fm) = &skill.frontmatter {
            if let Some(only) = &fm.only_tools {
                for t in only {
                    if seen_only.insert(t.clone()) {
                        only_tools.push(t.clone());
                    }
                }
            }
            if fm.only_tools.is_none() {
                if let Some(allow) = &fm.allow_tools {
                    for t in allow {
                        if seen_allow.insert(t.clone()) {
                            allow_tools.push(t.clone());
                        }
                    }
                }
                if let Some(deny) = &fm.deny_tools {
                    for t in deny {
                        if seen_deny.insert(t.clone()) {
                            deny_tools.push(t.clone());
                        }
                    }
                }
            }
        }
    }

    let perm_block = render_tool_permissions(&only_tools, &allow_tools, &deny_tools);
    if !perm_block.is_empty() {
        parts.push(perm_block);
    }

    let rendered_skills: Vec<String> = skills.iter().map(|s| render_skill(s, path_vars)).collect();

    let header = "The following skills have been loaded for this conversation. These provide additional context and capabilities:";
    parts.push(format!("{}\n{}", header, rendered_skills.join("\n\n")));

    format!("<loaded-skills>\n{}\n</loaded-skills>", parts.join("\n\n"))
}

// ─── Agent config write-back (for `always` flag) ─────────────────────────────

/// Update the agent JSON config's `default.skills` field.
/// Uses atomic write (temp file + rename) to avoid partial writes.
pub fn write_skills_to_agent_config(config_path: &str, skill_ids: &[String]) -> anyhow::Result<()> {
    let content = std::fs::read_to_string(config_path)?;
    let mut value: serde_json::Value = serde_json::from_str(&content)?;

    let skills_json = serde_json::Value::Array(
        skill_ids
            .iter()
            .map(|s| serde_json::Value::String(s.clone()))
            .collect(),
    );

    if let Some(obj) = value.as_object_mut() {
        let default_entry = obj
            .entry("default")
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if let Some(default_obj) = default_entry.as_object_mut() {
            default_obj.insert("skills".to_string(), skills_json);
        }
    }

    let updated = serde_json::to_string_pretty(&value)?;
    let tmp_path = format!("{config_path}.tmp");
    std::fs::write(&tmp_path, updated)?;
    std::fs::rename(&tmp_path, config_path)?;

    Ok(())
}

// ─── Skill summary for skill_list tool ───────────────────────────────────────

#[derive(Debug, serde::Serialize)]
pub struct SkillSummary {
    pub identifier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "hasTools")]
    pub has_tools: bool,
    pub scope: String,
}

const MAX_DESCRIPTION_LEN: usize = 150;

impl SkillSummary {
    pub fn from_data(skill: &SkillData) -> Self {
        let fm = skill.frontmatter.as_ref();
        let raw_description = fm.and_then(|f| f.description.clone()).or_else(|| {
            if skill.content.is_empty() {
                None
            } else {
                Some(skill.content.clone())
            }
        });

        let description = raw_description.map(|d| {
            let flat = d.replace('\n', " ");
            match flat.char_indices().nth(MAX_DESCRIPTION_LEN) {
                Some((i, _)) => flat[..i].to_string(),
                None => flat,
            }
        });

        SkillSummary {
            identifier: skill.id.clone(),
            name: fm.and_then(|f| f.name.clone()),
            description,
            has_tools: fm.map(|f| !f.tools.is_empty()).unwrap_or(false),
            scope: skill.scope.as_key().to_string(),
        }
    }
}

/// Group skills by scope into a map keyed by scope string.
pub fn group_by_scope(skills: &[SkillData]) -> HashMap<&'static str, Vec<SkillSummary>> {
    let mut map: HashMap<&'static str, Vec<SkillSummary>> = HashMap::new();
    for scope_key in &["builtIn", "agent", "agentProject", "project", "shared"] {
        map.insert(scope_key, Vec::new());
    }
    for skill in skills {
        let key = skill.scope.as_key();
        map.entry(key)
            .or_default()
            .push(SkillSummary::from_data(skill));
    }
    map
}
