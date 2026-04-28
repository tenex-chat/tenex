use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("invalid project id: {0}")]
    InvalidProjectId(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid signer reference: {0}")]
    InvalidSignerRef(String),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
