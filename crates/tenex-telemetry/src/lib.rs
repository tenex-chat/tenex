use std::path::{Path, PathBuf};
use std::time::Duration;

use opentelemetry::trace::TraceContextExt as _;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry::{global, Context, KeyValue};
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use serde_json::Value;
use tracing::Span;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

mod propagation;

const DEFAULT_ENDPOINT: &str = "http://localhost:4318/v1/traces";
const DEFAULT_FILTER: &str = "info,nostr_sdk=warn,nostr_relay_pool=warn";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceCarrier {
    pub traceparent: String,
    pub tracestate: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelemetryConfig {
    pub enabled: bool,
    pub service_name: String,
    pub endpoint: String,
}

impl TelemetryConfig {
    pub fn load(default_service_name: &str, base_dir: Option<&Path>) -> Self {
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

#[derive(Debug)]
pub struct TelemetryGuard {
    provider: Option<SdkTracerProvider>,
}

impl TelemetryGuard {
    pub fn shutdown(self) {
        if let Some(provider) = self.provider {
            if let Err(err) = provider.shutdown() {
                eprintln!("[tenex-telemetry] warning: telemetry shutdown failed: {err}");
            }
        }
    }
}

pub fn init(default_service_name: &str) -> TelemetryGuard {
    init_with_base_dir(default_service_name, None)
}

pub fn init_with_base_dir(default_service_name: &str, base_dir: Option<&Path>) -> TelemetryGuard {
    let config = TelemetryConfig::load(default_service_name, base_dir);
    init_from_config(config)
}

pub fn init_from_config(config: TelemetryConfig) -> TelemetryGuard {
    install_rustls_crypto_provider();

    global::set_text_map_propagator(TraceContextPropagator::new());

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));
    let fmt_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);

    if !config.enabled {
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .init();
        return TelemetryGuard { provider: None };
    }

    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").unwrap_or(config.endpoint);
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_endpoint(endpoint)
        .with_timeout(Duration::from_secs(3))
        .with_protocol(opentelemetry_otlp::Protocol::HttpBinary)
        .build();

    let Ok(exporter) = exporter else {
        eprintln!("[tenex-telemetry] warning: failed to build OTLP exporter; tracing logs only");
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .init();
        return TelemetryGuard { provider: None };
    };

    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(
            Resource::builder()
                .with_attributes([
                    KeyValue::new("service.name", config.service_name),
                    KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
                    KeyValue::new(
                        "deployment.environment",
                        std::env::var("NODE_ENV").unwrap_or_else(|_| "development".to_string()),
                    ),
                ])
                .build(),
        )
        .build();
    global::set_tracer_provider(provider.clone());
    let tracer = provider.tracer("tenex-rust");
    let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt_layer)
        .with(otel_layer)
        .init();

    TelemetryGuard {
        provider: Some(provider),
    }
}

fn install_rustls_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub fn current_traceparent() -> Option<String> {
    current_trace_context().map(|carrier| carrier.traceparent)
}

pub fn current_trace_context() -> Option<TraceCarrier> {
    let ctx = Span::current().context();
    trace_carrier_from_context(&ctx)
}

pub fn trace_carrier_from_context(ctx: &Context) -> Option<TraceCarrier> {
    propagation::trace_carrier_from_context(ctx)
}

pub fn context_from_trace_carrier(carrier: &TraceCarrier) -> Option<Context> {
    propagation::context_from_trace_carrier(carrier)
}

pub fn add_link_to_span(
    span: &Span,
    carrier: &TraceCarrier,
    attributes: Vec<(&'static str, String)>,
) -> bool {
    let Some(ctx) = context_from_trace_carrier(carrier) else {
        return false;
    };
    let span_context = ctx.span().span_context().clone();
    if !span_context.is_valid() {
        return false;
    }
    span.add_link_with_attributes(
        span_context,
        attributes
            .into_iter()
            .map(|(key, value)| KeyValue::new(key, value))
            .collect(),
    );
    true
}

pub fn trace_correlation_id() -> Option<String> {
    let ctx = Span::current().context();
    let span = ctx.span();
    let span_ctx = span.span_context();
    if !span_ctx.is_valid() {
        return None;
    }
    Some(format!(
        "tenex-{}-{}",
        span_ctx.trace_id(),
        span_ctx.span_id()
    ))
}

pub fn parent_context_from_env() -> Option<Context> {
    env_trace_carrier().and_then(|carrier| context_from_trace_carrier(&carrier))
}

pub fn env_trace_carrier() -> Option<TraceCarrier> {
    Some(TraceCarrier {
        traceparent: std::env::var("TRACEPARENT").ok()?,
        tracestate: std::env::var("TRACESTATE").ok(),
    })
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
}
