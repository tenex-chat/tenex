use anyhow::Result;
use rusqlite::Connection;
use tenex_accounting::schema;

#[test]
fn migrations_are_idempotent_under_concurrent_open() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let db_path = temp.path().join("hot.db");

    let handles = (0..8)
        .map(|_| {
            let db_path = db_path.clone();
            std::thread::spawn(move || schema::open_with_migrations(&db_path).map(|_| ()))
        })
        .collect::<Vec<_>>();

    for handle in handles {
        handle.join().expect("migration thread panicked")?;
    }

    let conn = Connection::open(db_path)?;
    let version: i32 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(version, schema::SCHEMA_VERSION);
    Ok(())
}
