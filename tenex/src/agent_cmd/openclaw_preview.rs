//! Pure-local helpers for the `tenex agent import openclaw` command:
//! slug derivation, `--slugs` filter, dry-run preview formatting (text +
//! JSON), and the verbatim "no installation detected" error.
//!
//! All LLM-dependent steps (`distillAgentIdentity`, `distillUserContext`)
//! live in a separate substrate landing later. The functions in this
//! module are the local glue — they take an already-distilled
//! [`DistilledIdentity`] and produce the user-facing output.
//!
//! Mirrors the helper functions and the dry-run / JSON branches in
//! `src/commands/agent/import/openclaw.ts:14-20, 143-147, 188-214,
//! 156-170`.

use serde::Serialize;

use crate::agent_cmd::openclaw_reader::{convert_model_format, OpenClawAgent};

/// Mirror `toSlug` (`openclaw.ts:14-20`):
/// 1. lowercase
/// 2. trim whitespace
/// 3. replace runs of non-alphanumerics with a single `-`
/// 4. strip leading/trailing `-`
pub fn to_slug(name: &str) -> String {
    let lowered = name.to_lowercase();
    let trimmed = lowered.trim();

    let mut out = String::with_capacity(trimmed.len());
    let mut last_was_dash = false;
    for c in trimmed.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_was_dash = false;
        } else if !last_was_dash {
            out.push('-');
            last_was_dash = true;
        }
    }

    // Strip leading + trailing dashes.
    let trimmed_dashes = out.trim_matches('-');
    trimmed_dashes.to_owned()
}

/// Mirror `filterAgents` (`openclaw.ts:143-147`).
///
/// `None` or an empty filter string means "include everything"; the TS
/// path checks `!slugs` which is truthy only when the option is missing
/// or undefined. A passed-but-empty `--slugs ""` would split into `[""]`
/// after `.split(",").map(trim)` and then the filter would match no
/// agents — but commander would not pass an empty string in practice.
/// We mirror the safer "treat empty/whitespace-only as 'no filter'"
/// branch, which is what `Vec<String>` from clap with
/// `value_delimiter = ','` produces when `--slugs` is absent (an empty
/// vec).
pub fn filter_agents<'a>(
    agents: &'a [OpenClawAgent],
    allowed_slugs: &[String],
) -> Vec<&'a OpenClawAgent> {
    if allowed_slugs.is_empty() {
        return agents.iter().collect();
    }
    let allow: indexmap::IndexSet<String> = allowed_slugs
        .iter()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    if allow.is_empty() {
        return agents.iter().collect();
    }
    agents.iter().filter(|a| allow.contains(&a.id)).collect()
}

/// Identity returned by the LLM distillation step. Mirrors the zod
/// schema at `openclaw-distiller.ts:7-14`. Carries owned strings — the
/// distillation runs once per agent and the result is short-lived.
#[derive(Debug, Clone, Serialize)]
pub struct DistilledIdentity {
    pub name: String,
    pub description: String,
    pub role: String,
    #[serde(rename = "useCriteria")]
    pub use_criteria: String,
    pub instructions: String,
}

/// One row of the dry-run preview list. Mirrors the inline `previews`
/// shape at `openclaw.ts:193-198`.
#[derive(Debug, Clone, Serialize)]
pub struct AgentPreview {
    pub id: String,
    pub slug: String,
    pub model: String,
    pub name: String,
    pub description: String,
    pub role: String,
    #[serde(rename = "useCriteria")]
    pub use_criteria: String,
    pub instructions: String,
}

/// Build the preview row from an OpenClaw agent + its distilled identity.
/// `slug` falls back to `agent.id` when the distilled name has no
/// alphanumerics (i.e. `to_slug` returns ""), matching the TS expression
/// `toSlug(identity.name) || agent.id` (`openclaw.ts:192`).
pub fn build_preview(agent: &OpenClawAgent, identity: &DistilledIdentity) -> AgentPreview {
    let candidate = to_slug(&identity.name);
    let slug = if candidate.is_empty() {
        agent.id.clone()
    } else {
        candidate
    };
    AgentPreview {
        id: agent.id.clone(),
        slug,
        model: convert_model_format(&agent.model_primary),
        name: identity.name.clone(),
        description: identity.description.clone(),
        role: identity.role.clone(),
        use_criteria: identity.use_criteria.clone(),
        instructions: identity.instructions.clone(),
    }
}

/// JSON variant of the dry-run output. Matches `JSON.stringify(previews,
/// null, 2)` (`openclaw.ts:202`): 2-space indent, no trailing newline,
/// camelCase keys (via `serde(rename = "useCriteria")`).
pub fn format_preview_json(previews: &[AgentPreview]) -> String {
    serde_json::to_string_pretty(previews).expect("AgentPreview is always serializable")
}

/// Plain-text dry-run output. Mirrors the chalk-coloured block at
/// `openclaw.ts:204-211` byte-for-byte:
///
/// ```text
/// Would import N agent(s):
///
///   <slug> (<name>)
///     Role:         <role>
///     Model:        <model>
///     Description:  <description>
///     Instructions: <first-120-chars>...
/// ```
///
/// `chalk` colours apply via `console::Style` so the wire SGR sequences
/// match TS chalk's output (`green` for slug, `gray` for the rest,
/// `blue` for the leading "Would import…" line).
pub fn format_preview_text(previews: &[AgentPreview]) -> String {
    let blue = console::Style::new().blue();
    let green = console::Style::new().green();
    let gray = console::Style::new().color256(8); // chalk's default gray

    let plural = if previews.len() == 1 { "" } else { "s" };
    let mut out = format!(
        "{}\n",
        blue.apply_to(format!(
            "Would import {} agent{plural}:\n",
            previews.len()
        ))
    );
    for p in previews {
        out.push_str(&format!(
            "{}{}\n",
            green.apply_to(format!("  {}", p.slug)),
            gray.apply_to(format!(" ({})", p.name))
        ));
        out.push_str(&format!(
            "{}\n",
            gray.apply_to(format!("    Role:         {}", p.role))
        ));
        out.push_str(&format!(
            "{}\n",
            gray.apply_to(format!("    Model:        {}", p.model))
        ));
        out.push_str(&format!(
            "{}\n",
            gray.apply_to(format!("    Description:  {}", p.description))
        ));
        let truncated: String = p.instructions.chars().take(120).collect();
        out.push_str(&format!(
            "{}\n",
            gray.apply_to(format!("    Instructions: {truncated}..."))
        ));
    }
    out
}

/// Two-line stderr message printed when `detectOpenClawStateDir` returns
/// `null` and we're not in `--json` mode (`openclaw.ts:163-168`):
///
/// ```text
/// No OpenClaw installation detected.
/// Checked: $OPENCLAW_STATE_DIR, ~/.openclaw, ~/.clawdbot, ~/.moldbot, ~/.moltbot
/// ```
///
/// Returns the lines as a single buffer so the caller can write to the
/// TS-equivalent destination (`process.stderr` via `eprintln!`). `chalk`
/// styling: red for line 1, gray for line 2.
pub fn format_no_installation_detected() -> String {
    let red = console::Style::new().red();
    let gray = console::Style::new().color256(8);
    let mut out = format!("{}\n", red.apply_to("No OpenClaw installation detected."));
    out.push_str(&format!(
        "{}\n",
        gray.apply_to(
            "Checked: $OPENCLAW_STATE_DIR, ~/.openclaw, ~/.clawdbot, ~/.moldbot, ~/.moltbot"
        )
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn agent(id: &str, model: &str) -> OpenClawAgent {
        OpenClawAgent {
            id: id.to_owned(),
            model_primary: model.to_owned(),
            workspace_path: PathBuf::from("/tmp/ws"),
            workspace_files: crate::agent_cmd::openclaw_reader::OpenClawWorkspaceFiles {
                soul: None,
                identity: None,
                agents: None,
                user: None,
            },
        }
    }

    fn identity(name: &str) -> DistilledIdentity {
        DistilledIdentity {
            name: name.to_owned(),
            description: "desc".to_owned(),
            role: "role".to_owned(),
            use_criteria: "always".to_owned(),
            instructions: "x".repeat(200),
        }
    }

    // ── to_slug ────────────────────────────────────────────────────────

    #[test]
    fn to_slug_lowercases_and_replaces_non_alnum_with_dash() {
        assert_eq!(to_slug("Hello World!"), "hello-world");
        assert_eq!(to_slug("Foo  Bar  Baz"), "foo-bar-baz");
        assert_eq!(to_slug("A.B.C"), "a-b-c");
    }

    #[test]
    fn to_slug_strips_leading_and_trailing_dashes() {
        assert_eq!(to_slug("---wrapped---"), "wrapped");
        assert_eq!(to_slug("!!!hi!!!"), "hi");
        assert_eq!(to_slug("  spaces  "), "spaces");
    }

    #[test]
    fn to_slug_collapses_consecutive_non_alnum_runs() {
        // `[^a-z0-9]+` → single dash. Multiple punctuations next to each
        // other should produce one `-` not many.
        assert_eq!(to_slug("foo___bar"), "foo-bar");
        assert_eq!(to_slug("foo!!??bar"), "foo-bar");
    }

    #[test]
    fn to_slug_returns_empty_when_no_alnum_present() {
        assert_eq!(to_slug("!!!"), "");
        assert_eq!(to_slug("   "), "");
        assert_eq!(to_slug(""), "");
    }

    #[test]
    fn to_slug_preserves_digits() {
        assert_eq!(to_slug("Agent 42"), "agent-42");
        assert_eq!(to_slug("v1.2.3"), "v1-2-3");
    }

    // ── filter_agents ──────────────────────────────────────────────────

    #[test]
    fn filter_agents_empty_filter_returns_all() {
        let all = vec![agent("a", "x"), agent("b", "x"), agent("c", "x")];
        let result = filter_agents(&all, &[]);
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn filter_agents_keeps_only_listed_ids() {
        let all = vec![agent("alice", "x"), agent("bob", "x"), agent("carol", "x")];
        let allowed = vec!["alice".to_string(), "carol".to_string()];
        let result = filter_agents(&all, &allowed);
        let ids: Vec<&str> = result.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["alice", "carol"]);
    }

    #[test]
    fn filter_agents_treats_whitespace_only_entries_as_dropped() {
        let all = vec![agent("alpha", "x")];
        let allowed = vec!["   ".to_string(), "".to_string()];
        // Effective allow set is empty → fall through to "no filter".
        let result = filter_agents(&all, &allowed);
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn filter_agents_trims_each_filter_entry() {
        let all = vec![agent("alpha", "x"), agent("beta", "x")];
        let allowed = vec!["  alpha  ".to_string()];
        let result = filter_agents(&all, &allowed);
        let ids: Vec<&str> = result.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["alpha"]);
    }

    // ── build_preview ──────────────────────────────────────────────────

    #[test]
    fn build_preview_uses_distilled_name_for_slug() {
        let a = agent("ag-id", "anthropic/claude-sonnet-4-6");
        let p = build_preview(&a, &identity("Friedrich Hayek"));
        assert_eq!(p.slug, "friedrich-hayek");
        assert_eq!(p.model, "anthropic:claude-sonnet-4-6");
        assert_eq!(p.id, "ag-id");
        assert_eq!(p.name, "Friedrich Hayek");
    }

    #[test]
    fn build_preview_falls_back_to_agent_id_when_name_slugifies_to_empty() {
        // TS: `toSlug(identity.name) || agent.id` (`openclaw.ts:192`).
        let a = agent("fallback", "anthropic/claude");
        let p = build_preview(&a, &identity("!!!"));
        assert_eq!(p.slug, "fallback");
    }

    #[test]
    fn build_preview_carries_through_distilled_fields() {
        let a = agent("ag", "p/m");
        let id = identity("Name");
        let p = build_preview(&a, &id);
        assert_eq!(p.name, id.name);
        assert_eq!(p.description, id.description);
        assert_eq!(p.role, id.role);
        assert_eq!(p.use_criteria, id.use_criteria);
        assert_eq!(p.instructions, id.instructions);
    }

    // ── format_preview_json ────────────────────────────────────────────

    #[test]
    fn format_preview_json_uses_camel_case_use_criteria_key() {
        let a = agent("ag", "p/m");
        let preview = build_preview(&a, &identity("Alpha"));
        let out = format_preview_json(&[preview]);
        assert!(out.contains("\"useCriteria\""));
        // No snake-case slip-through:
        assert!(!out.contains("\"use_criteria\""));
    }

    #[test]
    fn format_preview_json_pretty_prints_with_two_space_indent() {
        let a = agent("ag", "p/m");
        let preview = build_preview(&a, &identity("Alpha"));
        let out = format_preview_json(&[preview]);
        // Top-level `[` then a newline + 2 spaces before the first object.
        assert!(out.starts_with("[\n  {"), "got: {out:?}");
        assert!(!out.ends_with('\n'), "no trailing newline");
    }

    #[test]
    fn format_preview_json_empty_array_is_two_chars() {
        let out = format_preview_json(&[]);
        assert_eq!(out, "[]");
    }

    // ── format_preview_text ────────────────────────────────────────────

    #[test]
    fn format_preview_text_singular_plural_toggles() {
        let a = agent("ag", "p/m");
        let one = build_preview(&a, &identity("Alpha"));
        let multi = vec![one.clone(), one.clone()];
        let single = format_preview_text(&[one]);
        let many = format_preview_text(&multi);
        let single_plain = console::strip_ansi_codes(&single);
        let many_plain = console::strip_ansi_codes(&many);
        assert!(single_plain.contains("Would import 1 agent:"));
        assert!(many_plain.contains("Would import 2 agents:"));
    }

    #[test]
    fn format_preview_text_truncates_instructions_to_120_chars_plus_ellipsis() {
        let a = agent("ag", "p/m");
        let mut id = identity("Alpha");
        id.instructions = "x".repeat(500);
        let preview = build_preview(&a, &id);
        let out = format_preview_text(&[preview]);
        let plain = console::strip_ansi_codes(&out);
        // The truncated chunk + ellipsis. TS source uses `slice(0, 120)`
        // so we should see exactly 120 `x`s followed by `...`.
        let expected_substr = format!("{}{}", "x".repeat(120), "...");
        assert!(
            plain.contains(&expected_substr),
            "expected 120 chars + '...' in: {plain:?}"
        );
        // And the 121st char should NOT survive — i.e. 121 `x`s + `...`
        // should not appear.
        let unexpected = format!("{}{}", "x".repeat(121), "...");
        assert!(!plain.contains(&unexpected));
    }

    #[test]
    fn format_preview_text_includes_role_model_description_lines_in_order() {
        let a = agent("ag", "openrouter/claude");
        let mut id = identity("Alpha");
        id.role = "thinker".to_owned();
        id.description = "a small philosopher".to_owned();
        let preview = build_preview(&a, &id);
        let out = format_preview_text(&[preview]);
        let plain = console::strip_ansi_codes(&out);
        let role_pos = plain.find("Role:         thinker").unwrap();
        let model_pos = plain.find("Model:        openrouter:claude").unwrap();
        let desc_pos = plain.find("Description:  a small philosopher").unwrap();
        assert!(role_pos < model_pos);
        assert!(model_pos < desc_pos);
    }

    // ── format_no_installation_detected ────────────────────────────────

    #[test]
    fn no_installation_message_contains_verbatim_strings() {
        let out = format_no_installation_detected();
        let plain = console::strip_ansi_codes(&out);
        assert!(plain.starts_with("No OpenClaw installation detected.\n"));
        assert!(plain.contains(
            "Checked: $OPENCLAW_STATE_DIR, ~/.openclaw, ~/.clawdbot, ~/.moldbot, ~/.moltbot"
        ));
    }
}
