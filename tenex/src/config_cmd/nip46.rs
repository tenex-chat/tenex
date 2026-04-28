//! `tenex config nip46` — NIP-46 remote signing configuration.
//!
//! Source: `src/commands/config/nip46.ts:7-159`. Top-level menu offers
//! 4 actions (toggle, configure, owners, back); the owners sub-menu has
//! its own 3 actions (add, remove [conditional], back).
//!
//! Side-effects per action:
//!
//! - **toggle** (`:29-41`): confirm prompt → write `enabled` boolean,
//!   preserving every other field in the block (TS spread `{...nip46}`).
//!   Success line `✓ NIP-46 enabled` / `✓ NIP-46 disabled`.
//! - **configure** (`:43-82`): two integer prompts (`signingTimeoutMs`
//!   positive, `maxRetries` non-negative); persist both, success line
//!   `✓ NIP-46 settings updated`.
//! - **owners → add** (`:102-139`): hex64-pubkey input + `bunker://`-prefix
//!   URI input; persist via `set_nip46_owner`.
//! - **owners → remove** (`:141-156`): only offered when at least one
//!   owner exists; select-from-current and `remove_nip46_owner`.

use anyhow::{anyhow, Result};

use crate::store::tenex_config::TenexConfigDoc;
use crate::tui::prompts;

pub fn run(base_dir: &std::path::Path) -> Result<()> {
    let doc = TenexConfigDoc::load(base_dir)?;
    drop(doc);

    let action = match prompts::select(
        "NIP-46 Remote Signing Settings",
        top_level_actions(),
    )
    .prompt()
    {
        Ok(a) => a,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("nip46 menu prompt: {e}")),
    };

    match action.value {
        TopAction::Back => Ok(()),
        TopAction::Toggle => run_toggle(base_dir),
        TopAction::Configure => run_configure(base_dir),
        TopAction::Owners => run_owners(base_dir),
    }
}

fn run_toggle(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;
    let prev = doc.nip46_enabled().unwrap_or(false);
    let enabled = match prompts::confirm("Enable NIP-46 remote signing?")
        .with_default(prev)
        .prompt()
    {
        Ok(b) => b,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("nip46 toggle confirm: {e}")),
    };
    doc.set_nip46_enabled(enabled);
    doc.save(base_dir)?;
    let label = if enabled { "enabled" } else { "disabled" };
    print_green(&format!("\n✓ NIP-46 {label}"));
    Ok(())
}

fn run_configure(base_dir: &std::path::Path) -> Result<()> {
    let mut doc = TenexConfigDoc::load(base_dir)?;
    let timeout_default = doc.nip46_signing_timeout_ms().unwrap_or(30_000);
    let retries_default = doc.nip46_max_retries().unwrap_or(2);

    let timeout_validator = prompts::adapt_static_str_validator(validate_positive_integer);
    let timeout_raw = match prompts::input("Signing timeout (ms):")
        .with_default(&timeout_default.to_string())
        .with_validator(timeout_validator)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("signing timeout prompt: {e}")),
    };
    let timeout: u64 = timeout_raw.trim().parse().map_err(|e| anyhow!("post-validate parse: {e}"))?;

    let retries_validator = prompts::adapt_static_str_validator(validate_non_negative_integer);
    let retries_raw = match prompts::input("Max retries:")
        .with_default(&retries_default.to_string())
        .with_validator(retries_validator)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("max retries prompt: {e}")),
    };
    let retries: u64 = retries_raw.trim().parse().map_err(|e| anyhow!("post-validate parse: {e}"))?;

    doc.set_nip46_signing_timeout_ms(timeout);
    doc.set_nip46_max_retries(retries);
    doc.save(base_dir)?;
    print_green("\n✓ NIP-46 settings updated");
    Ok(())
}

fn run_owners(base_dir: &std::path::Path) -> Result<()> {
    let doc = TenexConfigDoc::load(base_dir)?;
    let owner_pubkeys = doc.nip46_owner_pubkeys();
    drop(doc);

    let action = match prompts::select(
        "Manage Owner Bunker URIs",
        owner_actions(!owner_pubkeys.is_empty()),
    )
    .prompt()
    {
        Ok(a) => a,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("owners menu prompt: {e}")),
    };

    match action.value {
        OwnerAction::Back => Ok(()),
        OwnerAction::Add => run_owner_add(base_dir),
        OwnerAction::Remove => run_owner_remove(base_dir),
    }
}

fn run_owner_add(base_dir: &std::path::Path) -> Result<()> {
    let pubkey_validator = prompts::adapt_static_str_validator(validate_hex64);
    let pubkey = match prompts::input("Owner hex pubkey:")
        .with_validator(pubkey_validator)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("owner pubkey prompt: {e}")),
    };
    let uri_validator = prompts::adapt_static_str_validator(validate_bunker_uri);
    let bunker_uri = match prompts::input("Bunker URI (bunker://pubkey?relay=wss://...):")
        .with_validator(uri_validator)
        .prompt()
    {
        Ok(s) => s,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("bunker URI prompt: {e}")),
    };

    let mut doc = TenexConfigDoc::load(base_dir)?;
    doc.set_nip46_owner(pubkey.trim(), bunker_uri.trim());
    doc.save(base_dir)?;
    print_green("\n✓ Owner bunker URI added");
    Ok(())
}

fn run_owner_remove(base_dir: &std::path::Path) -> Result<()> {
    let doc = TenexConfigDoc::load(base_dir)?;
    let owners = doc.nip46_owner_pubkeys();
    let labels: Vec<OwnerChoice> = owners
        .iter()
        .map(|pk| OwnerChoice {
            label: format!(
                "{}... ({})",
                short_pk(pk),
                doc.nip46_owner_bunker_uri(pk).unwrap_or_default()
            ),
            value: pk.clone(),
        })
        .collect();
    drop(doc);

    let chosen = match prompts::select("Select owner to remove:", labels).prompt() {
        Ok(c) => c,
        Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => return Ok(()),
        Err(e) => return Err(anyhow!("owner remove prompt: {e}")),
    };
    let mut doc = TenexConfigDoc::load(base_dir)?;
    doc.remove_nip46_owner(&chosen.value);
    doc.save(base_dir)?;
    print_green("\n✓ Owner bunker URI removed");
    Ok(())
}

/// Match the TS rule at `:50-55`: integer > 0.
pub fn validate_positive_integer(input: &str) -> Result<(), &'static str> {
    if input.is_empty() || !input.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Please enter a positive number");
    }
    let n: u64 = input.parse().unwrap_or(0);
    if n == 0 {
        Err("Please enter a positive number")
    } else {
        Ok(())
    }
}

/// Match the TS rule at `:63-68`: integer ≥ 0.
pub fn validate_non_negative_integer(input: &str) -> Result<(), &'static str> {
    if !input.is_empty() && input.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err("Please enter a non-negative number")
    }
}

/// Match the TS rule at `:108-112`: 64 hex chars (case-insensitive).
pub fn validate_hex64(input: &str) -> Result<(), &'static str> {
    if input.len() == 64
        && input
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F'))
    {
        Ok(())
    } else {
        Err("Please enter a valid 64-character hex pubkey")
    }
}

/// Match the TS rule at `:119-124`: starts with `bunker://`.
pub fn validate_bunker_uri(input: &str) -> Result<(), &'static str> {
    if input.starts_with("bunker://") {
        Ok(())
    } else {
        Err("Bunker URI must start with bunker://")
    }
}

fn short_pk(pubkey: &str) -> String {
    pubkey.chars().take(16).collect()
}

fn print_green(text: &str) {
    let s = console::Style::new().green().apply_to(text);
    println!("{s}");
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TopAction {
    Toggle,
    Configure,
    Owners,
    Back,
}

#[derive(Debug, Clone)]
struct TopActionItem {
    label: String,
    value: TopAction,
}

impl std::fmt::Display for TopActionItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

fn top_level_actions() -> Vec<TopActionItem> {
    let dim_back = console::Style::new().dim().apply_to("Back").to_string();
    vec![
        TopActionItem {
            label: "Enable/Disable NIP-46".into(),
            value: TopAction::Toggle,
        },
        TopActionItem {
            label: "Configure timeout and retries".into(),
            value: TopAction::Configure,
        },
        TopActionItem {
            label: "Manage owner bunker URIs".into(),
            value: TopAction::Owners,
        },
        TopActionItem {
            label: dim_back,
            value: TopAction::Back,
        },
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OwnerAction {
    Add,
    Remove,
    Back,
}

#[derive(Debug, Clone)]
struct OwnerActionItem {
    label: String,
    value: OwnerAction,
}

impl std::fmt::Display for OwnerActionItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

fn owner_actions(has_existing: bool) -> Vec<OwnerActionItem> {
    let mut out = vec![OwnerActionItem {
        label: "Add owner bunker URI".into(),
        value: OwnerAction::Add,
    }];
    if has_existing {
        out.push(OwnerActionItem {
            label: "Remove owner bunker URI".into(),
            value: OwnerAction::Remove,
        });
    }
    let dim_back = console::Style::new().dim().apply_to("Back").to_string();
    out.push(OwnerActionItem {
        label: dim_back,
        value: OwnerAction::Back,
    });
    out
}

#[derive(Debug, Clone)]
struct OwnerChoice {
    label: String,
    value: String,
}

impl std::fmt::Display for OwnerChoice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tenex-config-nip46-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    // ---- validators -----------------------------------------------------

    #[test]
    fn validate_positive_integer_accepts_positive() {
        assert!(validate_positive_integer("1").is_ok());
        assert!(validate_positive_integer("30000").is_ok());
    }

    #[test]
    fn validate_positive_integer_rejects_zero_with_verbatim_message() {
        // `:51` — `num <= 0` rejects 0.
        assert_eq!(
            validate_positive_integer("0"),
            Err("Please enter a positive number")
        );
    }

    #[test]
    fn validate_positive_integer_rejects_garbage_with_verbatim_message() {
        assert_eq!(validate_positive_integer(""), Err("Please enter a positive number"));
        assert_eq!(validate_positive_integer("-1"), Err("Please enter a positive number"));
        assert_eq!(validate_positive_integer("abc"), Err("Please enter a positive number"));
        assert_eq!(validate_positive_integer("3.5"), Err("Please enter a positive number"));
    }

    #[test]
    fn validate_non_negative_integer_accepts_zero() {
        assert!(validate_non_negative_integer("0").is_ok());
        assert!(validate_non_negative_integer("2").is_ok());
        assert!(validate_non_negative_integer("100").is_ok());
    }

    #[test]
    fn validate_non_negative_integer_rejects_with_verbatim_message() {
        assert_eq!(
            validate_non_negative_integer(""),
            Err("Please enter a non-negative number")
        );
        assert_eq!(
            validate_non_negative_integer("-1"),
            Err("Please enter a non-negative number")
        );
        assert_eq!(
            validate_non_negative_integer("abc"),
            Err("Please enter a non-negative number")
        );
    }

    #[test]
    fn validate_hex64_accepts_lowercase_and_uppercase() {
        let lower = "0".repeat(64);
        let upper = "F".repeat(64);
        assert!(validate_hex64(&lower).is_ok());
        assert!(validate_hex64(&upper).is_ok());
    }

    #[test]
    fn validate_hex64_rejects_wrong_length_with_verbatim_message() {
        assert_eq!(
            validate_hex64("abc"),
            Err("Please enter a valid 64-character hex pubkey")
        );
        assert_eq!(
            validate_hex64(&"a".repeat(63)),
            Err("Please enter a valid 64-character hex pubkey")
        );
        assert_eq!(
            validate_hex64(&"a".repeat(65)),
            Err("Please enter a valid 64-character hex pubkey")
        );
    }

    #[test]
    fn validate_hex64_rejects_non_hex_chars() {
        let bad = "0".repeat(63) + "g";
        assert_eq!(
            validate_hex64(&bad),
            Err("Please enter a valid 64-character hex pubkey")
        );
    }

    #[test]
    fn validate_bunker_uri_accepts_bunker_prefix() {
        assert!(validate_bunker_uri("bunker://abc?relay=wss://r").is_ok());
    }

    #[test]
    fn validate_bunker_uri_rejects_other_schemes_with_verbatim_message() {
        assert_eq!(
            validate_bunker_uri("https://abc"),
            Err("Bunker URI must start with bunker://")
        );
        assert_eq!(
            validate_bunker_uri(""),
            Err("Bunker URI must start with bunker://")
        );
    }

    // ---- store accessors -----------------------------------------------

    #[test]
    fn toggle_preserves_other_fields() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_nip46_signing_timeout_ms(60_000);
        doc.set_nip46_max_retries(5);
        doc.set_nip46_enabled(false);
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_nip46_enabled(true);
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(r.nip46_enabled(), Some(true));
        assert_eq!(r.nip46_signing_timeout_ms(), Some(60_000));
        assert_eq!(r.nip46_max_retries(), Some(5));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn configure_preserves_owners() {
        let base = unique_temp();
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_nip46_owner(&"a".repeat(64), "bunker://x");
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_nip46_signing_timeout_ms(45_000);
        doc.set_nip46_max_retries(3);
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        assert_eq!(r.nip46_owner_pubkeys().len(), 1);
        assert_eq!(
            r.nip46_owner_bunker_uri(&"a".repeat(64)).as_deref(),
            Some("bunker://x")
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn add_and_remove_owner_round_trip() {
        let base = unique_temp();
        let pk1 = "a".repeat(64);
        let pk2 = "b".repeat(64);
        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.set_nip46_owner(&pk1, "bunker://1");
        doc.set_nip46_owner(&pk2, "bunker://2");
        doc.save(&base).unwrap();

        let mut doc = TenexConfigDoc::load(&base).unwrap();
        doc.remove_nip46_owner(&pk1);
        doc.save(&base).unwrap();

        let r = TenexConfigDoc::load(&base).unwrap();
        let pubkeys = r.nip46_owner_pubkeys();
        assert_eq!(pubkeys, vec![pk2.clone()]);
        assert!(r.nip46_owner_bunker_uri(&pk1).is_none());
        assert_eq!(
            r.nip46_owner_bunker_uri(&pk2).as_deref(),
            Some("bunker://2")
        );
        std::fs::remove_dir_all(&base).ok();
    }

    // ---- top-level menu shape -----------------------------------------

    #[test]
    fn top_level_actions_match_ts_in_order() {
        let acts = top_level_actions();
        // The first three labels are plain (no dim wrapping); the Back
        // label is wrapped in chalk.dim per `:22`. Compare unstripped on
        // the literal strings.
        assert_eq!(acts.len(), 4);
        assert_eq!(acts[0].label, "Enable/Disable NIP-46");
        assert_eq!(acts[0].value, TopAction::Toggle);
        assert_eq!(acts[1].label, "Configure timeout and retries");
        assert_eq!(acts[1].value, TopAction::Configure);
        assert_eq!(acts[2].label, "Manage owner bunker URIs");
        assert_eq!(acts[2].value, TopAction::Owners);
        assert_eq!(acts[3].value, TopAction::Back);
    }

    #[test]
    fn owner_actions_omit_remove_when_empty() {
        let acts = owner_actions(false);
        assert_eq!(acts.len(), 2);
        assert_eq!(acts[0].value, OwnerAction::Add);
        assert_eq!(acts[1].value, OwnerAction::Back);
    }

    #[test]
    fn owner_actions_include_remove_when_non_empty() {
        let acts = owner_actions(true);
        assert_eq!(acts.len(), 3);
        assert_eq!(acts[0].value, OwnerAction::Add);
        assert_eq!(acts[1].value, OwnerAction::Remove);
        assert_eq!(acts[2].value, OwnerAction::Back);
    }

    #[test]
    fn short_pk_takes_first_sixteen_chars() {
        let pk = "0".repeat(64);
        assert_eq!(short_pk(&pk).len(), 16);
        let pk = "abcdef0123456789xyz";
        assert_eq!(short_pk(pk), "abcdef0123456789");
    }
}
