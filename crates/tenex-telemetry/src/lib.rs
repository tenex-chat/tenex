//! Telemetry initialisation and W3C trace-context propagation for the TENEX
//! Rust workspace.
//!
//! Every TENEX binary calls [`init`] exactly once at startup, passing a
//! [`TelemetryInit`] that selects the appropriate flavour ([`TelemetryKind`]):
//!
//! * [`TelemetryKind::Daemon`] — long-running supervisor; stderr-only `warn`
//!   logs, no OTLP export (the human-facing display module owns stdout).
//! * [`TelemetryKind::Subprocess`] — short-lived child process spawned per
//!   inbound event; OTLP/HTTP exporter, connection-per-batch, exits cleanly.
//! * [`TelemetryKind::Cli`] — one-shot CLI commands; mirrors `Subprocess` with
//!   stderr-friendly compact log formatting.
//!
//! The W3C composite propagator (trace-context + baggage) is installed
//! globally so that `inject_current` / `extract` round-trip both `traceparent`
//! /`tracestate` and `baggage` headers verbatim. The accompanying
//! [`baggage_processor::BaggageSpanProcessor`] copies baggage entries onto
//! every span at start, so back-end tag-search (`conversation.id`, …) works
//! without per-span boilerplate.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use opentelemetry::propagation::TextMapCompositePropagator;
use opentelemetry::trace::{Status, TracerProvider as _};
use opentelemetry::{global, KeyValue};
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::propagation::{BaggagePropagator, TraceContextPropagator};
use opentelemetry_sdk::trace::{BatchConfigBuilder, BatchSpanProcessor, SdkTracerProvider};
use opentelemetry_sdk::Resource;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::Span;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

mod baggage_processor;
mod propagation;

pub use baggage_processor::BaggageSpanProcessor;

const DEFAULT_ENDPOINT: &str = "http://localhost:4318/v1/traces";
const DEFAULT_FILTER: &str = "info,nostr_sdk=warn,nostr_relay_pool=warn";
const DEFAULT_EXPORT_TIMEOUT: Duration = Duration::from_secs(5);
const BATCH_MAX_QUEUE_SIZE: usize = 2_048;
const BATCH_SCHEDULED_DELAY: Duration = Duration::from_secs(2);
const BATCH_MAX_EXPORT_BATCH_SIZE: usize = 512;

/// Process-wide handle to the SDK tracer provider, set by [`init`] when an
/// OTLP exporter is installed. [`force_flush`] reads this without requiring
/// the caller to thread the guard through.
static PROVIDER: OnceLock<SdkTracerProvider> = OnceLock::new();

/// W3C trace-context carrier moved across process boundaries via env vars,
/// stdin envelopes, or persisted state.
///
/// The struct serialises as JSON for IPC payloads (`{"traceparent": …}`) and
/// extracts/injects via [`propagation::inject_current`] /
/// [`propagation::extract`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TraceCarrier {
    pub traceparent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracestate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baggage: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TelemetryConfig {
    pub enabled: bool,
    pub service_name: String,
    pub endpoint: String,
}

impl TelemetryConfig {
    pub(crate) fn load(default_service_name: &str, base_dir: Option<&Path>) -> Self {
        let defaults = Self {
            enabled: true,
            service_name: default_service_name.to_string(),
            endpoint: DEFAULT_ENDPOINT.to_string(),
        };
        let config_path = base_dir
            .map(Path::to_path_buf)
            .unwrap_or_else(default_base_dir)
            .join("config.json");

        let Ok(raw) = std::fs::read_to_string(&config_path) else {
            return defaults;
        };
        let Ok(json) = serde_json::from_str::<Value>(&raw) else {
            eprintln!(
                "[tenex-telemetry] warning: failed to parse {}",
                config_path.display()
            );
            return defaults;
        };

        let telemetry = json.get("telemetry").and_then(Value::as_object);
        Self {
            enabled: telemetry
                .and_then(|t| t.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(defaults.enabled),
            service_name: telemetry
                .and_then(|t| t.get("serviceName"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(default_service_name)
                .to_string(),
            endpoint: telemetry
                .and_then(|t| t.get("endpoint"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(DEFAULT_ENDPOINT)
                .to_string(),
        }
    }
}

/// Selects the telemetry shape appropriate for a given binary lifecycle.
///
/// See the module-level documentation for the differences between variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TelemetryKind {
    /// Long-running daemon process — stderr-only logs, no OTLP exporter.
    Daemon,
    /// Short-lived child process — OTLP/HTTP exporter, connection-per-batch.
    Subprocess,
    /// One-shot CLI command — OTLP/HTTP exporter with compact stderr logs.
    Cli,
}

/// Inputs to [`init`]. `extra_resource` augments the OTel `Resource` with
/// process-identity attributes (e.g. `tenex.agent.pubkey`, `project.id`).
#[derive(Debug)]
pub struct TelemetryInit {
    pub service_name: String,
    pub base_dir: Option<PathBuf>,
    pub kind: TelemetryKind,
    pub extra_resource: Vec<KeyValue>,
}

/// RAII handle returned by [`init`]. Drop or call [`TelemetryGuard::shutdown`]
/// at the end of `main` to flush any buffered spans before exit.
#[derive(Debug)]
pub struct TelemetryGuard {
    provider: Option<SdkTracerProvider>,
}

impl TelemetryGuard {
    /// Synchronously shut the tracer provider down. Idempotent.
    pub fn shutdown(self) {
        if let Some(provider) = self.provider {
            if let Err(err) = provider.shutdown() {
                eprintln!("[tenex-telemetry] warning: telemetry shutdown failed: {err}");
            }
        }
    }

    /// Borrow the underlying tracer provider for an externally driven flush
    /// (see [`force_flush`]).
    pub fn provider(&self) -> Option<&SdkTracerProvider> {
        self.provider.as_ref()
    }
}

/// Initialise tracing + OpenTelemetry for the current process.
///
/// Must be called exactly once. Returns a [`TelemetryGuard`] that drives
/// shutdown / flush on `main` exit.
pub fn init(cfg: TelemetryInit) -> TelemetryGuard {
    install_rustls_crypto_provider();
    install_global_propagator();

    match cfg.kind {
        TelemetryKind::Daemon => init_daemon_inner(),
        TelemetryKind::Subprocess => init_export_inner(cfg, FmtStyle::Verbose),
        TelemetryKind::Cli => init_export_inner(cfg, FmtStyle::Compact),
    }
}

#[derive(Clone, Copy)]
enum FmtStyle {
    Verbose,
    Compact,
}

fn init_daemon_inner() -> TelemetryGuard {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    let fmt_layer = tracing_subscriber::fmt::layer()
        .compact()
        .without_time()
        .with_target(false)
        .with_writer(std::io::stderr);

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt_layer)
        .init();

    TelemetryGuard { provider: None }
}

fn init_export_inner(cfg: TelemetryInit, style: FmtStyle) -> TelemetryGuard {
    let TelemetryInit {
        service_name,
        base_dir,
        kind: _,
        extra_resource,
    } = cfg;

    let config = TelemetryConfig::load(&service_name, base_dir.as_deref());

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));

    if !config.enabled {
        install_fmt_only(filter, style);
        return TelemetryGuard { provider: None };
    }

    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").unwrap_or(config.endpoint);
    let export_timeout =
        parse_duration_env("OTEL_EXPORTER_OTLP_TIMEOUT").unwrap_or(DEFAULT_EXPORT_TIMEOUT);
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_endpoint(endpoint)
        .with_timeout(export_timeout)
        .with_protocol(opentelemetry_otlp::Protocol::HttpBinary)
        .build();

    let Ok(exporter) = exporter else {
        eprintln!("[tenex-telemetry] warning: failed to build OTLP exporter; tracing logs only");
        install_fmt_only(filter, style);
        return TelemetryGuard { provider: None };
    };

    let batch_config = BatchConfigBuilder::default()
        .with_max_queue_size(BATCH_MAX_QUEUE_SIZE)
        .with_scheduled_delay(BATCH_SCHEDULED_DELAY)
        .with_max_export_batch_size(BATCH_MAX_EXPORT_BATCH_SIZE)
        .build();
    let batch_processor = BatchSpanProcessor::builder(exporter)
        .with_batch_config(batch_config)
        .build();

    let mut resource_attributes = vec![
        KeyValue::new("service.name", config.service_name),
        KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
        KeyValue::new(
            "deployment.environment",
            std::env::var("NODE_ENV").unwrap_or_else(|_| "development".to_string()),
        ),
    ];
    resource_attributes.extend(extra_resource);
    let resource = Resource::builder()
        .with_attributes(resource_attributes)
        .build();

    let provider = SdkTracerProvider::builder()
        .with_resource(resource)
        .with_span_processor(BaggageSpanProcessor::new())
        .with_span_processor(batch_processor)
        .build();
    global::set_tracer_provider(provider.clone());
    let _ = PROVIDER.set(provider.clone());
    let tracer = provider.tracer("tenex-rust");
    let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);

    match style {
        FmtStyle::Verbose => {
            let fmt_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);
            tracing_subscriber::registry()
                .with(filter)
                .with(otel_layer)
                .with(fmt_layer)
                .init();
        }
        FmtStyle::Compact => {
            let fmt_layer = tracing_subscriber::fmt::layer()
                .compact()
                .with_target(false)
                .with_writer(std::io::stderr);
            tracing_subscriber::registry()
                .with(filter)
                .with(otel_layer)
                .with(fmt_layer)
                .init();
        }
    }

    TelemetryGuard {
        provider: Some(provider),
    }
}

fn install_fmt_only(filter: EnvFilter, style: FmtStyle) {
    match style {
        FmtStyle::Verbose => {
            let fmt_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);
            tracing_subscriber::registry()
                .with(filter)
                .with(fmt_layer)
                .init();
        }
        FmtStyle::Compact => {
            let fmt_layer = tracing_subscriber::fmt::layer()
                .compact()
                .with_target(false)
                .with_writer(std::io::stderr);
            tracing_subscriber::registry()
                .with(filter)
                .with(fmt_layer)
                .init();
        }
    }
}

fn install_global_propagator() {
    let propagator = TextMapCompositePropagator::new(vec![
        Box::new(TraceContextPropagator::new()),
        Box::new(BaggagePropagator::new()),
    ]);
    global::set_text_map_propagator(propagator);
}

fn install_rustls_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn parse_duration_env(name: &str) -> Option<Duration> {
    let raw = std::env::var(name).ok()?;
    let trimmed = raw.trim();
    let (number, unit_secs): (&str, u64) = if let Some(rest) = trimmed.strip_suffix("ms") {
        (rest, 0)
    } else if let Some(rest) = trimmed.strip_suffix('s') {
        (rest, 1_000)
    } else {
        (trimmed, 1_000)
    };
    let n: u64 = number.trim().parse().ok()?;
    if unit_secs == 0 {
        Some(Duration::from_millis(n))
    } else {
        Some(Duration::from_millis(n.saturating_mul(unit_secs)))
    }
}

/// Capture the current span's W3C trace context (and baggage, if any) into a
/// portable [`TraceCarrier`]. Returns `None` when no recording span is active.
pub fn inject_current() -> Option<TraceCarrier> {
    propagation::inject_current()
}

/// Re-hydrate an [`opentelemetry::Context`] from a [`TraceCarrier`]. Returns
/// `None` when the carrier holds an invalid `traceparent`.
pub fn extract(carrier: &TraceCarrier) -> Option<opentelemetry::Context> {
    propagation::extract(carrier)
}

/// Bounded `force_flush` that runs on a blocking OS thread so the calling
/// tokio runtime can be torn down without deadlocking the OTel batch worker.
/// Returns within `timeout`, even if the batch processor itself is wedged
/// (in which case the result is `Err` and any unflushed spans are lost).
///
/// No-op when telemetry was initialised in a kind that does not export
/// (e.g. [`TelemetryKind::Daemon`]).
pub fn force_flush(timeout: Duration) -> anyhow::Result<()> {
    let Some(provider) = PROVIDER.get().cloned() else {
        return Ok(());
    };
    let join = std::thread::Builder::new()
        .name("tenex-telemetry-flush".to_string())
        .spawn(move || provider.force_flush())
        .map_err(|e| anyhow::anyhow!("failed to spawn flush thread: {e}"))?;

    let deadline = std::time::Instant::now() + timeout;
    loop {
        if join.is_finished() {
            return match join.join() {
                Ok(Ok(())) => Ok(()),
                Ok(Err(err)) => Err(anyhow::anyhow!("force_flush failed: {err}")),
                Err(_) => Err(anyhow::anyhow!("force_flush thread panicked")),
            };
        }
        if std::time::Instant::now() >= deadline {
            return Err(anyhow::anyhow!(
                "force_flush exceeded {timeout:?}; spans may be lost"
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Mark the current span as failed and attach an `exception` event with the
/// formatted error message. Use at the boundary where errors propagate out of
/// instrumented code.
pub fn record_current_error<E: std::fmt::Display>(err: &E) {
    let span = Span::current();
    let message = err.to_string();
    span.set_status(Status::error(message.clone()));
    span.add_event(
        "exception",
        vec![
            KeyValue::new("exception.type", std::any::type_name::<E>().to_string()),
            KeyValue::new("exception.message", message),
        ],
    );
}

fn default_base_dir() -> PathBuf {
    if let Ok(base) = std::env::var("TENEX_BASE_DIR") {
        return PathBuf::from(base);
    }
    dirs_next::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".tenex")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_config_uses_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let config = TelemetryConfig::load("svc", Some(dir.path()));
        assert_eq!(
            config,
            TelemetryConfig {
                enabled: true,
                service_name: "svc".to_string(),
                endpoint: DEFAULT_ENDPOINT.to_string(),
            }
        );
    }

    #[test]
    fn trace_carrier_serde_skips_none_fields() {
        let carrier = TraceCarrier {
            traceparent: "00-aa-bb-01".to_string(),
            tracestate: None,
            baggage: None,
        };
        let json = serde_json::to_string(&carrier).unwrap();
        assert_eq!(json, r#"{"traceparent":"00-aa-bb-01"}"#);
        let round: TraceCarrier = serde_json::from_str(&json).unwrap();
        assert_eq!(round, carrier);
    }
}
