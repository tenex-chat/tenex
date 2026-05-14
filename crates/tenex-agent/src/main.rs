mod agent_bootstrap;
mod llm_accounting;
mod cassette;
mod cassette_client;
mod cassette_request;
mod categorize;
mod compaction;
mod config;
mod context_discovery;
mod context_rig;
mod emit;
mod escalation;
mod home;
mod hook;
mod identity_resolver;
mod injections;
mod mock_llm;
mod multimodal;
mod oauth_client;
mod progress_monitor;
mod project_instructions;
mod provider_request_sanitizer;
mod runtime_control;
mod runtime_state;
mod runtime_state_json;
mod runtime_tracker;
mod shell_task_reminder;
mod skills;
mod stdio_home;
mod tools;
mod turn_loop;
mod workflows;

use anyhow::{Context, Result};
use tracing::{info_span, Instrument};
use tracing_opentelemetry::OpenTelemetrySpanExt;

#[tokio::main]
async fn main() -> Result<()> {
    // Identity must be loaded before telemetry init so that the OTel `Resource`
    // carries `tenex.agent.pubkey`, `tenex.agent.slug`, and `project.id` on
    // every span — the deleted `tenex.agent.process` wrapper used to hold these
    // as span attributes.
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        anyhow::bail!(
            "Usage: tenex-agent <agent.json>\n\nExample:\n  cargo run -p tenex-agent -- ~/.tenex/agents/<pubkey>.json < event.json"
        );
    }
    let project_id = std::env::var("TENEX_PROJECT_ID")
        .context("TENEX_PROJECT_ID environment variable is required")?;
    let agent_config = config::AgentConfig::load(&args[1])?;
    let agent_keys =
        nostr::Keys::parse(&agent_config.nsec).context("Failed to parse agent nsec")?;
    let pubkey_hex = agent_keys.public_key().to_hex();
    let agent_slug = agent_config.identity_name().to_string();

    let extra_resource = vec![
        opentelemetry::KeyValue::new("service.instance.id", std::process::id().to_string()),
        opentelemetry::KeyValue::new("tenex.agent.pubkey", pubkey_hex.clone()),
        opentelemetry::KeyValue::new("tenex.agent.slug", agent_slug.clone()),
        opentelemetry::KeyValue::new("project.id", project_id.clone()),
    ];
    let telemetry = tenex_telemetry::init(tenex_telemetry::TelemetryInit {
        service_name: "tenex-agent".to_string(),
        base_dir: None,
        kind: tenex_telemetry::TelemetryKind::Subprocess,
        extra_resource,
    });

    // Race the agent's main work against SIGTERM/SIGINT; on signal we still
    // exit through the bounded shutdown sequence below so spans flush.
    let shutdown_signal = async {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let mut sigint = signal(SignalKind::interrupt()).expect("install SIGINT handler");
        tokio::select! {
            _ = sigterm.recv() => (),
            _ = sigint.recv() => (),
        }
    };

    let result = tokio::select! {
        res = run(args, project_id, agent_config, agent_keys, pubkey_hex, agent_slug) => res,
        () = shutdown_signal => {
            eprintln!("[tenex-agent] received shutdown signal");
            Ok(())
        }
    };

    // Bounded shutdown: flush in a blocking thread off the tokio runtime so
    // a wedged exporter cannot stall the runtime drop. 10s ceiling overall.
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::task::spawn_blocking(|| {
            if let Err(err) = tenex_telemetry::force_flush(std::time::Duration::from_secs(5)) {
                eprintln!("[tenex-agent] telemetry flush: {err}");
            }
        }),
    )
    .await;
    telemetry.shutdown();
    result
}

async fn run(
    args: Vec<String>,
    project_id: String,
    agent_config: config::AgentConfig,
    agent_keys: nostr::Keys,
    pubkey_hex: String,
    agent_slug: String,
) -> Result<()> {
    // `tenex.agent.turn` wraps the entire agent process — bootstrap and
    // re-engagement loop both nest under it. The deleted `tenex.agent.process`
    // wrapper used to play this role; we restore the wrap here so bootstrap-
    // time spans (e.g. `rag.context_discovery`) have a proper parent. Each
    // agent spawn is one turn (per OTel design), so the wrapper is bounded by
    // process lifetime and does not regress the multi-hour-wrapper anti-pattern.
    //
    // Late-bound fields are populated after `agent_bootstrap::build` resolves
    // the model and projects history.
    let turn_span = info_span!(
        "tenex.agent.turn",
        llm.provider = tracing::field::Empty,
        llm.model = tracing::field::Empty,
        history.messages = tracing::field::Empty,
    );
    if let Ok(traceparent) = std::env::var("TRACEPARENT") {
        let carrier = tenex_telemetry::TraceCarrier {
            traceparent,
            tracestate: std::env::var("TRACESTATE").ok(),
            baggage: std::env::var("BAGGAGE").ok(),
        };
        if let Some(parent) = tenex_telemetry::extract(&carrier) {
            let _ = turn_span.set_parent(parent);
        }
    }
    async move {
        let mut boot = agent_bootstrap::build(
            &args,
            project_id,
            agent_config,
            agent_keys,
            pubkey_hex,
            agent_slug,
        )
        .await?;
        let span = tracing::Span::current();
        span.record("llm.provider", boot.resolved.provider.as_str());
        span.record("llm.model", boot.resolved.model.as_str());
        turn_loop::run_turn_loop(&mut boot).await
    }
    .instrument(turn_span)
    .await
}
