//! LLM connectivity test runner.
//!
//! Drives a real HTTP round-trip to the configured provider to verify that
//! the API key and model are functional. Mirrors `ConfigurationTester.ts`
//! (`src/llm/utils/ConfigurationTester.ts`).
//!
//! Architecture note: `reqwest::blocking` creates its own tokio runtime.
//! Calling it from within an existing `#[tokio::main]` context panics with
//! "Cannot start a runtime from within a runtime". The fix is to spawn a
//! real OS thread (`std::thread::spawn`) — the spawned thread has no tokio
//! runtime in its context, so `reqwest::blocking` works there.

use std::io::{self, Write};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use crossterm::cursor::MoveUp;
use crossterm::queue;
use crossterm::style::Print;
use crossterm::terminal::{Clear, ClearType};

use crate::onboard::llm_test_hints::map_error_to_hint;
use crate::onboard::llm_test_request::{
    ERR_TIMED_OUT, SPINNER_FRAMES, SPINNER_TICK_MS, TEST_PROMPT, TEST_TIMEOUT_MS,
};
use crate::store::llms::{LlmConfigKind, LlmsDoc};
use crate::store::providers::ProvidersDoc;
use crate::tui::custom_prompts::llm_menu_prompt::TestResult;
use crate::tui::theme::{CHALK_YELLOW_OPEN, FG_RESET};

/// Run an HTTP connectivity test for `config_name` and return the result.
///
/// Called from within `llm_menu_prompt`'s I/O loop (terminal is in raw
/// mode). Prints a braille spinner to stdout while the request is in
/// flight, then clears it before returning so the caller's next
/// `render_frame` lands at the expected cursor position.
pub fn run_test(base_dir: &Path, config_name: &str) -> TestResult {
    let doc = match LlmsDoc::load(base_dir) {
        Ok(d) => d,
        Err(e) => {
            return TestResult {
                success: false,
                error: Some(format!("failed to load llms.json: {e}")),
            }
        }
    };

    let Some(entry) = doc.get(config_name) else {
        return TestResult {
            success: false,
            error: Some(
                crate::onboard::llm_test_hints::ERR_CONFIGURATION_NOT_FOUND.to_owned(),
            ),
        };
    };

    if entry.kind() == LlmConfigKind::Meta {
        return TestResult {
            success: false,
            error: Some(
                "multi-modal configurations use standard configs — test those individually"
                    .to_owned(),
            ),
        };
    }

    let provider = entry.provider().unwrap_or("").to_owned();
    let model = entry.model().unwrap_or("").to_owned();

    if provider == "acp" {
        return TestResult {
            success: false,
            error: Some(
                "ACP configurations are tested by connecting to the backend process".to_owned(),
            ),
        };
    }

    if provider == "claude-code" {
        return TestResult {
            success: false,
            error: Some(
                "claude-code configurations are tested by running `claude --help`".to_owned(),
            ),
        };
    }

    let providers = match ProvidersDoc::load(base_dir) {
        Ok(p) => p,
        Err(e) => {
            return TestResult {
                success: false,
                error: Some(format!("failed to load providers.json: {e}")),
            }
        }
    };

    let api_key = providers
        .get(&provider)
        .and_then(|e| {
            e.api_keys()
                .into_iter()
                .find(|k| {
                    let head = k.split_whitespace().next().unwrap_or("");
                    !head.is_empty() && head != "none"
                })
        })
        .unwrap_or_default();

    let (tx, rx) = mpsc::channel::<TestResult>();
    let provider_c = provider.clone();
    let model_c = model.clone();
    let api_key_c = api_key.clone();
    std::thread::spawn(move || {
        let result = make_http_request(&provider_c, &model_c, &api_key_c);
        let _ = tx.send(result);
    });

    run_spinner(config_name, rx)
}

/// Display a braille spinner while `rx` delivers the test result.
///
/// Prints one extra line below the rendered frame, overwrites it with
/// spinner frames, then clears it and moves the cursor back up before
/// returning. The caller's next `render_frame` will land at the correct
/// position.
fn run_spinner(label: &str, rx: mpsc::Receiver<TestResult>) -> TestResult {
    let mut stdout = io::stdout();
    let mut frame_idx: usize = 0;

    // Move to a fresh line below the rendered frame.
    queue!(stdout, Print("\r\n")).ok();
    stdout.flush().ok();

    let result = loop {
        let frame = SPINNER_FRAMES[frame_idx % SPINNER_FRAMES.len()];
        queue!(
            stdout,
            crossterm::cursor::MoveToColumn(0),
            Clear(ClearType::CurrentLine),
            Print(CHALK_YELLOW_OPEN),
            Print(frame),
            Print(FG_RESET),
            Print(format!(" Testing {label}…")),
        )
        .ok();
        stdout.flush().ok();
        frame_idx += 1;

        match rx.recv_timeout(Duration::from_millis(SPINNER_TICK_MS)) {
            Ok(r) => break r,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break TestResult {
                    success: false,
                    error: Some("test thread disconnected unexpectedly".to_owned()),
                }
            }
        }
    };

    // Clear spinner line and return cursor to the last rendered row.
    queue!(
        stdout,
        crossterm::cursor::MoveToColumn(0),
        Clear(ClearType::CurrentLine),
        MoveUp(1),
    )
    .ok();
    stdout.flush().ok();

    result
}

/// Dispatch to the correct HTTP call for `provider` and return a result.
fn make_http_request(provider: &str, model: &str, api_key: &str) -> TestResult {
    let timeout = Duration::from_millis(TEST_TIMEOUT_MS);
    let client = match reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return TestResult {
                success: false,
                error: Some(e.to_string()),
            }
        }
    };

    match do_request(&client, provider, model, api_key) {
        Ok(()) => TestResult { success: true, error: None },
        Err(msg) => TestResult {
            success: false,
            error: Some(map_error_to_hint(&msg).to_owned()),
        },
    }
}

/// Build and execute the provider-specific HTTP request.
fn do_request(
    client: &reqwest::blocking::Client,
    provider: &str,
    model: &str,
    api_key: &str,
) -> Result<(), String> {
    let messages = serde_json::json!([{
        "role": TEST_PROMPT_ROLE,
        "content": TEST_PROMPT,
    }]);

    match provider {
        "anthropic" => {
            let body = serde_json::json!({
                "model": model,
                "max_tokens": 20,
                "messages": messages,
            });
            let resp = client
                .post("https://api.anthropic.com/v1/messages")
                .header("Content-Type", "application/json")
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .map_err(format_send_err)?;
            check_status(resp)
        }
        "openai" | "codex" => {
            let body = serde_json::json!({
                "model": model,
                "max_tokens": 20,
                "messages": messages,
            });
            let resp = client
                .post("https://api.openai.com/v1/chat/completions")
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {api_key}"))
                .json(&body)
                .send()
                .map_err(format_send_err)?;
            check_status(resp)
        }
        "openrouter" => {
            let body = serde_json::json!({
                "model": model,
                "max_tokens": 20,
                "messages": messages,
            });
            let resp = client
                .post("https://openrouter.ai/api/v1/chat/completions")
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {api_key}"))
                .json(&body)
                .send()
                .map_err(format_send_err)?;
            check_status(resp)
        }
        "ollama" => {
            let body = serde_json::json!({
                "model": model,
                "stream": false,
                "messages": messages,
            });
            let resp = client
                .post("http://localhost:11434/api/chat")
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .map_err(format_send_err)?;
            check_status(resp)
        }
        other => Err(format!("no HTTP test available for provider '{other}'")),
    }
}

const TEST_PROMPT_ROLE: &str = crate::onboard::llm_test_request::TEST_PROMPT_ROLE;

fn format_send_err(e: reqwest::Error) -> String {
    if e.is_timeout() {
        ERR_TIMED_OUT.to_owned()
    } else {
        e.to_string()
    }
}

fn check_status(resp: reqwest::blocking::Response) -> Result<(), String> {
    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status().as_u16();
        let body = resp.text().unwrap_or_default();
        Err(format!("{status} {body}"))
    }
}
