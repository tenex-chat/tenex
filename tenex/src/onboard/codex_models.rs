//! Codex model discovery — types and pure formatters.
//!
//! Source: `src/llm/utils/codex-models.ts`. Three exports:
//!
//! - [`CodexModelOption`] — the Rust mirror of `CodexModelOption`
//!   (`codex-models.ts:16-22`).
//! - [`format_codex_model`] — the pure two-line formatter
//!   (`codex-models.ts:48-52`).
//! - **`list_codex_models`** (TS `listCodexModels`, lines 26-37) is
//!   gated. It depends on the `ai-sdk-provider-codex-cli` JS package,
//!   which talks to the local `codex` CLI over IPC. The Rust port
//!   doesn't yet have a Codex SDK adapter — once it lands, the gated
//!   path drops in here and uses the same [`CodexModelOption`] shape.

/// Mirror of `CodexModelOption` (`codex-models.ts:16-22`).
///
/// The TS source distinguishes between `id` (the SDK-returned model
/// identifier) and `displayName` (the human-readable form, falling
/// back to `id` when the SDK provides no name). `description` defaults
/// to `""` and `is_default` to `false` when the SDK omits them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexModelOption {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
}

/// Mirror `formatCodexModel` (`codex-models.ts:48-52`).
///
/// Renders a Codex model option as two lines:
///
/// ```text
/// {id}[ (default)]
///   {description}
/// ```
///
/// The default marker is appended directly to `id` (not `display_name`)
/// — the TS source uses `${model.id}${defaultMark}` exactly.
pub fn format_codex_model(model: &CodexModelOption) -> String {
    let default_mark = if model.is_default { " (default)" } else { "" };
    format!("{}{}\n  {}", model.id, default_mark, model.description)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opt(id: &str, name: &str, desc: &str, default: bool) -> CodexModelOption {
        CodexModelOption {
            id: id.into(),
            display_name: name.into(),
            description: desc.into(),
            is_default: default,
        }
    }

    #[test]
    fn format_codex_model_adds_default_marker_only_for_default() {
        let m = opt("gpt-5.1-codex-max", "Codex Max", "max-tier coding model", true);
        assert_eq!(
            format_codex_model(&m),
            "gpt-5.1-codex-max (default)\n  max-tier coding model"
        );
    }

    #[test]
    fn format_codex_model_omits_default_marker_for_non_default() {
        let m = opt("gpt-5.1-codex-mini", "Codex Mini", "smaller coding model", false);
        assert_eq!(
            format_codex_model(&m),
            "gpt-5.1-codex-mini\n  smaller coding model"
        );
    }

    #[test]
    fn format_codex_model_appends_marker_to_id_not_display_name() {
        // TS: `${model.id}${defaultMark}` — the marker chases the id,
        // even when display_name differs. Pin that behaviour.
        let m = opt("the-id", "Different Display", "desc", true);
        let out = format_codex_model(&m);
        assert!(out.starts_with("the-id (default)\n"));
        assert!(!out.contains("Different Display"));
    }

    #[test]
    fn format_codex_model_preserves_empty_description_with_two_space_indent() {
        // TS template literal always emits the leading "  " before
        // description, even if description is empty — so an empty
        // description renders as a trailing line with just two spaces.
        let m = opt("gpt-5.1-codex", "", "", false);
        assert_eq!(format_codex_model(&m), "gpt-5.1-codex\n  ");
    }

    #[test]
    fn format_codex_model_byte_for_byte_match_ts_template() {
        // Pin the literal template bytes against an end-to-end input.
        let m = CodexModelOption {
            id: "gpt-5.1-codex-max".into(),
            display_name: "Codex Max".into(),
            description: "Highest-quality Codex model.".into(),
            is_default: true,
        };
        let expected = "gpt-5.1-codex-max (default)\n  Highest-quality Codex model.";
        assert_eq!(format_codex_model(&m), expected);
    }
}
