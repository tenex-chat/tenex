//! Pure prompt builders for the OpenClaw → TENEX agent identity distillation.
//!
//! Source: `src/commands/agent/import/openclaw-distiller.ts`. The TS file
//! contains four exports:
//!
//! - [`build_distillation_prompt`] — pure text builder (here)
//! - [`build_user_context_prompt`] — pure text builder (here)
//! - `distillAgentIdentity` — async, calls `LLMServiceFactory.generateObject`
//!   against a `DistilledIdentitySchema`. Substrate pending — see
//!   `agent_cmd::run_openclaw_import` honest hint.
//! - `distillUserContext`   — async, calls `LLMServiceFactory.generateText`.
//!   Substrate pending.
//!
//! The two pure builders are byte-for-byte verbatim ports. The strings here
//! are user-visible (they end up in the LLM prompt) — every newline, every
//! word, every list bullet matches TS exactly.

use crate::agent_cmd::openclaw_reader::OpenClawWorkspaceFiles;

/// Mirror `buildDistillationPrompt` (`openclaw-distiller.ts:16-43`).
///
/// Concatenates the present workspace files into XML-tagged sections in
/// the order soul → identity → agents (USER.md is intentionally NOT
/// included — it's the input to the *user-context* prompt instead, which
/// is a separate LLM call). Sections are joined with two newlines, then
/// appended after the static instructions block.
pub fn build_distillation_prompt(files: &OpenClawWorkspaceFiles) -> String {
    let mut sections: Vec<String> = Vec::with_capacity(3);
    if let Some(soul) = &files.soul {
        sections.push(format!("<SOUL.md>\n{soul}\n</SOUL.md>"));
    }
    if let Some(identity) = &files.identity {
        sections.push(format!("<IDENTITY.md>\n{identity}\n</IDENTITY.md>"));
    }
    if let Some(agents) = &files.agents {
        sections.push(format!("<AGENTS.md>\n{agents}\n</AGENTS.md>"));
    }

    let body = sections.join("\n\n");
    format!(
        "You are extracting a portable agent identity from an OpenClaw installation.\n\
         Given these workspace files, return a JSON object with exactly these fields:\n\
         \n\
         - name: the agent's display name (string)\n\
         - description: one-sentence description of who this agent is (string)\n\
         - role: short phrase describing expertise/personality, e.g. \"personal AI assistant\" (string)\n\
         - useCriteria: when this agent should be selected over others (string)\n\
         - instructions: a clean, platform-agnostic system prompt capturing the agent's\n  \
         personality, behavioral guidelines, and identity. Discard anything specific\n  \
         to OpenClaw: heartbeat polling, HEARTBEAT_OK responses, workspace file reading\n  \
         rituals, emoji reaction guidance, silence tokens, tool-specific commands,\n  \
         and memory file management instructions. (string)\n\
         \n\
         {body}"
    )
}

/// Mirror `buildUserContextPrompt` (`openclaw-distiller.ts:86-100`).
///
/// Wraps `raw_user_md` in `<USER.md>...</USER.md>` and prefixes a static
/// instruction block telling the model to keep useful content and drop
/// noise. Returns the combined string ready to send to the LLM.
pub fn build_user_context_prompt(raw_user_md: &str) -> String {
    format!(
        "You are cleaning up a user profile document for use as context in an AI assistant's system prompt.\n\
         \n\
         Given the raw USER.md content below, produce a clean, concise summary of everything that would be useful for an AI assistant to know about this user. Write it as a brief markdown section.\n\
         \n\
         Keep anything that helps the assistant interact better: name, preferences, timezone, communication style, interests, projects, technical background, etc.\n\
         \n\
         Drop anything that is noise: unknown/empty fields, platform-specific metadata (IDs, timestamps of first conversations), internal bookkeeping, and formatting artifacts.\n\
         \n\
         If the document contains almost nothing useful, return an empty string.\n\
         \n\
         <USER.md>\n\
         {raw_user_md}\n\
         </USER.md>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_files() -> OpenClawWorkspaceFiles {
        OpenClawWorkspaceFiles {
            soul: None,
            identity: None,
            agents: None,
            user: None,
        }
    }

    // ── build_distillation_prompt ───────────────────────────────────────

    #[test]
    fn distillation_prompt_includes_all_provided_files() {
        // Mirror TS `__tests__/openclaw-distiller.test.ts:6-17` — every
        // file's content surfaces, and the static field-list intro stays
        // at the top.
        let prompt = build_distillation_prompt(&OpenClawWorkspaceFiles {
            soul: Some("# Soul\nBe helpful.".into()),
            identity: Some("# Identity\n- **Name:** Clippy".into()),
            agents: Some("# Agents\nBe safe.".into()),
            user: None,
        });
        assert!(prompt.contains("Be helpful."), "got:\n{prompt}");
        assert!(prompt.contains("Clippy"), "got:\n{prompt}");
        assert!(prompt.contains("Be safe."), "got:\n{prompt}");
        assert!(prompt.contains("portable agent identity"), "got:\n{prompt}");
    }

    #[test]
    fn distillation_prompt_omits_sections_for_none_files() {
        // Mirror TS test (`:19-29`) — when only `soul` is set, the
        // <IDENTITY.md> and <AGENTS.md> tags must NOT appear.
        let prompt = build_distillation_prompt(&OpenClawWorkspaceFiles {
            soul: Some("Soul content".into()),
            identity: None,
            agents: None,
            user: None,
        });
        assert!(prompt.contains("Soul content"));
        assert!(!prompt.contains("IDENTITY.md"));
        assert!(!prompt.contains("AGENTS.md"));
    }

    #[test]
    fn distillation_prompt_user_md_is_never_included() {
        // The user file is the input to the *separate* user-context
        // prompt; the identity prompt deliberately drops it (TS source
        // checks `files.soul / .identity / .agents` and never `.user`).
        let prompt = build_distillation_prompt(&OpenClawWorkspaceFiles {
            soul: None,
            identity: None,
            agents: None,
            user: Some("- **Name:** Pablo".into()),
        });
        assert!(!prompt.contains("Pablo"));
        assert!(!prompt.contains("USER.md"));
    }

    #[test]
    fn distillation_prompt_section_order_is_soul_then_identity_then_agents() {
        let prompt = build_distillation_prompt(&OpenClawWorkspaceFiles {
            soul: Some("S".into()),
            identity: Some("I".into()),
            agents: Some("A".into()),
            user: None,
        });
        let soul = prompt.find("<SOUL.md>").unwrap();
        let identity = prompt.find("<IDENTITY.md>").unwrap();
        let agents = prompt.find("<AGENTS.md>").unwrap();
        assert!(soul < identity, "soul < identity");
        assert!(identity < agents, "identity < agents");
    }

    #[test]
    fn distillation_prompt_sections_are_joined_with_two_newlines() {
        // TS `sections.join("\n\n")` between consecutive XML blocks.
        let prompt = build_distillation_prompt(&OpenClawWorkspaceFiles {
            soul: Some("S".into()),
            identity: Some("I".into()),
            agents: None,
            user: None,
        });
        // Find: closing `</SOUL.md>` then `\n\n` then `<IDENTITY.md>`.
        let soul_close = prompt.find("</SOUL.md>").unwrap();
        let identity_open = prompt.find("<IDENTITY.md>").unwrap();
        let between = &prompt[soul_close + "</SOUL.md>".len()..identity_open];
        assert_eq!(between, "\n\n", "got: {between:?}");
    }

    #[test]
    fn distillation_prompt_has_blank_line_before_section_block() {
        // TS template has a blank line between the field-list and the
        // sections (the `${sections.join(...)}` interpolation is on its
        // own line, with a blank line above per the template).
        let prompt = build_distillation_prompt(&empty_files());
        // No sections → just the instructions + a trailing empty body.
        // The end of the string must be the field-list with NO XML
        // sections appended.
        assert!(!prompt.contains("<SOUL.md>"));
        assert!(!prompt.contains("<IDENTITY.md>"));
        assert!(!prompt.contains("<AGENTS.md>"));
        // And the instruction block is present.
        assert!(prompt.contains("instructions: a clean, platform-agnostic system prompt"));
    }

    #[test]
    fn distillation_prompt_field_list_strings_match_ts_verbatim() {
        // Pin the user-visible strings — these are part of the contract
        // with the LLM (the schema fields it returns must match these
        // names: name, description, role, useCriteria, instructions).
        let prompt = build_distillation_prompt(&empty_files());
        for needle in [
            "- name: the agent's display name (string)",
            "- description: one-sentence description of who this agent is (string)",
            "- role: short phrase describing expertise/personality, e.g. \"personal AI assistant\" (string)",
            "- useCriteria: when this agent should be selected over others (string)",
            "- instructions: a clean, platform-agnostic system prompt capturing the agent's",
            "Discard anything specific\n  to OpenClaw: heartbeat polling, HEARTBEAT_OK responses, workspace file reading",
            "rituals, emoji reaction guidance, silence tokens, tool-specific commands,",
            "and memory file management instructions. (string)",
        ] {
            assert!(prompt.contains(needle), "missing: {needle:?}\n--- prompt ---\n{prompt}");
        }
    }

    // ── build_user_context_prompt ──────────────────────────────────────

    #[test]
    fn user_context_prompt_includes_raw_content_inside_user_md_tags() {
        // Mirror TS test (`:33-39`) — content surfaces, `<USER.md>` tag
        // appears, content is wrapped between open/close tags.
        let raw = "- **Name:** Pablo\n- **Timezone:** GMT+2";
        let prompt = build_user_context_prompt(raw);
        assert!(prompt.contains("Pablo"));
        assert!(prompt.contains("GMT+2"));
        assert!(prompt.contains("<USER.md>"));
        assert!(prompt.contains("</USER.md>"));
        let open = prompt.find("<USER.md>").unwrap();
        let close = prompt.find("</USER.md>").unwrap();
        assert!(open < close);
        let between = &prompt[open + "<USER.md>".len()..close];
        // The TS template inserts a leading + trailing newline around
        // the raw content (`\n${rawUserMd}\n`).
        assert_eq!(between, format!("\n{raw}\n"));
    }

    #[test]
    fn user_context_prompt_instructs_to_drop_noise_and_keep_useful_info() {
        // Mirror TS test (`:41-45`) — pin the two key instruction
        // phrases the LLM is told to act on.
        let prompt = build_user_context_prompt("anything");
        assert!(prompt.contains("Drop anything that is noise"));
        assert!(prompt.contains("useful for an AI assistant"));
    }

    #[test]
    fn user_context_prompt_static_intro_strings_match_ts_verbatim() {
        let prompt = build_user_context_prompt("");
        for needle in [
            "You are cleaning up a user profile document for use as context in an AI assistant's system prompt.",
            "Given the raw USER.md content below, produce a clean, concise summary of everything that would be useful for an AI assistant to know about this user. Write it as a brief markdown section.",
            "Keep anything that helps the assistant interact better: name, preferences, timezone, communication style, interests, projects, technical background, etc.",
            "Drop anything that is noise: unknown/empty fields, platform-specific metadata (IDs, timestamps of first conversations), internal bookkeeping, and formatting artifacts.",
            "If the document contains almost nothing useful, return an empty string.",
        ] {
            assert!(prompt.contains(needle), "missing: {needle:?}\n--- prompt ---\n{prompt}");
        }
    }

    #[test]
    fn user_context_prompt_handles_empty_raw_input() {
        // Empty raw content still produces a well-formed prompt with
        // `<USER.md>\n\n</USER.md>` (open, blank line, close).
        let prompt = build_user_context_prompt("");
        assert!(prompt.contains("<USER.md>\n\n</USER.md>"));
    }

    // ── byte-for-byte fixed-output verification ─────────────────────────

    #[test]
    fn distillation_prompt_full_output_byte_for_byte_match_ts_template() {
        // The TS template is a `\`...\`` literal with `${sections.join(...)}`
        // at the very end. For files = soul:"S", identity:"I", agents:"A"
        // the full output is the static block plus three XML tagged
        // sections joined by "\n\n". Pin every byte.
        let prompt = build_distillation_prompt(&OpenClawWorkspaceFiles {
            soul: Some("S".into()),
            identity: Some("I".into()),
            agents: Some("A".into()),
            user: None,
        });
        let expected = "\
You are extracting a portable agent identity from an OpenClaw installation.
Given these workspace files, return a JSON object with exactly these fields:

- name: the agent's display name (string)
- description: one-sentence description of who this agent is (string)
- role: short phrase describing expertise/personality, e.g. \"personal AI assistant\" (string)
- useCriteria: when this agent should be selected over others (string)
- instructions: a clean, platform-agnostic system prompt capturing the agent's
  personality, behavioral guidelines, and identity. Discard anything specific
  to OpenClaw: heartbeat polling, HEARTBEAT_OK responses, workspace file reading
  rituals, emoji reaction guidance, silence tokens, tool-specific commands,
  and memory file management instructions. (string)

<SOUL.md>
S
</SOUL.md>

<IDENTITY.md>
I
</IDENTITY.md>

<AGENTS.md>
A
</AGENTS.md>";
        assert_eq!(prompt, expected);
    }

    #[test]
    fn user_context_prompt_full_output_byte_for_byte_match_ts_template() {
        let prompt = build_user_context_prompt("hello");
        let expected = "\
You are cleaning up a user profile document for use as context in an AI assistant's system prompt.

Given the raw USER.md content below, produce a clean, concise summary of everything that would be useful for an AI assistant to know about this user. Write it as a brief markdown section.

Keep anything that helps the assistant interact better: name, preferences, timezone, communication style, interests, projects, technical background, etc.

Drop anything that is noise: unknown/empty fields, platform-specific metadata (IDs, timestamps of first conversations), internal bookkeeping, and formatting artifacts.

If the document contains almost nothing useful, return an empty string.

<USER.md>
hello
</USER.md>";
        assert_eq!(prompt, expected);
    }
}
