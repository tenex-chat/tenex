use std::path::Path;

use anyhow::Result;
use sha2::{Digest, Sha256};

use crate::config::EmbedConfig;
use crate::embed::EmbeddingClient;
use crate::sqlite_store::SqliteStore;
use crate::store::{VectorMatch, VectorStore};

#[derive(Debug, Clone)]
pub struct SearchResult {
    pub id: String,
    pub collection: String,
    pub content: String,
    pub title: Option<String>,
    pub score: f32,
}

impl From<VectorMatch> for SearchResult {
    fn from(m: VectorMatch) -> Self {
        Self {
            id: m.id,
            collection: m.collection,
            content: m.content,
            title: m.title,
            score: m.score,
        }
    }
}

pub struct RagStore<S: VectorStore = SqliteStore> {
    embed: EmbeddingClient,
    store: S,
}

impl RagStore<SqliteStore> {
    pub fn open(db_path: &Path, config: &EmbedConfig) -> Result<Self> {
        let embed = EmbeddingClient::new(config)?;
        let store = SqliteStore::open(db_path)?;
        Ok(Self { embed, store })
    }
}

impl<S: VectorStore> RagStore<S> {
    /// Embed and store a document. The ID is derived from the collection name
    /// and a hash of the content so identical content upserts cleanly.
    /// Returns the assigned document ID.
    pub async fn index(
        &self,
        content: &str,
        title: Option<&str>,
        collection: &str,
    ) -> Result<String> {
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        let hash = hex::encode(&hasher.finalize()[..8]);
        let id = format!("{collection}_{hash}");

        let vector = self.embed.embed(content).await?;
        self.store.upsert(&id, collection, content, title, &vector).await?;
        Ok(id)
    }

    pub async fn search(
        &self,
        query: &str,
        collections: &[&str],
        limit: usize,
    ) -> Result<Vec<SearchResult>> {
        let vector = self.embed.embed(query).await?;
        let matches = self.store.search(&vector, collections, limit).await?;
        Ok(matches.into_iter().map(SearchResult::from).collect())
    }

    pub async fn list_collections(&self) -> Result<Vec<String>> {
        self.store.list_collections().await
    }

    pub async fn delete_collection(&self, collection: &str) -> Result<usize> {
        self.store.delete_collection(collection).await
    }
}
