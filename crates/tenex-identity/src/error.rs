use thiserror::Error;

#[derive(Debug, Error)]
pub enum IdentityError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("schema version mismatch: db is at {found}, library expects {expected}")]
    SchemaVersionMismatch { found: i64, expected: i64 },

    #[error("invalid pubkey: {0}")]
    InvalidPubkey(String),

    #[error("relay error: {0}")]
    Relay(String),
}

pub type Result<T> = std::result::Result<T, IdentityError>;
