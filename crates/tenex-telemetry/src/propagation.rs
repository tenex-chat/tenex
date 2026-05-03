//! W3C trace-context + baggage propagation helpers.
//!
//! These funnel through the global composite [`TextMapPropagator`] installed
//! by [`crate::init`] so the on-the-wire format is always the canonical
//! `traceparent` / `tracestate` / `baggage` triple.

use std::collections::HashMap;

use opentelemetry::baggage::BaggageExt;
use opentelemetry::propagation::{Extractor, Injector};
use opentelemetry::trace::TraceContextExt as _;
use opentelemetry::{global, Context, KeyValue};
use tracing::Span;
use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::TraceCarrier;

#[derive(Default)]
struct MapInjector {
    values: HashMap<String, String>,
}

impl Injector for MapInjector {
    fn set(&mut self, key: &str, value: String) {
        self.values.insert(key.to_ascii_lowercase(), value);
    }
}

struct MapExtractor {
    values: HashMap<String, String>,
}

impl MapExtractor {
    fn from_carrier(carrier: &TraceCarrier) -> Self {
        let mut values = HashMap::new();
        values.insert("traceparent".to_string(), carrier.traceparent.clone());
        if let Some(tracestate) = carrier.tracestate.clone() {
            values.insert("tracestate".to_string(), tracestate);
        }
        if let Some(baggage) = carrier.baggage.clone() {
            values.insert("baggage".to_string(), baggage);
        }
        Self { values }
    }
}

impl Extractor for MapExtractor {
    fn get(&self, key: &str) -> Option<&str> {
        self.values
            .get(&key.to_ascii_lowercase())
            .map(String::as_str)
    }

    fn keys(&self) -> Vec<&str> {
        self.values.keys().map(String::as_str).collect()
    }
}

pub(super) fn inject_current() -> Option<TraceCarrier> {
    let live = Context::current();
    if live.span().span_context().is_valid() {
        return trace_carrier_from_context(&live);
    }
    let span_ctx = Span::current().context();
    let live_baggage = live.baggage();
    let merged = if live_baggage.is_empty() {
        span_ctx
    } else {
        let kvs: Vec<KeyValue> = live_baggage
            .iter()
            .map(|(k, (v, _))| KeyValue::new(k.clone(), v.clone()))
            .collect();
        span_ctx.with_baggage(kvs)
    };
    trace_carrier_from_context(&merged)
}

pub(super) fn extract(carrier: &TraceCarrier) -> Option<Context> {
    context_from_trace_carrier(carrier)
}

pub(crate) fn trace_carrier_from_context(ctx: &Context) -> Option<TraceCarrier> {
    let span = ctx.span();
    let span_ctx = span.span_context();
    if !span_ctx.is_valid() {
        return None;
    }

    let mut injector = MapInjector::default();
    global::get_text_map_propagator(|propagator| propagator.inject_context(ctx, &mut injector));
    let traceparent = injector.values.remove("traceparent")?;
    let tracestate = injector.values.remove("tracestate");
    let baggage = injector.values.remove("baggage");
    Some(TraceCarrier {
        traceparent,
        tracestate,
        baggage,
    })
}

pub(crate) fn context_from_trace_carrier(carrier: &TraceCarrier) -> Option<Context> {
    let extractor = MapExtractor::from_carrier(carrier);
    let ctx = global::get_text_map_propagator(|propagator| propagator.extract(&extractor));
    if ctx.span().span_context().is_valid() {
        Some(ctx)
    } else {
        None
    }
}
