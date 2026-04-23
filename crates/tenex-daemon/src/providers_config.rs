use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

pub const PROVIDERS_FILE_NAME: &str = "providers.json";

#[derive(Debug, Error)]
pub enum ProvidersConfigError {
    #[error("providers config io error while reading {path}: {source}")]
    ReadIo { path: PathBuf, source: io::Error },
    #[error("providers config json error while reading {path}: {source}")]
    ReadJson {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("providers config io error while writing {path}: {source}")]
    WriteIo { path: PathBuf, source: io::Error },
    #[error("providers config json error while writing {path}: {source}")]
    WriteJson {
        path: PathBuf,
        source: serde_json::Error,
    },
}

pub type ProvidersConfigResult<T> = Result<T, ProvidersConfigError>;

fn deserialize_api_key<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StrOrVec {
        Str(String),
        Vec(Vec<String>),
    }
    match StrOrVec::deserialize(d)? {
        StrOrVec::Str(s) => Ok(s),
        StrOrVec::Vec(v) => Ok(v.into_iter().last().unwrap_or_default()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderEntry {
    #[serde(rename = "apiKey", deserialize_with = "deserialize_api_key")]
    pub api_key: String,
    #[serde(rename = "baseUrl", skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProvidersConfig {
    pub providers: HashMap<String, ProviderEntry>,
}

pub fn providers_config_path(base_dir: &Path) -> PathBuf {
    base_dir.join(PROVIDERS_FILE_NAME)
}

pub fn read_providers_config(base_dir: &Path) -> ProvidersConfigResult<ProvidersConfig> {
    let path = providers_config_path(base_dir);
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(ProvidersConfig::default());
        }
        Err(source) => return Err(ProvidersConfigError::ReadIo { path, source }),
    };
    serde_json::from_str(&content).map_err(|source| ProvidersConfigError::ReadJson { path, source })
}

pub fn write_providers_config(
    base_dir: &Path,
    config: &ProvidersConfig,
) -> ProvidersConfigResult<()> {
    let path = providers_config_path(base_dir);
    let json =
        serde_json::to_string_pretty(config).map_err(|source| ProvidersConfigError::WriteJson {
            path: path.clone(),
            source,
        })?;
    fs::write(&path, format!("{json}\n"))
        .map_err(|source| ProvidersConfigError::WriteIo { path, source })
}
