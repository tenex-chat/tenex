//! `tenex accounting` — query and serve the SQLite accounting store.

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use tenex_accounting::{default_db_path, query::QueryService};

#[derive(Args)]
pub struct AccountingArgs {
    #[command(subcommand)]
    pub command: AccountingCommand,
}

#[derive(Subcommand)]
pub enum AccountingCommand {
    /// Print a cost summary by provider, model, and agent.
    Cost(CostArgs),
    /// Stream the most recent LLM calls.
    Tail(TailArgs),
    /// Boot the embedded HTTP UI on a chosen address.
    Serve(ServeArgs),
    /// Print the absolute path of the active accounting database.
    Path,
}

#[derive(Args)]
pub struct CostArgs {
    /// Window — e.g. "1h", "24h", "7d", "30d". Default: 24h.
    #[arg(long, default_value = "24h")]
    pub since: String,
    /// Path to the accounting database (default: ~/.tenex/data/accounting/hot.db).
    #[arg(long)]
    pub db: Option<PathBuf>,
}

#[derive(Args)]
pub struct TailArgs {
    /// Number of recent LLM calls to print.
    #[arg(long, default_value_t = 50)]
    pub limit: i64,
    #[arg(long)]
    pub db: Option<PathBuf>,
}

#[derive(Args)]
pub struct ServeArgs {
    /// Address to bind, e.g. 127.0.0.1:9876.
    #[arg(long, default_value = "127.0.0.1:9876")]
    pub bind: String,
    #[arg(long)]
    pub db: Option<PathBuf>,
}

pub async fn run(args: AccountingArgs) -> Result<()> {
    match args.command {
        AccountingCommand::Cost(a) => run_cost(a).await,
        AccountingCommand::Tail(a) => run_tail(a).await,
        AccountingCommand::Serve(a) => run_serve(a).await,
        AccountingCommand::Path => {
            println!("{}", default_db_path().display());
            Ok(())
        }
    }
}

fn parse_window(s: &str) -> Result<i64> {
    let s = s.trim();
    let (num, unit) = s.split_at(s.len() - 1);
    let n: i64 = num.parse().with_context(|| format!("bad window: {s}"))?;
    Ok(match unit {
        "s" => n,
        "m" => n * 60,
        "h" => n * 3600,
        "d" => n * 86_400,
        _ => anyhow::bail!("window unit must be s|m|h|d, got {unit}"),
    })
}

fn db_or_default(p: Option<PathBuf>) -> PathBuf {
    p.unwrap_or_else(default_db_path)
}

async fn run_cost(a: CostArgs) -> Result<()> {
    let secs = parse_window(&a.since)?;
    let since_ms = Some(now_ms() - secs * 1000);
    let path = db_or_default(a.db);
    if !path.exists() {
        anyhow::bail!("accounting db not found at {}", path.display());
    }
    let q = QueryService::new(&path);
    let ov = q.overview(since_ms)?;
    println!(
        "Window: last {} ({} traces, {} llm_calls, {} embeddings, {} tool_calls)",
        a.since, ov.traces_total, ov.llm_calls, ov.embeddings, ov.tool_calls
    );
    println!("Total cost: ${:.6}", ov.total_cost_usd);
    println!();
    println!("By provider:");
    for p in &ov.cost_by_provider {
        println!(
            "  {:14} calls={:5}  in={:>9}  out={:>9}  cache_r={:>9}  cache_w={:>9}  cost=${:.6}  shadow=${:.6}",
            p.provider, p.calls, p.input_tokens, p.output_tokens,
            p.cache_read_tokens, p.cache_write_tokens, p.cost_usd, p.shadow_cost_usd
        );
    }
    println!();
    println!("By model:");
    for m in q.cost_by_model(since_ms)? {
        println!(
            "  {:14} {:35} calls={:5}  cost=${:.6}  avg_latency={:>5} ms  avg_tps={:>5}",
            m.provider,
            m.provider_model_id,
            m.calls,
            m.cost_usd,
            m.avg_latency_ms
                .map(|v| format!("{:.0}", v))
                .unwrap_or_else(|| "—".into()),
            m.avg_output_tps
                .map(|v| format!("{:.1}", v))
                .unwrap_or_else(|| "—".into()),
        );
    }
    println!();
    println!("By agent:");
    for a in q.cost_by_agent(since_ms)? {
        println!(
            "  {:30} calls={:5}  cost=${:.6}",
            a.agent, a.calls, a.cost_usd
        );
    }
    Ok(())
}

async fn run_tail(a: TailArgs) -> Result<()> {
    let path = db_or_default(a.db);
    if !path.exists() {
        anyhow::bail!("accounting db not found at {}", path.display());
    }
    let q = QueryService::new(&path);
    for r in q.recent_llm_calls(a.limit)? {
        println!(
            "{}  {:14} {:35} in={:>5} out={:>5} cost={:>12}  {:>6}ms  {}",
            short_id(&r.span_id),
            r.provider,
            r.provider_model_id,
            r.input_tokens,
            r.output_tokens,
            r.cost_usd
                .map(|c| format!("${:.6}", c))
                .unwrap_or_else(|| "—".into()),
            r.duration_ms.unwrap_or(0),
            r.finish_reason.as_deref().unwrap_or("—"),
        );
    }
    Ok(())
}

async fn run_serve(a: ServeArgs) -> Result<()> {
    let path = db_or_default(a.db);
    if !path.exists() {
        anyhow::bail!(
            "accounting db not found at {} — record some calls first",
            path.display()
        );
    }
    let bind: SocketAddr = a
        .bind
        .parse()
        .with_context(|| format!("invalid --bind: {}", a.bind))?;
    println!(
        "TENEX accounting → http://{}/  (db: {})",
        bind,
        path.display()
    );
    let q = QueryService::new(&path);
    tenex_accounting::server::serve(bind, q).await
}

fn short_id(id: &str) -> String {
    if id.len() <= 10 {
        id.to_string()
    } else {
        format!("{}…{}", &id[..6], &id[id.len() - 4..])
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
