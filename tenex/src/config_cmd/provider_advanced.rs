//! `tenex config provider-advanced` — edit per-provider `baseUrl`,
//! `timeout`, and `options` in `providers.json`.
//!
//! The main `tenex config providers` wizard mutates only `apiKey`; the
//! other three fields round-trip but have no UI path. This subcommand
//! fills the gap.
//!
//! Single-shot interaction (the top-level menu loops). Workflow:
//!
//! 1. Pick a provider that already has at least one key configured.
//! 2. Edit baseUrl (empty input clears).
//! 3. Edit timeout (empty or zero clears; otherwise milliseconds).
//! 4. Edit options as a JSON object (empty or `{}` clears).
//! 5. Persist.

use anyhow::{anyhow, Result};
use serde_json::{Map, Value};

use crate::store::providers::ProvidersDoc;
use crate::tui::prompts;

pub fn run(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = ProvidersDoc::load(base_dir)?;
    let provider_ids = doc.provider_ids();

    if provider_ids.is_empty() {
        crate::tui::display::hint(
            "No providers configured. Run `tenex config providers` to add one first.",
        );
        return Ok(());
    }

    let provider = match prompts::select("Select provider:", provider_ids).prompt() {
        Ok(p) => p,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("provider select: {e}")),
    };

    let (current_base_url, current_timeout, current_options) = match doc.get(&provider) {
        Some(entry) => (
            entry.base_url().map(str::to_owned).unwrap_or_default(),
            entry.timeout(),
            entry
                .options()
                .map(|m| serde_json::to_string_pretty(m).unwrap_or_else(|_| String::new()))
                .unwrap_or_default(),
        ),
        None => (String::new(), None, String::new()),
    };

    render_current(&provider, &current_base_url, current_timeout, &current_options);

    // baseUrl.
    let base_url_raw = match prompts::input("baseUrl (empty to clear):")
        .with_default(&current_base_url)
        .with_help_message("Custom provider endpoint URL, or empty for provider default")
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("baseUrl prompt: {e}")),
    };
    let base_url_trimmed = base_url_raw.trim();
    let new_base_url = if base_url_trimmed.is_empty() {
        None
    } else {
        Some(base_url_trimmed.to_owned())
    };

    // timeout (milliseconds).
    let timeout_default = current_timeout.map(|t| t.to_string()).unwrap_or_default();
    let timeout_raw = match prompts::input("timeout in ms (empty or 0 to clear):")
        .with_default(&timeout_default)
        .with_validator(prompts::adapt_static_str_validator(validate_timeout))
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("timeout prompt: {e}")),
    };
    let new_timeout = parse_timeout(&timeout_raw);

    // options (JSON object).
    let options_raw = match prompts::input("options as JSON object (empty or {} to clear):")
        .with_default(&current_options)
        .with_help_message("Provider-specific extra fields, e.g. {\"organization\":\"org_…\"}")
        .with_validator(prompts::adapt_static_str_validator(validate_options))
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("options prompt: {e}")),
    };
    let new_options = parse_options(&options_raw)?;

    doc.set_base_url(&provider, new_base_url)?;
    doc.set_timeout(&provider, new_timeout)?;
    doc.set_options(&provider, new_options)?;
    doc.save(base_dir)?;

    crate::tui::display::config_success(&format!(
        "Advanced options updated for provider \"{provider}\"."
    ));
    Ok(())
}

fn render_current(provider: &str, base_url: &str, timeout: Option<u64>, options: &str) {
    use crate::tui::theme::chalk_dim;
    println!("\n{}", chalk_dim(&format!("  Provider: {provider}")));
    println!(
        "{}",
        chalk_dim(&format!(
            "  baseUrl:  {}",
            if base_url.is_empty() {
                "(unset)"
            } else {
                base_url
            }
        ))
    );
    println!(
        "{}",
        chalk_dim(&format!(
            "  timeout:  {}",
            match timeout {
                Some(t) => format!("{t} ms"),
                None => "(unset)".to_owned(),
            }
        ))
    );
    if options.is_empty() {
        println!("{}", chalk_dim("  options:  (unset)"));
    } else {
        println!("{}", chalk_dim("  options:"));
        for line in options.lines() {
            println!("{}", chalk_dim(&format!("    {line}")));
        }
    }
    println!();
}

/// Accept empty (clears) or a non-negative integer that fits in u64.
fn validate_timeout(input: &str) -> Result<(), &'static str> {
    let t = input.trim();
    if t.is_empty() {
        return Ok(());
    }
    match t.parse::<u64>() {
        Ok(_) => Ok(()),
        Err(_) => Err("Must be a non-negative integer (milliseconds), or empty"),
    }
}

fn parse_timeout(input: &str) -> Option<u64> {
    let t = input.trim();
    if t.is_empty() {
        return None;
    }
    match t.parse::<u64>() {
        Ok(0) => None,
        Ok(n) => Some(n),
        Err(_) => None,
    }
}

/// Accept empty (clears), `{}` (clears), or a JSON object literal.
fn validate_options(input: &str) -> Result<(), &'static str> {
    let t = input.trim();
    if t.is_empty() {
        return Ok(());
    }
    match serde_json::from_str::<Value>(t) {
        Ok(Value::Object(_)) => Ok(()),
        Ok(_) => Err("options must be a JSON object, e.g. {\"key\":\"value\"}"),
        Err(_) => Err("Invalid JSON — must be an object literal or empty"),
    }
}

fn parse_options(input: &str) -> Result<Option<Map<String, Value>>> {
    let t = input.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let parsed: Value = serde_json::from_str(t).map_err(|e| anyhow!("invalid options JSON: {e}"))?;
    match parsed {
        Value::Object(m) if m.is_empty() => Ok(None),
        Value::Object(m) => Ok(Some(m)),
        _ => Err(anyhow!("options must be a JSON object")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_timeout_accepts_empty() {
        assert!(validate_timeout("").is_ok());
        assert!(validate_timeout("   ").is_ok());
    }

    #[test]
    fn validate_timeout_accepts_non_negative_integer() {
        assert!(validate_timeout("0").is_ok());
        assert!(validate_timeout("30000").is_ok());
    }

    #[test]
    fn validate_timeout_rejects_negative_or_garbage() {
        assert!(validate_timeout("-1").is_err());
        assert!(validate_timeout("abc").is_err());
        assert!(validate_timeout("1.5").is_err());
    }

    #[test]
    fn parse_timeout_treats_zero_and_empty_as_unset() {
        assert_eq!(parse_timeout(""), None);
        assert_eq!(parse_timeout("0"), None);
        assert_eq!(parse_timeout("  "), None);
    }

    #[test]
    fn parse_timeout_returns_positive_value() {
        assert_eq!(parse_timeout("30000"), Some(30000));
    }

    #[test]
    fn validate_options_accepts_empty_and_object() {
        assert!(validate_options("").is_ok());
        assert!(validate_options("{}").is_ok());
        assert!(validate_options("{\"a\":1}").is_ok());
    }

    #[test]
    fn validate_options_rejects_non_object() {
        assert!(validate_options("[1,2,3]").is_err());
        assert!(validate_options("\"hi\"").is_err());
        assert!(validate_options("not json").is_err());
    }

    #[test]
    fn parse_options_returns_none_for_empty_or_empty_object() {
        assert!(parse_options("").unwrap().is_none());
        assert!(parse_options("{}").unwrap().is_none());
    }

    #[test]
    fn parse_options_returns_object() {
        let parsed = parse_options("{\"organization\":\"org_x\"}").unwrap();
        let map = parsed.unwrap();
        assert_eq!(map.get("organization").and_then(Value::as_str), Some("org_x"));
    }
}
