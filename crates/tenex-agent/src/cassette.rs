use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::Serialize;

#[derive(Clone)]
pub struct CassetteRecorder {
    path: PathBuf,
    agent: String,
    provider: String,
    model: String,
    turns: Arc<Mutex<usize>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CassetteToolCall {
    pub name: String,
    pub args: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CassettePartialToolCall {
    pub name: Option<String>,
    pub args: String,
    pub args_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CassetteStreamError {
    pub class: String,
    pub message: String,
    pub retryable: String,
    pub failed_at_ms: u64,
    pub partial_content: String,
    pub partial_tool_calls: Vec<CassettePartialToolCall>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CassetteTurnRecord<'a> {
    version: u32,
    agent: &'a str,
    provider: &'a str,
    model: &'a str,
    turn: usize,
    duration_ms: u64,
    timestamp_ms: u64,
    request_debug: &'a str,
    content: &'a str,
    tool_calls: &'a [CassetteToolCall],
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a CassetteStreamError>,
}

impl CassetteRecorder {
    pub fn from_env(agent: &str, provider: &str, model: &str) -> Option<Self> {
        let path = std::env::var("TENEX_LLM_CASSETTE_RECORD_PATH")
            .ok()
            .filter(|value| !value.trim().is_empty())?;
        Some(Self {
            path: PathBuf::from(path),
            agent: agent.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            turns: Arc::new(Mutex::new(0)),
        })
    }

    pub(crate) fn next_turn(&self) -> usize {
        let mut turns = self.turns.lock().unwrap();
        *turns += 1;
        *turns
    }

    pub(crate) fn record_turn(
        &self,
        turn: usize,
        duration_ms: u64,
        request_debug: &str,
        content: &str,
        tool_calls: &[CassetteToolCall],
    ) {
        if let Err(err) =
            self.try_record_turn(turn, duration_ms, request_debug, content, tool_calls)
        {
            eprintln!(
                "[tenex-agent cassette] failed to append LLM cassette {}: {err}",
                self.path.display()
            );
        }
    }

    fn try_record_turn(
        &self,
        turn: usize,
        duration_ms: u64,
        request_debug: &str,
        content: &str,
        tool_calls: &[CassetteToolCall],
    ) -> Result<()> {
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let record = CassetteTurnRecord {
            version: 1,
            agent: &self.agent,
            provider: &self.provider,
            model: &self.model,
            turn,
            duration_ms,
            timestamp_ms,
            request_debug,
            content,
            tool_calls,
            error: None,
        };
        let line = serde_json::to_string(&record).context("serialize cassette turn")?;
        append_jsonl(&self.path, &line).context("append cassette turn")
    }

    pub(crate) fn record_stream_error(
        &self,
        turn: usize,
        duration_ms: u64,
        request_debug: &str,
        content: &str,
        tool_calls: &[CassetteToolCall],
        error: &CassetteStreamError,
    ) {
        if let Err(err) = self.try_record_stream_error(
            turn,
            duration_ms,
            request_debug,
            content,
            tool_calls,
            error,
        ) {
            eprintln!(
                "[tenex-agent cassette] failed to append LLM cassette {}: {err}",
                self.path.display()
            );
        }
    }

    fn try_record_stream_error(
        &self,
        turn: usize,
        duration_ms: u64,
        request_debug: &str,
        content: &str,
        tool_calls: &[CassetteToolCall],
        error: &CassetteStreamError,
    ) -> Result<()> {
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let record = CassetteTurnRecord {
            version: 1,
            agent: &self.agent,
            provider: &self.provider,
            model: &self.model,
            turn,
            duration_ms,
            timestamp_ms,
            request_debug,
            content,
            tool_calls,
            error: Some(error),
        };
        let line = serde_json::to_string(&record).context("serialize cassette stream error")?;
        append_jsonl(&self.path, &line).context("append cassette stream error")
    }
}

fn append_jsonl(path: &Path, line: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create cassette directory {}", parent.display()))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("open cassette {}", path.display()))?;
    writeln!(file, "{line}").context("write cassette line")
}
