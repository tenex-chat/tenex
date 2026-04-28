use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("invalid project id: {0}")]
    InvalidProjectId(String),

    #[error("schema version mismatch: db has {found}, code expects {expected}")]
    SchemaVersionMismatch { found: i64, expected: i64 },

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid signer reference: {0}")]
    InvalidSignerRef(String),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
