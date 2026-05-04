//! Embedded HTTP server with a vanilla-JS web UI.
//!
//! Boots an `axum` app on the supplied address. All endpoints under `/api/*`
//! return JSON. The root path serves a single static HTML page that calls those
//! endpoints. No build step — the page is `include_str!`-bundled.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Json, Response},
    routing::get,
    Router,
};
use serde::Deserialize;

use crate::query::{QueryService, TraceFilter};

const INDEX_HTML: &str = include_str!("ui/index.html");
const APP_JS: &str = include_str!("ui/app.js");
const APP_CSS: &str = include_str!("ui/app.css");

#[derive(Clone)]
struct AppState {
    query: Arc<QueryService>,
}

pub async fn serve(addr: SocketAddr, query: QueryService) -> Result<()> {
    let state = AppState {
        query: Arc::new(query),
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/app.css", get(app_css))
        .route("/api/overview", get(overview))
        .route("/api/traces", get(list_traces))
        .route("/api/traces/:trace_id", get(get_trace))
        .route("/api/spans/:span_id/messages", get(span_messages))
        .route("/api/cost/by-provider", get(cost_by_provider))
        .route("/api/cost/by-model", get(cost_by_model))
        .route("/api/cost/by-agent", get(cost_by_agent))
        .route("/api/cost/by-service", get(cost_by_service))
        .route("/api/embeddings/summary", get(embedding_summary))
        .route("/api/llm-calls/recent", get(recent_llm_calls))
        .route("/api/health", get(health))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind {addr}"))?;
    tracing::info!(target: "tenex-accounting", "serving on http://{addr}");
    axum::serve(listener, app)
        .await
        .context("axum serve failed")?;
    Ok(())
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn app_js() -> impl IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "application/javascript")],
        APP_JS,
    )
}

async fn app_css() -> impl IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, "text/css")], APP_CSS)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok": true, "schema_version": crate::schema::SCHEMA_VERSION}))
}

#[derive(Debug, Deserialize)]
struct WindowQuery {
    /// Window size in seconds (e.g. 86400 = 24h). If omitted, since=0 (all time).
    since_secs: Option<i64>,
}

impl WindowQuery {
    fn since_ms(&self) -> Option<i64> {
        self.since_secs.map(|s| crate::schema::now_ms() - s * 1000)
    }
}

async fn overview(
    State(state): State<AppState>,
    Query(w): Query<WindowQuery>,
) -> ApiResult<axum::Json<crate::query::Overview>> {
    Ok(axum::Json(state.query.overview(w.since_ms())?))
}

#[derive(Debug, Deserialize)]
struct TracesQuery {
    since_secs: Option<i64>,
    project_id: Option<String>,
    conversation_id: Option<String>,
    outcome: Option<String>,
    root_kind: Option<String>,
    limit: Option<i64>,
}

async fn list_traces(
    State(state): State<AppState>,
    Query(q): Query<TracesQuery>,
) -> ApiResult<axum::Json<Vec<crate::query::TraceSummary>>> {
    let since_ms = q.since_secs.map(|s| crate::schema::now_ms() - s * 1000);
    let f = TraceFilter {
        since_ms,
        project_id: q.project_id,
        conversation_id: q.conversation_id,
        outcome: q.outcome,
        root_kind: q.root_kind,
        limit: q.limit,
    };
    Ok(axum::Json(state.query.list_traces(f)?))
}

async fn get_trace(
    State(state): State<AppState>,
    Path(trace_id): Path<String>,
) -> ApiResult<axum::Json<crate::query::TraceDetail>> {
    match state.query.get_trace(&trace_id)? {
        Some(t) => Ok(axum::Json(t)),
        None => Err(ApiError::NotFound),
    }
}

async fn span_messages(
    State(state): State<AppState>,
    Path(span_id): Path<String>,
) -> ApiResult<axum::Json<Vec<crate::query::SpanMessage>>> {
    Ok(axum::Json(state.query.span_messages(&span_id)?))
}

async fn cost_by_provider(
    State(state): State<AppState>,
    Query(w): Query<WindowQuery>,
) -> ApiResult<axum::Json<Vec<crate::query::ProviderCostRow>>> {
    Ok(axum::Json(state.query.cost_by_provider(w.since_ms())?))
}

async fn cost_by_model(
    State(state): State<AppState>,
    Query(w): Query<WindowQuery>,
) -> ApiResult<axum::Json<Vec<crate::query::ModelCostRow>>> {
    Ok(axum::Json(state.query.cost_by_model(w.since_ms())?))
}

async fn cost_by_agent(
    State(state): State<AppState>,
    Query(w): Query<WindowQuery>,
) -> ApiResult<axum::Json<Vec<crate::query::AgentCostRow>>> {
    Ok(axum::Json(state.query.cost_by_agent(w.since_ms())?))
}

async fn cost_by_service(
    State(state): State<AppState>,
    Query(w): Query<WindowQuery>,
) -> ApiResult<axum::Json<Vec<crate::query::ServiceCostRow>>> {
    Ok(axum::Json(state.query.cost_by_service(w.since_ms())?))
}

async fn embedding_summary(
    State(state): State<AppState>,
    Query(w): Query<WindowQuery>,
) -> ApiResult<axum::Json<Vec<crate::query::EmbeddingSummaryRow>>> {
    Ok(axum::Json(state.query.embedding_summary(w.since_ms())?))
}

#[derive(Debug, Deserialize)]
struct LimitQuery {
    limit: Option<i64>,
}

async fn recent_llm_calls(
    State(state): State<AppState>,
    Query(q): Query<LimitQuery>,
) -> ApiResult<axum::Json<Vec<crate::query::RecentLlmCall>>> {
    Ok(axum::Json(
        state.query.recent_llm_calls(q.limit.unwrap_or(50))?,
    ))
}

// ---------- error mapping ----------

#[derive(Debug, thiserror::Error)]
enum ApiError {
    #[error("not found")]
    NotFound,
    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

type ApiResult<T> = std::result::Result<T, ApiError>;

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            ApiError::Internal(e) => {
                tracing::warn!(target: "tenex-accounting", "api error: {e:#}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("internal error: {e:#}"),
                )
            }
        };
        (status, Json(serde_json::json!({"error": msg}))).into_response()
    }
}
