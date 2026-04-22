use std::path::Path;

use opentelemetry::KeyValue;
use opentelemetry_otlp::{SpanExporter, WithExportConfig};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::{SdkTracerProvider, SimpleSpanProcessor};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, fmt};

const DEFAULT_OTLP_ENDPOINT: &str = "http://localhost:4318";

pub struct TelemetryGuard {
    _file_guard: tracing_appender::non_blocking::WorkerGuard,
    otel_provider: Option<SdkTracerProvider>,
}

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
        if let Some(provider) = self.otel_provider.take() {
            let _ = provider.shutdown();
        }
    }
}

pub fn init(daemon_dir: &Path) -> TelemetryGuard {
    let file_appender = tracing_appender::rolling::never(daemon_dir, "daemon.log");
    let (non_blocking, file_guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = || {
        EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("tenex_daemon=debug,warn"))
    };

    let fmt_layer = fmt::layer()
        .json()
        .with_writer(non_blocking)
        .with_filter(env_filter());

    let otel_provider = build_otel_provider();

    let otel_guard = otel_provider.clone();

    if let Some(ref provider) = otel_provider {
        use opentelemetry::trace::TracerProvider as _;
        let tracer = provider.tracer("tenex-daemon");
        let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
        tracing_subscriber::registry()
            .with(fmt_layer)
            .with(otel_layer)
            .init();
    } else {
        tracing_subscriber::registry()
            .with(fmt_layer)
            .init();
    }

    TelemetryGuard {
        _file_guard: file_guard,
        otel_provider: otel_guard,
    }
}

fn build_otel_provider() -> Option<SdkTracerProvider> {
    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .unwrap_or_else(|_| DEFAULT_OTLP_ENDPOINT.to_string());

    let exporter = match SpanExporter::builder()
        .with_http()
        .with_endpoint(endpoint)
        .build()
    {
        Ok(e) => e,
        Err(error) => {
            eprintln!("tenex-daemon: OTel exporter init failed, tracing disabled: {error}");
            return None;
        }
    };

    let resource = Resource::builder()
        .with_attributes([
            KeyValue::new("service.name", "tenex-daemon"),
            KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
        ])
        .build();

    let provider = SdkTracerProvider::builder()
        .with_span_processor(SimpleSpanProcessor::new(Box::new(exporter)))
        .with_resource(resource)
        .build();

    opentelemetry::global::set_tracer_provider(provider.clone());
    Some(provider)
}
