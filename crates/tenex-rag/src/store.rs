use async_trait::async_trait;

/// Optional source-tracking metadata attached to a vector document.
///
/// Documents written by content-hash callers (`RagStore::index`) leave
/// every field `None`. Documents written by source-keyed callers
/// (`RagStore::put`, used by `tenex-embedder`) populate `source_kind` and
/// `source_id` so they can be enumerated and bulk-deleted by source.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChunkMeta {
    pub source_kind: Option<String>,
    pub source_id: Option<String>,
    pub seq_start: Option<i64>,
    pub seq_end: Option<i64>,
    pub chunk_index: Option<i64>,
    pub meta_json: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct VectorMatch {
    pub id: String,
    pub collection: String,
    pub content: String,
    pub title: Option<String>,
    /// Similarity score in [0.0, 1.0]; higher is more similar.
    pub score: f32,
    pub source_kind: Option<String>,
    pub source_id: Option<String>,
    pub seq_start: Option<i64>,
    pub seq_end: Option<i64>,
    pub chunk_index: Option<i64>,
    pub meta_json: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchFilter {
    pub project_id: Option<String>,
}

#[async_trait]
pub trait VectorStore: Send + Sync {
    async fn upsert(
        &self,
        id: &str,
        collection: &str,
        content: &str,
        title: Option<&str>,
        vector: &[f32],
        meta: &ChunkMeta,
    ) -> anyhow::Result<()>;

    async fn search(
        &self,
        vector: &[f32],
        collections: &[&str],
        limit: usize,
    ) -> anyhow::Result<Vec<VectorMatch>>;

    async fn search_filtered(
        &self,
        vector: &[f32],
        collections: &[&str],
        limit: usize,
        filter: &SearchFilter,
    ) -> anyhow::Result<Vec<VectorMatch>>;

    async fn list_collections(&self) -> anyhow::Result<Vec<String>>;

    async fn delete_collection(&self, collection: &str) -> anyhow::Result<usize>;

    /// Remove every document with the given (`source_kind`, `source_id`).
    async fn delete_by_source(&self, source_kind: &str, source_id: &str) -> anyhow::Result<usize>;

    /// Remove a single document by its primary key. Returns the number
    /// of rows deleted (0 or 1).
    async fn delete_by_id(&self, id: &str) -> anyhow::Result<usize>;

    /// Enumerate documents for a given source, sorted by `chunk_index ASC`
    /// (with `NULL` values last). Vector blobs are not loaded.
    async fn list_chunks_for_source(
        &self,
        source_kind: &str,
        source_id: &str,
    ) -> anyhow::Result<Vec<VectorMatch>>;
}
