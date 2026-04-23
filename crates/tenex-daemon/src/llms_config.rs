use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const LLMS_FILE_NAME: &str = "llms.json";

#[derive(Debug, Error)]
pub enum LLMsConfigError {
    #[error("llms config io error while reading {path}: {source}")]
    ReadIo { path: PathBuf, source: io::Error },
    #[error("llms config json error while reading {path}: {source}")]
    ReadJson {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("llms config io error while writing {path}: {source}")]
    WriteIo { path: PathBuf, source: io::Error },
    #[error("llms config json error while writing {path}: {source}")]
    WriteJson {
        path: PathBuf,
        source: serde_json::Error,
    },
}

pub type LLMsConfigResult<T> = Result<T, LLMsConfigError>;

/// Stored as-is from JSON because standard and meta-model configs have different shapes.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LLMsConfig {
    #[serde(default)]
    pub configurations: IndexMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summarization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supervision: Option<String>,
    #[serde(rename = "promptCompilation", skip_serializing_if = "Option::is_none")]
    pub prompt_compilation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub categorization: Option<String>,
}

pub fn llms_config_path(base_dir: &Path) -> PathBuf {
    base_dir.join(LLMS_FILE_NAME)
}

pub fn read_llms_config(base_dir: &Path) -> LLMsConfigResult<LLMsConfig> {
    let path = llms_config_path(base_dir);
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(LLMsConfig::default());
        }
        Err(source) => return Err(LLMsConfigError::ReadIo { path, source }),
    };
    serde_json::from_str(&content).map_err(|source| LLMsConfigError::ReadJson { path, source })
}

pub fn write_llms_config(base_dir: &Path, config: &LLMsConfig) -> LLMsConfigResult<()> {
    let path = llms_config_path(base_dir);
    let json =
        serde_json::to_string_pretty(config).map_err(|source| LLMsConfigError::WriteJson {
            path: path.clone(),
            source,
        })?;
    fs::write(&path, format!("{json}\n"))
        .map_err(|source| LLMsConfigError::WriteIo { path, source })
}
