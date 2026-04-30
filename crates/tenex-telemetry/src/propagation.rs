use std::collections::HashMap;

use opentelemetry::propagation::{Extractor, Injector};
use opentelemetry::trace::TraceContextExt as _;
use opentelemetry::{global, Context};

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
    Some(TraceCarrier {
        traceparent,
        tracestate,
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
