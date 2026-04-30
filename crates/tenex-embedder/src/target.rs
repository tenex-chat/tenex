//! Write side. Wraps `tenex-rag::RagStore` with stable IDs and the
//! collection name(s).

use anyhow::Result;
use tenex_rag::{ChunkMeta, RagStore, SearchResult};

pub const SOURCE_KIND_CHUNK: &str = "conversation_chunk";

pub const COLLECTION_TRANSCRIPTS: &str = "conversations";

pub fn chunk_id(conversation_id: &str, chunk_index: i64) -> String {
    format!("conv_{conversation_id}_{chunk_index:04}")
}

pub struct EmbedTarget<'a> {
    rag: &'a RagStore,
}

impl<'a> EmbedTarget<'a> {
    pub fn new(rag: &'a RagStore) -> Self {
        Self { rag }
    }

    pub async fn put_chunk(
        &self,
        conversation_id: &str,
        chunk_index: i64,
        title: Option<&str>,
        content: &str,
        seq_start: i64,
        seq_end: i64,
        meta_json: serde_json::Value,
    ) -> Result<()> {
        let id = chunk_id(conversation_id, chunk_index);
        let meta = ChunkMeta {
            source_kind: Some(SOURCE_KIND_CHUNK.to_string()),
            source_id: Some(conversation_id.to_string()),
            seq_start: Some(seq_start),
            seq_end: Some(seq_end),
            chunk_index: Some(chunk_index),
            meta_json: Some(meta_json),
        };
        self.rag
            .put(&id, COLLECTION_TRANSCRIPTS, content, title, &meta)
            .await
    }

    pub async fn list_existing_chunks(&self, conversation_id: &str) -> Result<Vec<SearchResult>> {
        self.rag
            .list_chunks_for_source(SOURCE_KIND_CHUNK, conversation_id)
            .await
    }

    pub async fn delete_chunk_by_index(
        &self,
        conversation_id: &str,
        chunk_index: i64,
    ) -> Result<usize> {
        self.rag.delete_by_id(&chunk_id(conversation_id, chunk_index)).await
    }

    pub async fn delete_all_for_conversation(&self, conversation_id: &str) -> Result<usize> {
        self.rag
            .delete_by_source(SOURCE_KIND_CHUNK, conversation_id)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_id_zero_pads_to_width_four() {
        assert_eq!(chunk_id("abc", 0), "conv_abc_0000");
        assert_eq!(chunk_id("abc", 12), "conv_abc_0012");
    }
}
