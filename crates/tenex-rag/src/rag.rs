use std::path::Path;

use anyhow::Result;
use sha2::{Digest, Sha256};

use crate::config::EmbedConfig;
use crate::embed::EmbeddingClient;
use crate::sqlite_store::SqliteStore;
use crate::store::{ChunkMeta, VectorMatch, VectorStore};

#[derive(Debug, Clone)]
pub struct SearchResult {
    pub id: String,
    pub collection: String,
    pub content: String,
    pub title: Option<String>,
    pub score: f32,
    pub source_kind: Option<String>,
    pub source_id: Option<String>,
    pub seq_start: Option<i64>,
    pub seq_end: Option<i64>,
    pub chunk_index: Option<i64>,
    pub meta_json: Option<serde_json::Value>,
}

impl From<VectorMatch> for SearchResult {
    fn from(m: VectorMatch) -> Self {
        Self {
            id: m.id,
            collection: m.collection,
            content: m.content,
            title: m.title,
            score: m.score,
            source_kind: m.source_kind,
            source_id: m.source_id,
            seq_start: m.seq_start,
            seq_end: m.seq_end,
            chunk_index: m.chunk_index,
            meta_json: m.meta_json,
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
    /// Embed and store a document with a content-derived ID. Used by
    /// agent-facing tools (`rag_add_documents`) where the writer doesn't
    /// track stable IDs. Identical content upserts cleanly.
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
        self.store
            .upsert(&id, collection, content, title, &vector, &ChunkMeta::default())
            .await?;
        Ok(id)
    }

    /// Embed and store a document with a caller-supplied stable ID and
    /// source metadata. Used by `tenex-embedder` for source-keyed chunks
    /// that may need bulk invalidation.
    pub async fn put(
        &self,
        id: &str,
        collection: &str,
        content: &str,
        title: Option<&str>,
        meta: &ChunkMeta,
    ) -> Result<()> {
        let vector = self.embed.embed(content).await?;
        self.store
            .upsert(id, collection, content, title, &vector, meta)
            .await
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

    pub async fn delete_by_source(
        &self,
        source_kind: &str,
        source_id: &str,
    ) -> Result<usize> {
        self.store.delete_by_source(source_kind, source_id).await
    }

    pub async fn delete_by_id(&self, id: &str) -> Result<usize> {
        self.store.delete_by_id(id).await
    }

    pub async fn list_chunks_for_source(
        &self,
        source_kind: &str,
        source_id: &str,
    ) -> Result<Vec<SearchResult>> {
        let matches = self
            .store
            .list_chunks_for_source(source_kind, source_id)
            .await?;
        Ok(matches.into_iter().map(SearchResult::from).collect())
    }
}
