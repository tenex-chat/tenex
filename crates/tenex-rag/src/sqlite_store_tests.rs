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
    let v_a = unit_vec(4, 0);
    let v_b = unit_vec(4, 1);
    store
        .upsert("a", "col_a", "doc in a", None, &v_a)
        .await
        .unwrap();
    store
        .upsert("b", "col_b", "doc in b", None, &v_b)
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
