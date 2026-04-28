use async_trait::async_trait;

#[derive(Debug, Clone)]
pub struct VectorMatch {
    pub id: String,
    pub collection: String,
    pub content: String,
    pub title: Option<String>,
    /// Similarity score in [0.0, 1.0]; higher is more similar.
    pub score: f32,
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
    ) -> anyhow::Result<()>;

    async fn search(
        &self,
        vector: &[f32],
        collections: &[&str],
        limit: usize,
    ) -> anyhow::Result<Vec<VectorMatch>>;

    async fn list_collections(&self) -> anyhow::Result<Vec<String>>;

    async fn delete_collection(&self, collection: &str) -> anyhow::Result<usize>;
}
