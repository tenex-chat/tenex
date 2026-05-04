use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use async_trait::async_trait;
use rusqlite::Connection;

use crate::schema;
use crate::store::{ChunkMeta, SearchFilter, VectorMatch, VectorStore};

pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create dir {}", parent.display()))?;
        }

        let mut conn = Connection::open(path)
            .with_context(|| format!("open embeddings DB at {}", path.display()))?;

        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout=5000;",
        )
        .context("set sqlite pragmas")?;

        schema::ensure_schema(&mut conn).context("apply embeddings.db schema")?;

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
        meta: &ChunkMeta,
    ) -> Result<()> {
        let blob = floats_to_bytes(vector);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let meta_json = match &meta.meta_json {
            Some(v) => Some(v.to_string()),
            None => None,
        };

        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO doc_meta (
                 id, collection, content, title, vector_blob, created_at,
                 source_kind, source_id, seq_start, seq_end, chunk_index, meta_json
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
               collection  = excluded.collection,
               content     = excluded.content,
               title       = excluded.title,
               vector_blob = excluded.vector_blob,
               created_at  = excluded.created_at,
               source_kind = excluded.source_kind,
               source_id   = excluded.source_id,
               seq_start   = excluded.seq_start,
               seq_end     = excluded.seq_end,
               chunk_index = excluded.chunk_index,
               meta_json   = excluded.meta_json",
            rusqlite::params![
                id,
                collection,
                content,
                title,
                blob,
                now,
                meta.source_kind,
                meta.source_id,
                meta.seq_start,
                meta.seq_end,
                meta.chunk_index,
                meta_json,
            ],
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
        self.search_filtered(query_vector, collections, limit, &SearchFilter::default())
            .await
    }

    async fn search_filtered(
        &self,
        query_vector: &[f32],
        collections: &[&str],
        limit: usize,
        filter: &SearchFilter,
    ) -> Result<Vec<VectorMatch>> {
        let placeholders: Vec<String> = (1..=collections.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT id, collection, content, title, vector_blob,
                    source_kind, source_id, seq_start, seq_end, chunk_index, meta_json
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

        type Row = (
            String,
            String,
            String,
            Option<String>,
            Vec<u8>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<String>,
        );

        let rows: Vec<Row> = stmt
            .query_map(params.as_slice(), |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                ))
            })
            .context("execute search query")?
            .filter_map(|r| r.ok())
            .collect();

        drop(stmt);
        drop(conn);

        let mut scored: Vec<VectorMatch> = rows
            .into_iter()
            .filter_map(
                |(
                    id,
                    collection,
                    content,
                    title,
                    blob,
                    source_kind,
                    source_id,
                    seq_start,
                    seq_end,
                    chunk_index,
                    meta_json_str,
                )| {
                    let meta_json = meta_json_str
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok());
                    if !meta_matches_filter(meta_json.as_ref(), filter) {
                        return None;
                    }
                    let doc_vec = bytes_to_floats(&blob);
                    let score = cosine_similarity(query_vector, &doc_vec)?;
                    Some(VectorMatch {
                        id,
                        collection,
                        content,
                        title,
                        score,
                        source_kind,
                        source_id,
                        seq_start,
                        seq_end,
                        chunk_index,
                        meta_json,
                    })
                },
            )
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

    async fn delete_by_source(&self, source_kind: &str, source_id: &str) -> anyhow::Result<usize> {
        let conn = self.conn.lock().unwrap();
        let n = conn
            .execute(
                "DELETE FROM doc_meta WHERE source_kind = ?1 AND source_id = ?2",
                rusqlite::params![source_kind, source_id],
            )
            .with_context(|| format!("delete by source '{source_kind}/{source_id}'"))?;
        Ok(n)
    }

    async fn delete_by_id(&self, id: &str) -> anyhow::Result<usize> {
        let conn = self.conn.lock().unwrap();
        let n = conn
            .execute("DELETE FROM doc_meta WHERE id = ?1", rusqlite::params![id])
            .with_context(|| format!("delete by id '{id}'"))?;
        Ok(n)
    }

    async fn list_chunks_for_source(
        &self,
        source_kind: &str,
        source_id: &str,
    ) -> anyhow::Result<Vec<VectorMatch>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, collection, content, title,
                        source_kind, source_id, seq_start, seq_end, chunk_index, meta_json
                 FROM doc_meta
                 WHERE source_kind = ?1 AND source_id = ?2
                 ORDER BY chunk_index IS NULL, chunk_index ASC, id ASC",
            )
            .context("prepare list_chunks_for_source")?;

        type Row = (
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<String>,
        );

        let rows: Vec<Row> = stmt
            .query_map(rusqlite::params![source_kind, source_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                ))
            })
            .context("execute list_chunks_for_source")?
            .filter_map(|r| r.ok())
            .collect();

        let out = rows
            .into_iter()
            .map(
                |(
                    id,
                    collection,
                    content,
                    title,
                    source_kind,
                    source_id,
                    seq_start,
                    seq_end,
                    chunk_index,
                    meta_json_str,
                )| {
                    let meta_json = meta_json_str
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok());
                    VectorMatch {
                        id,
                        collection,
                        content,
                        title,
                        // Score is undefined when listing without a query; use 0.0.
                        score: 0.0,
                        source_kind,
                        source_id,
                        seq_start,
                        seq_end,
                        chunk_index,
                        meta_json,
                    }
                },
            )
            .collect();
        Ok(out)
    }
}

fn meta_matches_filter(meta_json: Option<&serde_json::Value>, filter: &SearchFilter) -> bool {
    let Some(project_id) = filter.project_id.as_deref().filter(|id| !id.is_empty()) else {
        return true;
    };
    let Some(meta) = meta_json else {
        return false;
    };

    if meta
        .get("project_id")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value == project_id)
    {
        return true;
    }

    meta.get("project_ids")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|values| {
            values
                .iter()
                .any(|value| value.as_str() == Some(project_id))
        })
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
#[path = "sqlite_store_tests.rs"]
mod sqlite_store_tests;
