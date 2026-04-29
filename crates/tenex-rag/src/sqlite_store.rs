use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use async_trait::async_trait;
use rusqlite::Connection;

use crate::store::{VectorMatch, VectorStore};

pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create dir {}", parent.display()))?;
        }

        let conn = Connection::open(path)
            .with_context(|| format!("open embeddings DB at {}", path.display()))?;

        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout=5000;
             CREATE TABLE IF NOT EXISTS doc_meta (
               id          TEXT PRIMARY KEY,
               collection  TEXT NOT NULL,
               content     TEXT NOT NULL,
               title       TEXT,
               vector_blob BLOB NOT NULL,
               created_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_collection ON doc_meta(collection);",
        )
        .context("initialize embeddings DB schema")?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

#[async_trait]
impl VectorStore for SqliteStore {
    async fn upsert(
        &self,
        id: &str,
        collection: &str,
        content: &str,
        title: Option<&str>,
        vector: &[f32],
    ) -> Result<()> {
        let blob = floats_to_bytes(vector);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO doc_meta (id, collection, content, title, vector_blob, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               collection  = excluded.collection,
               content     = excluded.content,
               title       = excluded.title,
               vector_blob = excluded.vector_blob,
               created_at  = excluded.created_at",
            rusqlite::params![id, collection, content, title, blob, now],
        )
        .with_context(|| format!("upsert doc '{id}'"))?;

        Ok(())
    }

    async fn search(
        &self,
        query_vector: &[f32],
        collections: &[&str],
        limit: usize,
    ) -> Result<Vec<VectorMatch>> {
        let placeholders: Vec<String> = (1..=collections.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT id, collection, content, title, vector_blob
             FROM doc_meta
             WHERE collection IN ({})",
            placeholders.join(", ")
        );

        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql).context("prepare search statement")?;

        let params: Vec<&dyn rusqlite::ToSql> = collections
            .iter()
            .map(|c| c as &dyn rusqlite::ToSql)
            .collect();

        let rows: Vec<(String, String, String, Option<String>, Vec<u8>)> = stmt
            .query_map(params.as_slice(), |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .context("execute search query")?
            .filter_map(|r| r.ok())
            .collect();

        drop(stmt);
        drop(conn);

        let mut scored: Vec<VectorMatch> = rows
            .into_iter()
            .filter_map(|(id, collection, content, title, blob)| {
                let doc_vec = bytes_to_floats(&blob);
                let score = cosine_similarity(query_vector, &doc_vec)?;
                Some(VectorMatch {
                    id,
                    collection,
                    content,
                    title,
                    score,
                })
            })
            .collect();

        scored.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        scored.truncate(limit);
        Ok(scored)
    }

    async fn list_collections(&self) -> anyhow::Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT DISTINCT collection FROM doc_meta ORDER BY collection")
            .context("prepare list_collections")?;
        let collections: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .context("query list_collections")?
            .filter_map(|r| r.ok())
            .collect();
        Ok(collections)
    }

    async fn delete_collection(&self, collection: &str) -> anyhow::Result<usize> {
        let conn = self.conn.lock().unwrap();
        let n = conn
            .execute(
                "DELETE FROM doc_meta WHERE collection = ?1",
                rusqlite::params![collection],
            )
            .with_context(|| format!("delete collection '{collection}'"))?;
        Ok(n)
    }
}

fn floats_to_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn bytes_to_floats(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> Option<f32> {
    if a.len() != b.len() || a.is_empty() {
        return None;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let mag_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let mag_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if mag_a == 0.0 || mag_b == 0.0 {
        return None;
    }
    // Map [-1, 1] → [0, 1]
    Some((dot / (mag_a * mag_b) + 1.0) / 2.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    fn temp_store() -> (SqliteStore, NamedTempFile) {
        let f = NamedTempFile::new().unwrap();
        let store = SqliteStore::open(f.path()).unwrap();
        (store, f)
    }

    fn unit_vec(dim: usize, hot: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; dim];
        v[hot] = 1.0;
        v
    }

    // ── cosine_similarity ────────────────────────────────────────────────────

    #[test]
    fn identical_vectors_score_one() {
        let v = vec![1.0f32, 2.0, 3.0];
        let score = cosine_similarity(&v, &v).unwrap();
        assert!((score - 1.0).abs() < 1e-6, "expected 1.0, got {score}");
    }

    #[test]
    fn opposite_vectors_score_zero() {
        let a = vec![1.0f32, 0.0];
        let b = vec![-1.0f32, 0.0];
        let score = cosine_similarity(&a, &b).unwrap();
        assert!(score.abs() < 1e-6, "expected 0.0, got {score}");
    }

    #[test]
    fn orthogonal_vectors_score_half() {
        let a = unit_vec(2, 0);
        let b = unit_vec(2, 1);
        let score = cosine_similarity(&a, &b).unwrap();
        assert!((score - 0.5).abs() < 1e-6, "expected 0.5, got {score}");
    }

    #[test]
    fn mismatched_lengths_return_none() {
        assert!(cosine_similarity(&[1.0], &[1.0, 2.0]).is_none());
    }

    #[test]
    fn empty_vectors_return_none() {
        assert!(cosine_similarity(&[], &[]).is_none());
    }

    #[test]
    fn zero_magnitude_returns_none() {
        assert!(cosine_similarity(&[0.0, 0.0], &[1.0, 0.0]).is_none());
    }

    // ── SqliteStore ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn open_creates_schema() {
        let f = NamedTempFile::new().unwrap();
        let store = SqliteStore::open(f.path()).unwrap();
        // list_collections returns Ok (empty) right after open
        let cols = store.list_collections().await.unwrap();
        assert!(cols.is_empty());
    }

    #[tokio::test]
    async fn upsert_then_search_returns_match() {
        let (store, _f) = temp_store();
        let v = unit_vec(4, 0);
        store
            .upsert("doc1", "col_a", "hello world", Some("Title"), &v)
            .await
            .unwrap();

        let results = store.search(&v, &["col_a"], 5).await.unwrap();
        assert_eq!(results.len(), 1);
        let m = &results[0];
        assert_eq!(m.id, "doc1");
        assert_eq!(m.collection, "col_a");
        assert_eq!(m.content, "hello world");
        assert_eq!(m.title.as_deref(), Some("Title"));
        assert!(
            (m.score - 1.0).abs() < 1e-6,
            "expected score=1.0, got {}",
            m.score
        );
    }

    #[tokio::test]
    async fn search_respects_collection_filter() {
        let (store, _f) = temp_store();
        let v_a = unit_vec(4, 0); // points along dim 0
        let v_b = unit_vec(4, 1); // points along dim 1
        store
            .upsert("a", "col_a", "doc in a", None, &v_a)
            .await
            .unwrap();
        store
            .upsert("b", "col_b", "doc in b", None, &v_b)
            .await
            .unwrap();

        // Query with v_a, only search col_a — should not return col_b doc
        let results = store.search(&v_a, &["col_a"], 10).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "a");

        // Search col_b only — returns col_b doc (lower score since query=v_a≠v_b)
        let results = store.search(&v_a, &["col_b"], 10).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "b");
    }

    #[tokio::test]
    async fn search_limit_is_respected() {
        let (store, _f) = temp_store();
        let v = unit_vec(4, 0);
        for i in 0..5usize {
            store
                .upsert(&format!("doc{i}"), "col", &format!("content {i}"), None, &v)
                .await
                .unwrap();
        }
        let results = store.search(&v, &["col"], 3).await.unwrap();
        assert_eq!(results.len(), 3);
    }

    #[tokio::test]
    async fn upsert_overwrites_existing_id() {
        let (store, _f) = temp_store();
        let v1 = unit_vec(4, 0);
        let v2 = unit_vec(4, 1);
        store
            .upsert("doc1", "col", "original", None, &v1)
            .await
            .unwrap();
        store
            .upsert("doc1", "col", "updated", None, &v2)
            .await
            .unwrap();

        // Search with v2 — updated vector should match at score=1.0
        let results = store.search(&v2, &["col"], 5).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, "updated");
        assert!((results[0].score - 1.0).abs() < 1e-6);
    }

    #[tokio::test]
    async fn list_collections_returns_unique_names() {
        let (store, _f) = temp_store();
        let v = unit_vec(4, 0);
        store.upsert("a1", "alpha", "x", None, &v).await.unwrap();
        store.upsert("a2", "alpha", "y", None, &v).await.unwrap();
        store.upsert("b1", "beta", "z", None, &v).await.unwrap();

        let cols = store.list_collections().await.unwrap();
        assert_eq!(cols, vec!["alpha", "beta"]);
    }

    #[tokio::test]
    async fn delete_collection_removes_only_target() {
        let (store, _f) = temp_store();
        let v = unit_vec(4, 0);
        store.upsert("a", "col_a", "in a", None, &v).await.unwrap();
        store.upsert("b", "col_b", "in b", None, &v).await.unwrap();

        let deleted = store.delete_collection("col_a").await.unwrap();
        assert_eq!(deleted, 1);

        // col_a gone, col_b still there
        let results = store.search(&v, &["col_a"], 10).await.unwrap();
        assert!(results.is_empty());
        let results = store.search(&v, &["col_b"], 10).await.unwrap();
        assert_eq!(results.len(), 1);
    }

    #[tokio::test]
    async fn search_returns_results_sorted_by_score_descending() {
        let (store, _f) = temp_store();
        // v_query = [1,0,0,0], v_close = [0.9, 0.1, 0, 0], v_far = [0, 1, 0, 0]
        let v_query = vec![1.0f32, 0.0, 0.0, 0.0];
        let v_close = vec![0.9f32, 0.1, 0.0, 0.0];
        let v_far = vec![0.0f32, 1.0, 0.0, 0.0];
        store
            .upsert("far", "col", "far doc", None, &v_far)
            .await
            .unwrap();
        store
            .upsert("close", "col", "close doc", None, &v_close)
            .await
            .unwrap();

        let results = store.search(&v_query, &["col"], 5).await.unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].id, "close", "highest-score doc should be first");
        assert!(results[0].score > results[1].score);
    }
}
