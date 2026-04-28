use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConversationsError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("schema version mismatch: db is at {found}, library expects {expected}")]
    SchemaVersionMismatch { found: i64, expected: i64 },

    #[error("invalid project id: {0}")]
    InvalidProjectId(String),

    #[error("conversation not found: {0}")]
    ConversationNotFound(String),

    #[error("invalid data: {0}")]
    InvalidData(String),
}

pub type Result<T> = std::result::Result<T, ConversationsError>;
