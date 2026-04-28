//! Relay URL validators — three strictness levels matching the TS source
//! exactly (per spec doc 08 §3).
//!
//! | Validator                     | Source                                          | Used by                          |
//! |-------------------------------|-------------------------------------------------|----------------------------------|
//! | [`is_valid_websocket_url`]    | `src/nostr/relays.ts:18-25`                     | runtime relay-list filtering     |
//! | [`validate_config_screen`]    | `src/commands/config/relays.ts:57-63`           | `tenex config network → Relays`  |
//! | [`validate_onboard`]          | `src/commands/onboard.ts:1363-1376`             | onboarding step's relay prompt   |
//!
//! Strictness order: `validate_onboard` ⊂ `is_valid_websocket_url` ⊂
//! `validate_config_screen`. Onboarding rejects malformed URLs and bare
//! protocols (`wss://localhost` is invalid because no `.` in the hostname);
//! the config screen accepts anything that *starts with* `ws://`/`wss://` —
//! validation that lets through some inputs runtime-filtering will silently
//! drop. Reproduce both: do not unify.
//!
//! Error messages are emitted **verbatim** so a user staring at the Rust port
//! sees the same wording the TS prompts produced.

use url::Url;

/// Runtime check used by `getRelayUrls` to filter an env/config list before
/// handing it to NDK. Returns `false` for malformed URLs and any non-WS
/// protocol. Source: `src/nostr/relays.ts:18-25`.
pub fn is_valid_websocket_url(url: &str) -> bool {
    match Url::parse(url) {
        Ok(parsed) => matches!(parsed.scheme(), "ws" | "wss"),
        Err(_) => false,
    }
}

/// Config-screen validator: `tenex config network → Relays → Add`. Trims
/// input then checks only that the prefix is `ws://` or `wss://`. No
/// hostname check. Source: `src/commands/config/relays.ts:57-63`.
///
/// Returns `Ok(trimmed)` on success; `Err(message)` reproduces the TS error
/// string verbatim.
pub fn validate_config_screen(input: &str) -> Result<String, &'static str> {
    let trimmed = input.trim();
    if !trimmed.starts_with("ws://") && !trimmed.starts_with("wss://") {
        return Err("URL must start with ws:// or wss://");
    }
    Ok(trimmed.to_owned())
}

/// Onboarding validator: relay prompt in step 2. Strictest of the three.
///
/// 1. Must parse as a URL.
/// 2. Protocol must be `ws:` or `wss:`.
/// 3. Hostname must exist and contain a `.`.
///
/// Source: `src/commands/onboard.ts:1363-1376`. Error strings verbatim.
pub fn validate_onboard(url: &str) -> Result<(), &'static str> {
    let parsed = match Url::parse(url) {
        Ok(p) => p,
        Err(_) => return Err("Invalid URL format"),
    };

    if !matches!(parsed.scheme(), "ws" | "wss") {
        return Err("URL must use ws:// or wss:// protocol");
    }

    let host = parsed.host_str().unwrap_or("");
    if host.is_empty() || !host.contains('.') {
        return Err("Enter a relay hostname");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- is_valid_websocket_url -----------------------------------------

    #[test]
    fn runtime_accepts_wss() {
        assert!(is_valid_websocket_url("wss://relay.tenex.chat"));
    }

    #[test]
    fn runtime_accepts_ws() {
        assert!(is_valid_websocket_url("ws://localhost:8080"));
    }

    #[test]
    fn runtime_rejects_http_protocol() {
        assert!(!is_valid_websocket_url("https://relay.tenex.chat"));
    }

    #[test]
    fn runtime_rejects_garbage() {
        assert!(!is_valid_websocket_url("not a url"));
    }

    #[test]
    fn runtime_rejects_empty_string() {
        assert!(!is_valid_websocket_url(""));
    }

    // ---- validate_config_screen -----------------------------------------

    #[test]
    fn config_screen_accepts_wss_prefix() {
        assert_eq!(
            validate_config_screen("wss://relay.tenex.chat"),
            Ok("wss://relay.tenex.chat".to_owned())
        );
    }

    #[test]
    fn config_screen_trims_whitespace() {
        assert_eq!(
            validate_config_screen("   wss://r.example  "),
            Ok("wss://r.example".to_owned())
        );
    }

    #[test]
    fn config_screen_rejects_http() {
        assert_eq!(
            validate_config_screen("https://r.example"),
            Err("URL must start with ws:// or wss://")
        );
    }

    #[test]
    fn config_screen_accepts_anything_after_wss_prefix() {
        // Per spec doc 08 §3 — config-screen validator is a prefix check ONLY,
        // so technically broken URLs slip through (runtime filter catches
        // them). Test pins this behaviour so a future "tightening" rewrite
        // doesn't silently change UX.
        assert!(validate_config_screen("wss://").is_ok());
        assert!(validate_config_screen("wss://localhost").is_ok());
    }

    // ---- validate_onboard -----------------------------------------------

    #[test]
    fn onboard_accepts_wss_with_dotted_host() {
        assert_eq!(validate_onboard("wss://relay.tenex.chat"), Ok(()));
    }

    #[test]
    fn onboard_rejects_bad_protocol() {
        assert_eq!(
            validate_onboard("https://relay.tenex.chat"),
            Err("URL must use ws:// or wss:// protocol"),
        );
    }

    #[test]
    fn onboard_rejects_dotless_host() {
        assert_eq!(
            validate_onboard("wss://localhost"),
            Err("Enter a relay hostname"),
        );
    }

    #[test]
    fn onboard_rejects_unparseable() {
        assert_eq!(validate_onboard("nope"), Err("Invalid URL format"));
    }

    #[test]
    fn onboard_rejects_empty_string() {
        assert_eq!(validate_onboard(""), Err("Invalid URL format"));
    }

    #[test]
    fn onboard_accepts_ipv4_with_port_when_dotted() {
        // `127.0.0.1` contains dots so the strict validator accepts it.
        // (`new URL` in JS treats this as a valid hostname.)
        assert_eq!(validate_onboard("ws://127.0.0.1:8080"), Ok(()));
    }
}
