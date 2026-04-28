//! Onboarding Screen 3 (sub-step A): provider auto-detection.
//!
//! Source: `src/commands/onboard.ts:596-663`. Probes are injected via the
//! [`DetectionProbes`] trait so tests can drive every branch deterministically
//! without spawning shells, hitting the network, or mutating process env.
//!
//! Detection order is preserved exactly:
//!
//! 1. **Local CLIs** (`:601-609`) — `claude` (recorded as a hint trigger only),
//!    `codex` (added with the literal `"none"` sentinel per spec doc 04 §1).
//! 2. **Ollama** (`:611-617`) — added with `apiKey: "http://localhost:11434"`
//!    when reachable.
//! 3. **Env vars** (`:619-631`) — the canonical three (`ANTHROPIC_API_KEY`,
//!    `OPENAI_API_KEY`, `OPENROUTER_API_KEY`).
//! 4. **OAuth token** (`:633-638`) — `ANTHROPIC_AUTH_TOKEN` only when it
//!    starts with `sk-ant-oat` AND no Anthropic credential has been added
//!    yet (so the env-var pass at step 3 takes precedence).
//!
//! OpenClaw credential ingestion (`:640-652`) is intentionally not in this
//! module — that path lives under `agent_cmd::import::openclaw` per spec
//! doc 10 and is wired into onboarding in a later iteration. This module
//! returns `claude_cli_detected` so the caller can render the
//! `via claude setup-token` hint with no Anthropic credential present
//! (matches `buildProviderHints`, `:657-663`).
//!
//! Inputs and outputs are all owned values — no shared mutable state.

use std::collections::HashMap;

use crate::store::providers::ProvidersDoc;

const PROVIDER_ID_CODEX: &str = "codex";
const PROVIDER_ID_OLLAMA: &str = "ollama";
const PROVIDER_ID_ANTHROPIC: &str = "anthropic";
const PROVIDER_ID_OPENAI: &str = "openai";
const PROVIDER_ID_OPENROUTER: &str = "openrouter";

/// Trait for the side-effecting probes (CLI presence, Ollama reachability).
/// Production code uses [`SystemProbes`]; tests use a mock.
pub trait DetectionProbes {
    fn command_exists(&self, cmd: &str) -> bool;
    fn ollama_reachable(&self) -> bool;
}

/// Result of one auto-detection pass.
#[derive(Debug, Clone, Default)]
pub struct Detection {
    /// Updated providers document (caller persists via `ProvidersDoc::save`).
    pub doc: ProvidersDoc,
    /// Verbatim source labels for each provider that was added in this pass.
    /// Order matches the TS detection order so the onboarding summary line
    /// renders consistently.
    pub detected_sources: Vec<String>,
    /// True iff `claude` is on the PATH. Used by the caller to render the
    /// `via claude setup-token` hint when no Anthropic credential exists.
    pub claude_cli_detected: bool,
}

impl Detection {
    /// Equivalent of `buildProviderHints` (`:657-663`) — returns the single
    /// hint the TS code produces, when applicable.
    pub fn provider_hints(&self) -> HashMap<String, String> {
        let mut hints = HashMap::new();
        if self.claude_cli_detected && self.doc.get(PROVIDER_ID_ANTHROPIC).is_none() {
            hints.insert(
                PROVIDER_ID_ANTHROPIC.to_owned(),
                "via claude setup-token".to_owned(),
            );
        }
        hints
    }
}

/// Run the full detection pipeline. `env` is a snapshot of the variables to
/// consult (so tests can inject without mutating the process env).
pub fn auto_detect_providers(
    starting_doc: ProvidersDoc,
    env: &HashMap<String, String>,
    probes: &dyn DetectionProbes,
) -> Detection {
    let mut doc = starting_doc;
    let mut detected_sources = Vec::new();

    // 1. Local CLIs.
    let has_claude = probes.command_exists("claude");
    let has_codex = probes.command_exists("codex");
    if has_codex && doc.get(PROVIDER_ID_CODEX).is_none() {
        doc.set_api_keys(PROVIDER_ID_CODEX, vec!["none".to_owned()]);
        detected_sources.push("Codex CLI (codex)".to_owned());
    }

    // 2. Ollama.
    if doc.get(PROVIDER_ID_OLLAMA).is_none() && probes.ollama_reachable() {
        doc.set_api_keys(
            PROVIDER_ID_OLLAMA,
            vec!["http://localhost:11434".to_owned()],
        );
        detected_sources.push("Ollama (localhost:11434)".to_owned());
    }

    // 3. Env-var API keys (verbatim TS labels and order).
    let env_map: &[(&str, &str, &str)] = &[
        (
            "ANTHROPIC_API_KEY",
            PROVIDER_ID_ANTHROPIC,
            "Anthropic (from ANTHROPIC_API_KEY)",
        ),
        (
            "OPENAI_API_KEY",
            PROVIDER_ID_OPENAI,
            "OpenAI (from OPENAI_API_KEY)",
        ),
        (
            "OPENROUTER_API_KEY",
            PROVIDER_ID_OPENROUTER,
            "OpenRouter (from OPENROUTER_API_KEY)",
        ),
    ];
    for (env_var, provider_id, label) in env_map {
        let Some(value) = env.get(*env_var) else { continue };
        if value.is_empty() {
            continue;
        }
        if doc.get(provider_id).is_some() {
            continue;
        }
        doc.set_api_keys(provider_id, vec![value.clone()]);
        detected_sources.push((*label).to_owned());
    }

    // 4. Anthropic OAuth token.
    if let Some(token) = env.get("ANTHROPIC_AUTH_TOKEN") {
        if token.starts_with("sk-ant-oat") && doc.get(PROVIDER_ID_ANTHROPIC).is_none() {
            doc.set_api_keys(PROVIDER_ID_ANTHROPIC, vec![token.clone()]);
            detected_sources.push("Anthropic (from ANTHROPIC_AUTH_TOKEN)".to_owned());
        }
    }

    Detection {
        doc,
        detected_sources,
        claude_cli_detected: has_claude,
    }
}

/// Production [`DetectionProbes`] implementation: runs `/bin/sh -c command -v <cmd>`
/// for CLI presence and an HTTP/1.1 GET against `127.0.0.1:11434/api/tags`
/// with a 2-second connect+read timeout for Ollama.
pub struct SystemProbes;

impl DetectionProbes for SystemProbes {
    fn command_exists(&self, cmd: &str) -> bool {
        use std::process::{Command, Stdio};
        Command::new("/bin/sh")
            .args(["-c", &format!("command -v {cmd}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn ollama_reachable(&self) -> bool {
        use std::io::{Read, Write};
        use std::net::{SocketAddr, TcpStream};
        use std::time::Duration;

        let Ok(addr) = "127.0.0.1:11434".parse::<SocketAddr>() else {
            return false;
        };
        let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
            return false;
        };
        if stream.set_read_timeout(Some(Duration::from_secs(2))).is_err() {
            return false;
        }
        if stream.set_write_timeout(Some(Duration::from_secs(2))).is_err() {
            return false;
        }
        if stream
            .write_all(
                b"GET /api/tags HTTP/1.1\r\nHost: localhost:11434\r\nConnection: close\r\n\r\n",
            )
            .is_err()
        {
            return false;
        }
        let mut buf = [0u8; 32];
        if stream.read(&mut buf).is_err() {
            return false;
        }
        // `response.ok` in fetch() means status 200..=299. Accept 2xx broadly.
        buf.starts_with(b"HTTP/1.1 2") || buf.starts_with(b"HTTP/1.0 2")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::HashSet;

    /// Test probe that records every CLI lookup and returns canned answers.
    struct MockProbes {
        cli_present: HashSet<String>,
        ollama_up: bool,
        cli_calls: Cell<u32>,
    }

    impl MockProbes {
        fn new() -> Self {
            Self {
                cli_present: HashSet::new(),
                ollama_up: false,
                cli_calls: Cell::new(0),
            }
        }
        fn with_cli(mut self, name: &str) -> Self {
            self.cli_present.insert(name.to_owned());
            self
        }
        fn with_ollama(mut self) -> Self {
            self.ollama_up = true;
            self
        }
    }

    impl DetectionProbes for MockProbes {
        fn command_exists(&self, cmd: &str) -> bool {
            self.cli_calls.set(self.cli_calls.get() + 1);
            self.cli_present.contains(cmd)
        }
        fn ollama_reachable(&self) -> bool {
            self.ollama_up
        }
    }

    fn empty_env() -> HashMap<String, String> {
        HashMap::new()
    }

    fn one_env(key: &str, val: &str) -> HashMap<String, String> {
        let mut m = HashMap::new();
        m.insert(key.to_owned(), val.to_owned());
        m
    }

    // ---- Codex CLI ------------------------------------------------------

    #[test]
    fn codex_cli_present_adds_codex_with_none_sentinel() {
        let probes = MockProbes::new().with_cli("codex");
        let det = auto_detect_providers(ProvidersDoc::new(), &empty_env(), &probes);
        let entry = det.doc.get("codex").expect("codex provider present");
        assert_eq!(entry.api_keys(), vec!["none".to_owned()]);
        assert!(det.detected_sources.contains(&"Codex CLI (codex)".to_owned()));
    }

    #[test]
    fn codex_cli_absent_does_not_add() {
        let probes = MockProbes::new();
        let det = auto_detect_providers(ProvidersDoc::new(), &empty_env(), &probes);
        assert!(det.doc.get("codex").is_none());
    }

    #[test]
    fn codex_already_configured_is_not_overwritten() {
        let probes = MockProbes::new().with_cli("codex");
        let mut starting = ProvidersDoc::new();
        starting.set_api_keys("codex", vec!["existing".to_owned()]);
        let det = auto_detect_providers(starting, &empty_env(), &probes);
        let entry = det.doc.get("codex").unwrap();
        assert_eq!(entry.api_keys(), vec!["existing".to_owned()]);
        // No "Codex CLI (codex)" source recorded — we didn't touch it.
        assert!(!det.detected_sources.iter().any(|s| s.contains("Codex CLI")));
    }

    // ---- Claude CLI -----------------------------------------------------

    #[test]
    fn claude_cli_presence_recorded_only_in_claude_cli_detected() {
        let probes = MockProbes::new().with_cli("claude");
        let det = auto_detect_providers(ProvidersDoc::new(), &empty_env(), &probes);
        assert!(det.claude_cli_detected);
        // Claude CLI alone never adds a provider.
        assert!(det.doc.get("anthropic").is_none());
        assert!(det.detected_sources.is_empty());
    }

    #[test]
    fn claude_cli_hint_only_when_anthropic_not_configured() {
        let probes = MockProbes::new().with_cli("claude");
        let det = auto_detect_providers(ProvidersDoc::new(), &empty_env(), &probes);
        let hints = det.provider_hints();
        assert_eq!(
            hints.get("anthropic").map(String::as_str),
            Some("via claude setup-token"),
        );
    }

    #[test]
    fn claude_cli_hint_suppressed_when_anthropic_configured() {
        let probes = MockProbes::new().with_cli("claude");
        let mut starting = ProvidersDoc::new();
        starting.set_api_keys("anthropic", vec!["sk-1".to_owned()]);
        let det = auto_detect_providers(starting, &empty_env(), &probes);
        assert!(det.provider_hints().is_empty());
    }

    // ---- Ollama ---------------------------------------------------------

    #[test]
    fn ollama_reachable_adds_localhost_url() {
        let probes = MockProbes::new().with_ollama();
        let det = auto_detect_providers(ProvidersDoc::new(), &empty_env(), &probes);
        let entry = det.doc.get("ollama").unwrap();
        assert_eq!(entry.api_keys(), vec!["http://localhost:11434".to_owned()]);
        assert!(det.detected_sources.contains(&"Ollama (localhost:11434)".to_owned()));
    }

    #[test]
    fn ollama_unreachable_does_not_add() {
        let probes = MockProbes::new();
        let det = auto_detect_providers(ProvidersDoc::new(), &empty_env(), &probes);
        assert!(det.doc.get("ollama").is_none());
    }

    #[test]
    fn ollama_already_configured_is_not_probed_again() {
        // Per `:612` — the reachability check is gated on `!providers.ollama`.
        let probes = MockProbes::new().with_ollama();
        let mut starting = ProvidersDoc::new();
        starting.set_api_keys("ollama", vec!["http://other:11434".to_owned()]);
        let det = auto_detect_providers(starting, &empty_env(), &probes);
        let entry = det.doc.get("ollama").unwrap();
        assert_eq!(entry.api_keys(), vec!["http://other:11434".to_owned()]);
        assert!(!det.detected_sources.iter().any(|s| s.contains("Ollama")));
    }

    // ---- Env-var API keys ----------------------------------------------

    #[test]
    fn anthropic_env_var_added() {
        let env = one_env("ANTHROPIC_API_KEY", "sk-ant-real");
        let det = auto_detect_providers(ProvidersDoc::new(), &env, &MockProbes::new());
        let entry = det.doc.get("anthropic").unwrap();
        assert_eq!(entry.api_keys(), vec!["sk-ant-real".to_owned()]);
        assert!(det.detected_sources.contains(&"Anthropic (from ANTHROPIC_API_KEY)".to_owned()));
    }

    #[test]
    fn openai_env_var_added() {
        let env = one_env("OPENAI_API_KEY", "sk-openai");
        let det = auto_detect_providers(ProvidersDoc::new(), &env, &MockProbes::new());
        assert_eq!(
            det.doc.get("openai").unwrap().api_keys(),
            vec!["sk-openai".to_owned()]
        );
        assert!(det.detected_sources.contains(&"OpenAI (from OPENAI_API_KEY)".to_owned()));
    }

    #[test]
    fn openrouter_env_var_added() {
        let env = one_env("OPENROUTER_API_KEY", "sk-or-v1");
        let det = auto_detect_providers(ProvidersDoc::new(), &env, &MockProbes::new());
        assert!(det.doc.get("openrouter").is_some());
        assert!(det.detected_sources.iter().any(|s| s.contains("OPENROUTER_API_KEY")));
    }

    #[test]
    fn empty_env_var_value_does_not_add_provider() {
        // Per `:627` (`if (value && !...)`) — empty string is falsy in JS.
        let env = one_env("OPENAI_API_KEY", "");
        let det = auto_detect_providers(ProvidersDoc::new(), &env, &MockProbes::new());
        assert!(det.doc.get("openai").is_none());
    }

    #[test]
    fn env_var_does_not_overwrite_existing_provider() {
        let env = one_env("ANTHROPIC_API_KEY", "sk-from-env");
        let mut starting = ProvidersDoc::new();
        starting.set_api_keys("anthropic", vec!["sk-from-disk".to_owned()]);
        let det = auto_detect_providers(starting, &env, &MockProbes::new());
        assert_eq!(
            det.doc.get("anthropic").unwrap().api_keys(),
            vec!["sk-from-disk".to_owned()]
        );
    }

    // ---- ANTHROPIC_AUTH_TOKEN ------------------------------------------

    #[test]
    fn anthropic_auth_token_added_when_oat_prefix() {
        let env = one_env("ANTHROPIC_AUTH_TOKEN", "sk-ant-oat01-realtoken");
        let det = auto_detect_providers(ProvidersDoc::new(), &env, &MockProbes::new());
        let entry = det.doc.get("anthropic").unwrap();
        assert_eq!(
            entry.api_keys(),
            vec!["sk-ant-oat01-realtoken".to_owned()]
        );
        assert!(det
            .detected_sources
            .contains(&"Anthropic (from ANTHROPIC_AUTH_TOKEN)".to_owned()));
    }

    #[test]
    fn anthropic_auth_token_ignored_without_oat_prefix() {
        let env = one_env("ANTHROPIC_AUTH_TOKEN", "sk-ant-something-else");
        let det = auto_detect_providers(ProvidersDoc::new(), &env, &MockProbes::new());
        assert!(det.doc.get("anthropic").is_none());
    }

    #[test]
    fn anthropic_api_key_takes_precedence_over_auth_token() {
        // Both env vars present; per TS order, ANTHROPIC_API_KEY wins.
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_API_KEY".into(), "sk-from-key".into());
        env.insert("ANTHROPIC_AUTH_TOKEN".into(), "sk-ant-oat01".into());
        let det = auto_detect_providers(ProvidersDoc::new(), &env, &MockProbes::new());
        assert_eq!(
            det.doc.get("anthropic").unwrap().api_keys(),
            vec!["sk-from-key".to_owned()]
        );
        // Only one source recorded.
        assert!(!det
            .detected_sources
            .iter()
            .any(|s| s.contains("ANTHROPIC_AUTH_TOKEN")));
    }

    // ---- detection order ------------------------------------------------

    #[test]
    fn detected_sources_appear_in_canonical_order() {
        let probes = MockProbes::new().with_cli("codex").with_ollama();
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_API_KEY".into(), "x".into());
        env.insert("OPENAI_API_KEY".into(), "y".into());
        env.insert("OPENROUTER_API_KEY".into(), "z".into());
        let det = auto_detect_providers(ProvidersDoc::new(), &env, &probes);
        assert_eq!(
            det.detected_sources,
            vec![
                "Codex CLI (codex)".to_owned(),
                "Ollama (localhost:11434)".to_owned(),
                "Anthropic (from ANTHROPIC_API_KEY)".to_owned(),
                "OpenAI (from OPENAI_API_KEY)".to_owned(),
                "OpenRouter (from OPENROUTER_API_KEY)".to_owned(),
            ]
        );
    }

    #[test]
    fn cli_lookups_are_made_for_both_claude_and_codex() {
        let probes = MockProbes::new();
        let _ = auto_detect_providers(ProvidersDoc::new(), &empty_env(), &probes);
        // Two probes — one for each canonical CLI name (`:601-604`).
        assert_eq!(probes.cli_calls.get(), 2);
    }
}
