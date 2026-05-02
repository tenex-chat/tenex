use anyhow::Result;
use rusqlite::{params, Connection};
use tenex_accounting::{schema, QueryService};

fn insert_llm_call(
    conn: &Connection,
    span_id: &str,
    agent_pubkey: Option<&str>,
    agent_slug: Option<&str>,
    started_at_ms: i64,
    input_tokens: i64,
    output_tokens: i64,
    cost_usd: f64,
) -> Result<()> {
    conn.execute(
        r#"INSERT OR IGNORE INTO traces(trace_id, root_kind, started_at_ms)
           VALUES ('trace-1', 'user_message', 1)"#,
        [],
    )?;
    conn.execute(
        r#"INSERT INTO spans(
               span_id, trace_id, kind, agent_pubkey, agent_slug, started_at_ms, depth, status
           ) VALUES (?1, 'trace-1', 'llm_call', ?2, ?3, ?4, 1, 'ok')"#,
        params![span_id, agent_pubkey, agent_slug, started_at_ms],
    )?;
    conn.execute(
        r#"INSERT INTO llm_calls(
               span_id, provider, provider_model_id, operation,
               input_tokens, output_tokens, total_cost_usd_estimated
           ) VALUES (?1, 'mock', 'mock-model', 'stream', ?2, ?3, ?4)"#,
        params![span_id, input_tokens, output_tokens, cost_usd],
    )?;
    Ok(())
}

#[test]
fn cost_by_agent_prefers_directory_slug_for_pubkey_only_rows() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let db_path = temp.path().join("hot.db");
    let conn = schema::open_with_migrations(&db_path)?;
    let pubkey = "abcdef1234567890";
    insert_llm_call(&conn, "span-1", Some(pubkey), None, 1, 10, 20, 0.25)?;

    let rows = QueryService::new(&db_path)
        .with_agent_slugs(vec![(pubkey.to_string(), "architect".to_string())])
        .cost_by_agent(None)?;

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].agent, "architect");
    assert_eq!(rows[0].agent_pubkey.as_deref(), Some(pubkey));
    assert_eq!(rows[0].calls, 1);
    Ok(())
}

#[test]
fn cost_by_agent_groups_old_pubkey_rows_with_new_slug_rows() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let db_path = temp.path().join("hot.db");
    let conn = schema::open_with_migrations(&db_path)?;
    let pubkey = "1234567890abcdef";
    insert_llm_call(&conn, "span-old", Some(pubkey), None, 1, 10, 20, 1.0)?;
    insert_llm_call(
        &conn,
        "span-new",
        Some(pubkey),
        Some("planner"),
        2,
        30,
        40,
        2.0,
    )?;

    let rows = QueryService::new(&db_path).cost_by_agent(None)?;

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].agent, "planner");
    assert_eq!(rows[0].agent_pubkey.as_deref(), Some(pubkey));
    assert_eq!(rows[0].calls, 2);
    assert_eq!(rows[0].input_tokens, 40);
    assert_eq!(rows[0].output_tokens, 60);
    assert!((rows[0].cost_usd - 3.0).abs() < f64::EPSILON);
    Ok(())
}
