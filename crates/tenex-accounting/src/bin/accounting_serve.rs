//! Standalone server binary: `cargo run --bin accounting_serve -- --bind 127.0.0.1:9876`.

use std::net::SocketAddr;

use anyhow::{Context, Result};
use tenex_accounting::{default_db_path, query::QueryService, server};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber_init();
    let mut args = std::env::args().skip(1);
    let mut bind: SocketAddr = "127.0.0.1:9876".parse().unwrap();
    let mut db_path = default_db_path();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--bind" => {
                let v = args.next().context("--bind requires an address")?;
                bind = v.parse().with_context(|| format!("invalid bind {v}"))?;
            }
            "--db" => {
                let v = args.next().context("--db requires a path")?;
                db_path = std::path::PathBuf::from(v);
            }
            other => anyhow::bail!("unknown arg: {other}"),
        }
    }
    if !db_path.exists() {
        anyhow::bail!(
            "accounting db not found at {} — run something that records first",
            db_path.display()
        );
    }
    let q = QueryService::new(&db_path);
    println!(
        "TENEX accounting → http://{bind}/  (db: {})",
        db_path.display()
    );
    server::serve(bind, q).await?;
    Ok(())
}

fn tracing_subscriber_init() {
    let _ = tracing_subscriber_default();
}

fn tracing_subscriber_default() -> Result<()> {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "[tenex-accounting] log to stderr");
    Ok(())
}
