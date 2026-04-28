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

        Ok(Self { conn: Mutex::new(conn) })
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

        let params: Vec<&dyn rusqlite::ToSql> =
            collections.iter().map(|c| c as &dyn rusqlite::ToSql).collect();

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
                Some(VectorMatch { id, collection, content, title, score })
            })
            .collect();

        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        Ok(scored)
    }
}

fn floats_to_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn bytes_to_floats(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
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
