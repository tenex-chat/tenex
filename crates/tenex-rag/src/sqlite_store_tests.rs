use super::*;
use crate::store::{ChunkMeta, SearchFilter};
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

fn empty_meta() -> ChunkMeta {
    ChunkMeta::default()
}

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

#[tokio::test]
async fn open_creates_schema() {
    let f = NamedTempFile::new().unwrap();
    let store = SqliteStore::open(f.path()).unwrap();
    let cols = store.list_collections().await.unwrap();
    assert!(cols.is_empty());
}

#[tokio::test]
async fn upsert_then_search_returns_match() {
    let (store, _f) = temp_store();
    let v = unit_vec(4, 0);
    store
        .upsert(
            "doc1",
            "col_a",
            "hello world",
            Some("Title"),
            &v,
            &empty_meta(),
        )
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
    assert!(m.source_kind.is_none());
    assert!(m.meta_json.is_none());
}

#[tokio::test]
async fn search_respects_collection_filter() {
    let (store, _f) = temp_store();
    let v_a = unit_vec(4, 0);
    let v_b = unit_vec(4, 1);
    store
        .upsert("a", "col_a", "doc in a", None, &v_a, &empty_meta())
        .await
        .unwrap();
    store
        .upsert("b", "col_b", "doc in b", None, &v_b, &empty_meta())
        .await
        .unwrap();

    let results = store.search(&v_a, &["col_a"], 10).await.unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "a");

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
            .upsert(
                &format!("doc{i}"),
                "col",
                &format!("content {i}"),
                None,
                &v,
                &empty_meta(),
            )
            .await
            .unwrap();
    }
    let results = store.search(&v, &["col"], 3).await.unwrap();
    assert_eq!(results.len(), 3);
}

#[tokio::test]
async fn search_filtered_respects_project_id_metadata() {
    let (store, _f) = temp_store();
    let v = unit_vec(4, 0);
    let meta_a = ChunkMeta {
        meta_json: Some(serde_json::json!({
            "project_id": "alpha",
            "project_ids": ["alpha"]
        })),
        ..ChunkMeta::default()
    };
    let meta_b = ChunkMeta {
        meta_json: Some(serde_json::json!({
            "project_ids": ["beta", "gamma"]
        })),
        ..ChunkMeta::default()
    };
    store
        .upsert("a", "conversations", "alpha doc", None, &v, &meta_a)
        .await
        .unwrap();
    store
        .upsert("b", "conversations", "beta doc", None, &v, &meta_b)
        .await
        .unwrap();
    store
        .upsert(
            "legacy",
            "conversations",
            "legacy doc",
            None,
            &v,
            &empty_meta(),
        )
        .await
        .unwrap();

    let beta = store
        .search_filtered(
            &v,
            &["conversations"],
            10,
            &SearchFilter {
                project_id: Some("beta".to_string()),
            },
        )
        .await
        .unwrap();
    assert_eq!(beta.len(), 1);
    assert_eq!(beta[0].id, "b");

    let all = store
        .search_filtered(&v, &["conversations"], 10, &SearchFilter::default())
        .await
        .unwrap();
    assert_eq!(all.len(), 3);
}

#[tokio::test]
async fn upsert_overwrites_existing_id() {
    let (store, _f) = temp_store();
    let v1 = unit_vec(4, 0);
    let v2 = unit_vec(4, 1);
    store
        .upsert("doc1", "col", "original", None, &v1, &empty_meta())
        .await
        .unwrap();
    store
        .upsert("doc1", "col", "updated", None, &v2, &empty_meta())
        .await
        .unwrap();

    let results = store.search(&v2, &["col"], 5).await.unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].content, "updated");
    assert!((results[0].score - 1.0).abs() < 1e-6);
}

#[tokio::test]
async fn list_collections_returns_unique_names() {
    let (store, _f) = temp_store();
    let v = unit_vec(4, 0);
    store
        .upsert("a1", "alpha", "x", None, &v, &empty_meta())
        .await
        .unwrap();
    store
        .upsert("a2", "alpha", "y", None, &v, &empty_meta())
        .await
        .unwrap();
    store
        .upsert("b1", "beta", "z", None, &v, &empty_meta())
        .await
        .unwrap();

    let cols = store.list_collections().await.unwrap();
    assert_eq!(cols, vec!["alpha", "beta"]);
}

#[tokio::test]
async fn delete_collection_removes_only_target() {
    let (store, _f) = temp_store();
    let v = unit_vec(4, 0);
    store
        .upsert("a", "col_a", "in a", None, &v, &empty_meta())
        .await
        .unwrap();
    store
        .upsert("b", "col_b", "in b", None, &v, &empty_meta())
        .await
        .unwrap();

    let deleted = store.delete_collection("col_a").await.unwrap();
    assert_eq!(deleted, 1);

    let results = store.search(&v, &["col_a"], 10).await.unwrap();
    assert!(results.is_empty());
    let results = store.search(&v, &["col_b"], 10).await.unwrap();
    assert_eq!(results.len(), 1);
}

#[tokio::test]
async fn search_returns_results_sorted_by_score_descending() {
    let (store, _f) = temp_store();
    let v_query = vec![1.0f32, 0.0, 0.0, 0.0];
    let v_close = vec![0.9f32, 0.1, 0.0, 0.0];
    let v_far = vec![0.0f32, 1.0, 0.0, 0.0];
    store
        .upsert("far", "col", "far doc", None, &v_far, &empty_meta())
        .await
        .unwrap();
    store
        .upsert("close", "col", "close doc", None, &v_close, &empty_meta())
        .await
        .unwrap();

    let results = store.search(&v_query, &["col"], 5).await.unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].id, "close", "highest-score doc should be first");
    assert!(results[0].score > results[1].score);
}

#[tokio::test]
async fn upsert_persists_chunk_meta_and_search_returns_it() {
    let (store, _f) = temp_store();
    let v = unit_vec(4, 0);
    let meta = ChunkMeta {
        source_kind: Some("conversation_chunk".into()),
        source_id: Some("conv-123".into()),
        seq_start: Some(10),
        seq_end: Some(40),
        chunk_index: Some(0),
        meta_json: Some(serde_json::json!({"parent_conversation_id": "p"})),
    };
    store
        .upsert("conv-123_0000", "conversations", "body", None, &v, &meta)
        .await
        .unwrap();

    let results = store.search(&v, &["conversations"], 5).await.unwrap();
    let m = &results[0];
    assert_eq!(m.source_kind.as_deref(), Some("conversation_chunk"));
    assert_eq!(m.source_id.as_deref(), Some("conv-123"));
    assert_eq!(m.seq_start, Some(10));
    assert_eq!(m.seq_end, Some(40));
    assert_eq!(m.chunk_index, Some(0));
    assert_eq!(
        m.meta_json
            .as_ref()
            .and_then(|j| j.get("parent_conversation_id"))
            .and_then(|v| v.as_str()),
        Some("p")
    );
}

#[tokio::test]
async fn delete_by_source_removes_only_matching() {
    let (store, _f) = temp_store();
    let v = unit_vec(4, 0);
    let mk = |src_id: &str, idx: i64| ChunkMeta {
        source_kind: Some("conversation_chunk".into()),
        source_id: Some(src_id.into()),
        chunk_index: Some(idx),
        ..ChunkMeta::default()
    };
    store
        .upsert("a_0", "conversations", "x", None, &v, &mk("a", 0))
        .await
        .unwrap();
    store
        .upsert("a_1", "conversations", "y", None, &v, &mk("a", 1))
        .await
        .unwrap();
    store
        .upsert("b_0", "conversations", "z", None, &v, &mk("b", 0))
        .await
        .unwrap();

    let deleted = store
        .delete_by_source("conversation_chunk", "a")
        .await
        .unwrap();
    assert_eq!(deleted, 2);

    let remaining = store.search(&v, &["conversations"], 10).await.unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, "b_0");
}

#[tokio::test]
async fn list_chunks_for_source_orders_by_chunk_index() {
    let (store, _f) = temp_store();
    let v = unit_vec(4, 0);
    let mk = |idx: i64| ChunkMeta {
        source_kind: Some("conversation_chunk".into()),
        source_id: Some("conv1".into()),
        chunk_index: Some(idx),
        ..ChunkMeta::default()
    };
    // Insert out of order to verify ordering on read.
    store
        .upsert("conv1_0002", "conversations", "third", None, &v, &mk(2))
        .await
        .unwrap();
    store
        .upsert("conv1_0000", "conversations", "first", None, &v, &mk(0))
        .await
        .unwrap();
    store
        .upsert("conv1_0001", "conversations", "second", None, &v, &mk(1))
        .await
        .unwrap();

    let chunks = store
        .list_chunks_for_source("conversation_chunk", "conv1")
        .await
        .unwrap();
    let indices: Vec<i64> = chunks.iter().filter_map(|c| c.chunk_index).collect();
    assert_eq!(indices, vec![0, 1, 2]);
}
