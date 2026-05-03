//! Span processor that materialises every entry in the active
//! [`opentelemetry::baggage::Baggage`] as a span attribute at start time.
//!
//! Why this exists: backends like Jaeger only expose tag-search over span
//! attributes, not baggage. Setting `conversation.id` once on the root
//! context's baggage then auto-propagating it onto every descendant span via
//! this processor lets operators search `conversation.id="<hex>"` across an
//! entire trace family without touching every `info_span!` in the codebase.

use std::time::Duration;

use opentelemetry::baggage::BaggageExt;
use opentelemetry::trace::Span as _;
use opentelemetry::{Context, KeyValue};
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::trace::{Span, SpanData, SpanProcessor};

/// Copies baggage entries onto each starting span as attributes. Intended to
/// run alongside (and *before*, in registration order) a
/// [`opentelemetry_sdk::trace::BatchSpanProcessor`].
#[derive(Debug, Default)]
pub struct BaggageSpanProcessor;

impl BaggageSpanProcessor {
    /// Construct a new processor. The SDK clones the
    /// [`opentelemetry_sdk::Resource`] in via `set_resource`; we don't need
    /// per-instance state.
    pub fn new() -> Self {
        Self
    }
}

impl SpanProcessor for BaggageSpanProcessor {
    fn on_start(&self, span: &mut Span, cx: &Context) {
        let baggage = cx.baggage();
        if baggage.is_empty() {
            return;
        }
        for (key, (value, _metadata)) in baggage.iter() {
            span.set_attribute(KeyValue::new(key.clone(), value.as_str().to_string()));
        }
    }

    fn on_end(&self, _span: SpanData) {}

    fn force_flush(&self) -> OTelSdkResult {
        Ok(())
    }

    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        Ok(())
    }
}
