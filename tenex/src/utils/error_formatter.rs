//! Generic tool-error formatter.
//!
//! Mirrors `formatToolError` (`src/lib/error-formatter.ts:83-108`)
//! verbatim. Used by tool-execution paths to produce a single
//! human-readable error string with the right prefix
//! (`Validation error`, `Execution error`, `System error`).
//!
//! The companion `formatStreamError` + `isMeaningfulAiMessage` +
//! `mapErrorToHint` are in [`crate::onboard::llm_test_hints`] —
//! together those four make up the full TS error-formatting surface
//! at `src/lib/error-formatter.ts`.
//!
//! `formatAnyError` is the broader dispatcher in TS that handles
//! arbitrary `unknown` error values; it's not yet ported because the
//! Rust port doesn't have an analogous "any error" entry point — Rust
//! callers already have a typed error (`anyhow::Error`,
//! `&dyn std::error::Error`, etc.) and produce strings via `Display`.

/// Mirror of TS `ToolError` (`error-formatter.ts:1-7`).
///
/// Distinguishes the three error categories that flow through the tool
/// execution pipeline:
///
/// - **Validation** — pre-execution input check failed
/// - **Execution** — the tool itself returned an error during the call
/// - **System** — environment / runtime failure (filesystem, network,
///   etc.) outside the tool's control
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolErrorKind {
    Validation,
    Execution,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    pub kind: ToolErrorKind,
    pub message: String,
    /// For `Validation`: which field. Empty string carries a special
    /// "Missing required parameter" rendering (see source order in
    /// `format_tool_error`).
    pub field: Option<String>,
    /// For `Execution`: which tool produced the error.
    pub tool: Option<String>,
}

/// Mirror `formatToolError` (`error-formatter.ts:83-108`).
///
/// Source-order checks per kind:
///
/// - **`Validation`**:
///   - `field == Some("")` AND `message == "Required"` → `"Validation
///     error: Missing required parameter"` (special case for the
///     zod / ai-sdk default required-field error)
///   - `field == Some(non-empty)` → `"Validation error in <field>:
///     <message>"`
///   - `field == None` → `"Validation error: <message>"`
/// - **`Execution`**:
///   - `tool == Some(_)` → `"Execution error in <tool>: <message>"`
///   - `tool == None` → `"Execution error: <message>"`
/// - **`System`**: always `"System error: <message>"`
pub fn format_tool_error(error: &ToolError) -> String {
    match error.kind {
        ToolErrorKind::Validation => {
            if error.field.as_deref() == Some("") && error.message == "Required" {
                return "Validation error: Missing required parameter".to_owned();
            }
            match error.field.as_deref() {
                Some(field) if !field.is_empty() => {
                    format!("Validation error in {field}: {}", error.message)
                }
                _ => format!("Validation error: {}", error.message),
            }
        }
        ToolErrorKind::Execution => match error.tool.as_deref() {
            Some(tool) if !tool.is_empty() => {
                format!("Execution error in {tool}: {}", error.message)
            }
            _ => format!("Execution error: {}", error.message),
        },
        ToolErrorKind::System => format!("System error: {}", error.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validation(message: &str, field: Option<&str>) -> ToolError {
        ToolError {
            kind: ToolErrorKind::Validation,
            message: message.to_owned(),
            field: field.map(str::to_owned),
            tool: None,
        }
    }

    fn execution(message: &str, tool: Option<&str>) -> ToolError {
        ToolError {
            kind: ToolErrorKind::Execution,
            message: message.to_owned(),
            field: None,
            tool: tool.map(str::to_owned),
        }
    }

    fn system(message: &str) -> ToolError {
        ToolError {
            kind: ToolErrorKind::System,
            message: message.to_owned(),
            field: None,
            tool: None,
        }
    }

    // ── Validation ──────────────────────────────────────────────────────

    #[test]
    fn validation_with_named_field_renders_in_clause() {
        let e = validation("must be a number", Some("limit"));
        assert_eq!(format_tool_error(&e), "Validation error in limit: must be a number");
    }

    #[test]
    fn validation_without_field_omits_in_clause() {
        let e = validation("must be a number", None);
        assert_eq!(format_tool_error(&e), "Validation error: must be a number");
    }

    #[test]
    fn validation_special_case_empty_field_required() {
        // Source: error-formatter.ts:87-89 — the special-case branch
        // produces a friendlier message than the generic "Validation
        // error: Required" that zod default would emit.
        let e = validation("Required", Some(""));
        assert_eq!(
            format_tool_error(&e),
            "Validation error: Missing required parameter"
        );
    }

    #[test]
    fn validation_empty_field_with_other_message_falls_through_to_no_field_branch() {
        // Empty field but the message is something other than "Required" —
        // TS `error.field ? … : …` evaluates `""` as falsy, so this
        // takes the no-field branch.
        let e = validation("must be present", Some(""));
        assert_eq!(
            format_tool_error(&e),
            "Validation error: must be present"
        );
    }

    #[test]
    fn validation_missing_field_with_required_message_does_not_get_special_case() {
        // The special case requires `field === ""` strictly. `field ==
        // None` (TS undefined) takes the falsy `error.field` branch
        // — which produces "Validation error: Required" (not the
        // friendlier message).
        let e = validation("Required", None);
        assert_eq!(format_tool_error(&e), "Validation error: Required");
    }

    // ── Execution ───────────────────────────────────────────────────────

    #[test]
    fn execution_with_named_tool_renders_in_clause() {
        let e = execution("network unreachable", Some("rag_search"));
        assert_eq!(
            format_tool_error(&e),
            "Execution error in rag_search: network unreachable"
        );
    }

    #[test]
    fn execution_without_tool_omits_in_clause() {
        let e = execution("network unreachable", None);
        assert_eq!(
            format_tool_error(&e),
            "Execution error: network unreachable"
        );
    }

    #[test]
    fn execution_empty_tool_falls_through_to_no_tool_branch() {
        // TS `error.tool ? … : …` — empty string is falsy.
        let e = execution("boom", Some(""));
        assert_eq!(format_tool_error(&e), "Execution error: boom");
    }

    // ── System ──────────────────────────────────────────────────────────

    #[test]
    fn system_always_renders_with_system_error_prefix() {
        let e = system("disk full");
        assert_eq!(format_tool_error(&e), "System error: disk full");
    }

    #[test]
    fn system_ignores_field_and_tool_fields() {
        // The TS source's `case "system":` doesn't read `field` or
        // `tool` even if they're present on the object. Mirror that.
        let mut e = system("oom");
        e.field = Some("ignored".into());
        e.tool = Some("ignored".into());
        assert_eq!(format_tool_error(&e), "System error: oom");
    }

    // ── Verbatim TS string check ────────────────────────────────────────

    #[test]
    fn missing_required_special_case_uses_verbatim_string() {
        // The friendlier message is user-facing — pin it.
        let e = validation("Required", Some(""));
        assert_eq!(
            format_tool_error(&e),
            "Validation error: Missing required parameter"
        );
    }
}
