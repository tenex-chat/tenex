// TENEX accounting — vanilla JS UI. No build step.
// All views read from /api/*; they re-fetch on window-picker change or refresh.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const fmt = {
  cost(v) {
    if (v == null || isNaN(v)) return "—";
    if (v === 0) return "$0.00";
    if (v < 0.000001) return "<$0.000001";
    if (v < 0.01) return "$" + v.toFixed(6);
    if (v < 1) return "$" + v.toFixed(4);
    return "$" + v.toFixed(2);
  },
  int(v) {
    if (v == null) return "—";
    return Number(v).toLocaleString();
  },
  ms(v) {
    if (v == null) return "—";
    if (v < 1000) return v + " ms";
    return (v / 1000).toFixed(1) + " s";
  },
  ts(ms) {
    if (!ms) return "—";
    return new Date(ms).toLocaleString();
  },
  shortId(id) {
    return id ? id.slice(0, 6) + "…" + id.slice(-4) : "—";
  },
};

function windowSecs() {
  const v = $("#window").value;
  return v ? `since_secs=${v}` : "";
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// Active filter for the Traces view. Set via openTracesForService(); cleared
// when the user clicks the chip or switches away from the Traces tab.
let traceServiceFilter = null;

async function refreshAll() {
  const view = $$(".view.active")[0]?.id?.replace("view-", "") || "pulse";
  switch (view) {
    case "pulse": return loadPulse();
    case "traces": return loadTraces();
    case "cost": return loadCost();
    case "services": return loadServices();
    case "models": return loadModels();
    case "agents": return loadAgents();
    case "embeddings": return loadEmbeddings();
  }
}

// ---- Pulse ----
async function loadPulse() {
  const w = windowSecs();
  const ov = await api("/api/overview" + (w ? "?" + w : ""));
  $("#pulse-cost").textContent = fmt.cost(ov.total_cost_usd);
  $("#pulse-traces").textContent = fmt.int(ov.traces_total);
  $("#pulse-traces-meta").textContent = `(${ov.traces_completed} ok / ${ov.traces_errored} err)`;
  $("#pulse-llm").textContent = fmt.int(ov.llm_calls);
  $("#pulse-emb").textContent = fmt.int(ov.embeddings);
  $("#pulse-tool").textContent = fmt.int(ov.tool_calls);
  // Provider bars
  const max = Math.max(...ov.cost_by_provider.map((p) => p.cost_usd), 0.0000001);
  $("#pulse-providers").innerHTML = ov.cost_by_provider
    .map(
      (p) => `<div class="bar-row">
        <div class="name">${p.provider}</div>
        <div class="bar"><span style="width:${(p.cost_usd / max) * 100}%"></span></div>
        <div class="num cost">${fmt.cost(p.cost_usd)}</div>
        <div class="num muted small">${fmt.int(p.calls)} calls · ${fmt.int(p.input_tokens + p.output_tokens)} tok</div>
      </div>`
    )
    .join("");
  // Recent calls
  const recent = await api("/api/llm-calls/recent?limit=20");
  $("#pulse-recent").innerHTML = `<table>
    <thead><tr>
      <th>when</th><th>agent</th><th>provider</th><th>model</th>
      <th class="num">in</th><th class="num">out</th><th class="num">cost</th>
      <th class="num">latency</th><th>finish</th>
    </tr></thead>
    <tbody>${recent
      .map(
        (r) => `<tr onclick="openTrace('${r.trace_id}')">
        <td>${fmt.ts(r.started_at_ms)}</td>
        <td>${r.agent_slug ?? "—"}</td>
        <td class="provider">${r.provider}</td>
        <td>${r.provider_model_id}</td>
        <td class="num">${fmt.int(r.input_tokens)}</td>
        <td class="num">${fmt.int(r.output_tokens)}</td>
        <td class="num cost">${fmt.cost(r.cost_usd)}</td>
        <td class="num">${fmt.ms(r.duration_ms)}</td>
        <td>${r.finish_reason ?? "—"}</td>
      </tr>`
      )
      .join("")}</tbody></table>`;
}

// ---- Traces ----
async function loadTraces() {
  const params = [];
  const w = $("#window").value;
  if (w) params.push(`since_secs=${w}`);
  if (traceServiceFilter) params.push(`root_kind=${encodeURIComponent(traceServiceFilter)}`);
  const qs = params.length ? "?" + params.join("&") : "";
  const traces = await api("/api/traces" + qs);
  const chip = traceServiceFilter
    ? `<div class="filter-chip">service: <strong>${traceServiceFilter}</strong>
        <a href="javascript:void(0)" onclick="clearTraceFilter()">✕</a></div>`
    : "";
  $("#trace-list").innerHTML =
    chip +
    traces
      .map(
        (t) => `<div class="trace-row" data-trace-id="${t.trace_id}" onclick="openTrace('${t.trace_id}')">
      <div>
        <div><strong>${t.label ?? t.root_kind}</strong></div>
        <div class="meta">${fmt.ts(t.started_at_ms)} · ${t.outcome}</div>
        <div class="meta">${t.total_llm_calls} llm · ${t.total_tool_calls} tool · ${t.total_embeddings} emb</div>
      </div>
      <div class="right">
        <div class="cost">${fmt.cost(t.total_cost_usd)}</div>
        <div class="meta">${fmt.ms(t.wall_duration_ms)}</div>
      </div>
    </div>`
      )
      .join("");
}

window.clearTraceFilter = function () {
  traceServiceFilter = null;
  loadTraces();
};

window.openTracesForService = function (service) {
  traceServiceFilter = service;
  switchView("traces");
  loadTraces();
};

window.openTrace = async function (traceId) {
  // Switch to traces view, mark active.
  switchView("traces");
  await loadTraces();
  $$(".trace-row").forEach((r) => r.classList.toggle("active", r.dataset.traceId === traceId));
  const detail = await api(`/api/traces/${traceId}`);
  renderTraceDetail(detail);
};

function renderTraceDetail(detail) {
  const t = detail.trace;
  // Build span tree: build adjacency from parent_span_id, render top-level (parent==null).
  const spans = detail.spans;
  const byParent = {};
  spans.forEach((s) => {
    const p = s.parent_span_id || "_root";
    (byParent[p] = byParent[p] || []).push(s);
  });
  function renderSpan(s) {
    const kindBadge = `<span class="kind ${s.kind}">${s.kind}</span>`;
    const dur = `<span class="duration">${fmt.ms(s.duration_ms)}</span>`;
    const errCls = s.status === "error" ? "status-error" : "";
    let head = `${kindBadge} `;
    if (s.llm) {
      head += `<span class="model">${s.llm.provider}/${s.llm.provider_model_id}</span> `;
      const cost = s.llm.total_cost_usd_provider ?? s.llm.total_cost_usd_estimated;
      head += `<span class="cost">${fmt.cost(cost)}</span> `;
      head += `<span class="muted small">${fmt.int(s.llm.input_tokens)}→${fmt.int(s.llm.output_tokens)} tok</span> `;
    }
    if (s.tool) {
      head += `<strong>${s.tool.tool_name}</strong> `;
      if (s.tool.was_invalid) head += `<span class="status-error">invalid</span> `;
    }
    if (s.embedding) {
      head += `<strong>${s.embedding.provider}/${s.embedding.model}</strong> `;
      head += `<span class="muted small">${s.embedding.batch_size} item · ${fmt.int(s.embedding.total_input_tokens)} tok</span> `;
      head += `<span class="cost">${fmt.cost(s.embedding.cost_usd)}</span> `;
    }
    head += dur;
    if (errCls) head += ` <span class="${errCls}">${s.error_class ?? "error"}</span>`;
    const children = (byParent[s.span_id] || []).map(renderSpan).join("");
    let body = "";
    if (s.llm) {
      const drift = s.llm.cost_drift_usd;
      body += `<div><span class="muted">finish:</span> ${s.llm.finish_reason ?? "—"} ·
        <span class="muted">ttft:</span> ${fmt.ms(s.llm.ttft_ms)} ·
        <span class="muted">tps:</span> ${s.llm.output_tokens_per_second?.toFixed(1) ?? "—"} ·
        <span class="muted">cache r/w:</span> ${fmt.int(s.llm.cache_read_tokens)}/${fmt.int(s.llm.cache_write_tokens)} ·
        <span class="muted">reasoning:</span> ${fmt.int(s.llm.reasoning_tokens)}
      </div>`;
      if (drift != null && Math.abs(drift) > 0.0000001) {
        body += `<div class="muted small">cost drift (provider − estimated): ${fmt.cost(drift)}</div>`;
      }
      if (s.llm.shadow_cost_usd != null) {
        body += `<div class="muted small">shadow cost (would have paid ${s.llm.shadow_cost_reference_model}): ${fmt.cost(s.llm.shadow_cost_usd)}</div>`;
      }
      if (s.llm.openrouter_generation_id) {
        body += `<div class="muted small">openrouter gen: <code>${s.llm.openrouter_generation_id}</code></div>`;
      }
      body += `<div><a href="javascript:void(0)" onclick="loadMessages('${s.span_id}', this)">load messages</a></div>`;
    }
    if (s.tool) {
      if (s.tool.args_preview) body += `<details><summary>args</summary><pre>${escapeHtml(s.tool.args_preview)}</pre></details>`;
      if (s.tool.result_preview) body += `<details><summary>result</summary><pre>${escapeHtml(s.tool.result_preview)}</pre></details>`;
    }
    return `<details open><summary><span class="span-meta">${head}</span></summary>
      <div class="span-body">${body}${children}</div>
    </details>`;
  }
  const tree = (byParent["_root"] || []).map(renderSpan).join("");
  $("#trace-detail").innerHTML = `
    <h2 style="margin-top:0">${t.label ?? t.root_kind}</h2>
    <div class="grid">
      <div class="card big-number"><div class="label">total cost</div><div class="value">${fmt.cost(t.total_cost_usd)}</div></div>
      <div class="card big-number"><div class="label">duration</div><div class="value">${fmt.ms(t.wall_duration_ms)}</div></div>
      <div class="card big-number"><div class="label">tokens in/out</div><div class="value">${fmt.int(t.total_input_tokens)} / ${fmt.int(t.total_output_tokens)}</div></div>
      <div class="card big-number"><div class="label">spans</div><div class="value">${t.total_llm_calls + t.total_tool_calls + t.total_embeddings}</div></div>
    </div>
    <div class="span-tree">${tree || '<div class="placeholder">No spans recorded.</div>'}</div>
  `;
}

window.loadMessages = async function (spanId, link) {
  const msgs = await api(`/api/spans/${spanId}/messages`);
  const html = msgs
    .map(
      (m) => `<details><summary><strong>${m.role}</strong> <span class="muted small">${m.classification ?? ""} · ~${m.tokens_estimated ?? "?"} tok</span></summary>
    <pre>${escapeHtml(m.content_full ?? m.content_preview ?? "")}</pre></details>`
    )
    .join("");
  link.outerHTML = html || "<div class='muted small'>no messages recorded</div>";
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"})[c]);
}

// ---- Cost ----
async function loadCost() {
  const w = windowSecs();
  const [byP, byM, byA] = await Promise.all([
    api("/api/cost/by-provider" + (w ? "?" + w : "")),
    api("/api/cost/by-model" + (w ? "?" + w : "")),
    api("/api/cost/by-agent" + (w ? "?" + w : "")),
  ]);
  $("#cost-by-provider").innerHTML = `<table>
    <thead><tr><th>provider</th><th class="num">calls</th><th class="num">in tok</th><th class="num">out tok</th><th class="num">cache r</th><th class="num">cache w</th><th class="num">cost</th><th class="num">est</th><th class="num">shadow</th></tr></thead>
    <tbody>${byP.map((p) => `<tr>
      <td class="provider">${p.provider}</td>
      <td class="num">${fmt.int(p.calls)}</td>
      <td class="num">${fmt.int(p.input_tokens)}</td>
      <td class="num">${fmt.int(p.output_tokens)}</td>
      <td class="num">${fmt.int(p.cache_read_tokens)}</td>
      <td class="num">${fmt.int(p.cache_write_tokens)}</td>
      <td class="num cost">${fmt.cost(p.cost_usd)}</td>
      <td class="num">${fmt.cost(p.cost_estimated_usd)}</td>
      <td class="num">${p.shadow_cost_usd > 0 ? fmt.cost(p.shadow_cost_usd) : "—"}</td>
    </tr>`).join("")}</tbody></table>`;
  $("#cost-by-model").innerHTML = `<table>
    <thead><tr><th>provider</th><th>model</th><th class="num">calls</th><th class="num">in</th><th class="num">out</th><th class="num">cache r</th><th class="num">cost</th><th class="num">avg latency</th><th class="num">avg tps</th><th class="num">avg ttft</th></tr></thead>
    <tbody>${byM.map((m) => `<tr>
      <td class="provider">${m.provider}</td><td>${m.provider_model_id}</td>
      <td class="num">${fmt.int(m.calls)}</td>
      <td class="num">${fmt.int(m.input_tokens)}</td>
      <td class="num">${fmt.int(m.output_tokens)}</td>
      <td class="num">${fmt.int(m.cache_read_tokens)}</td>
      <td class="num cost">${fmt.cost(m.cost_usd)}</td>
      <td class="num">${m.avg_latency_ms?.toFixed(0) ?? "—"} ms</td>
      <td class="num">${m.avg_output_tps?.toFixed(1) ?? "—"}</td>
      <td class="num">${m.avg_ttft_ms?.toFixed(0) ?? "—"} ms</td>
    </tr>`).join("")}</tbody></table>`;
  $("#cost-by-agent").innerHTML = `<table>
    <thead><tr><th>agent</th><th class="num">calls</th><th class="num">in</th><th class="num">out</th><th class="num">cost</th></tr></thead>
    <tbody>${byA.map((a) => `<tr>
      <td>${a.agent}</td>
      <td class="num">${fmt.int(a.calls)}</td>
      <td class="num">${fmt.int(a.input_tokens)}</td>
      <td class="num">${fmt.int(a.output_tokens)}</td>
      <td class="num cost">${fmt.cost(a.cost_usd)}</td>
    </tr>`).join("")}</tbody></table>`;
}

async function loadServices() {
  const w = windowSecs();
  const rows = await api("/api/cost/by-service" + (w ? "?" + w : ""));
  const total = rows.reduce((s, r) => s + r.cost_usd, 0) || 0.0000001;
  $("#services-table").innerHTML = `<table>
    <thead><tr>
      <th>service</th>
      <th class="num">traces</th>
      <th class="num">llm</th>
      <th class="num">tool</th>
      <th class="num">emb</th>
      <th class="num">in tok</th>
      <th class="num">out tok</th>
      <th class="num">cache r</th>
      <th class="num">cost</th>
      <th class="num">% of total</th>
      <th class="num">avg dur</th>
      <th class="num">err</th>
    </tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr class="clickable" onclick="openTracesForService('${r.service}')">
        <td><strong>${r.service}</strong></td>
        <td class="num">${fmt.int(r.traces)}</td>
        <td class="num">${fmt.int(r.llm_calls)}</td>
        <td class="num">${fmt.int(r.tool_calls)}</td>
        <td class="num">${fmt.int(r.embeddings)}</td>
        <td class="num">${fmt.int(r.input_tokens)}</td>
        <td class="num">${fmt.int(r.output_tokens)}</td>
        <td class="num">${fmt.int(r.cache_read_tokens)}</td>
        <td class="num cost">${fmt.cost(r.cost_usd)}</td>
        <td class="num">${((r.cost_usd / total) * 100).toFixed(1)}%</td>
        <td class="num">${r.avg_duration_ms != null ? fmt.ms(Math.round(r.avg_duration_ms)) : "—"}</td>
        <td class="num">${r.errored > 0 ? `<span class="status-error">${fmt.int(r.errored)}</span>` : "0"}</td>
      </tr>`
      )
      .join("")}</tbody></table>`;
}

async function loadModels() {
  const w = windowSecs();
  const rows = await api("/api/cost/by-model" + (w ? "?" + w : ""));
  $("#models-table").innerHTML = `<table>
    <thead><tr><th>provider</th><th>model</th><th>family</th><th class="num">calls</th><th class="num">in</th><th class="num">out</th><th class="num">cost</th><th class="num">avg latency</th><th class="num">avg tps</th><th class="num">avg ttft</th></tr></thead>
    <tbody>${rows.map((m) => `<tr>
      <td class="provider">${m.provider}</td><td>${m.provider_model_id}</td><td>${m.model_family ?? "—"}</td>
      <td class="num">${fmt.int(m.calls)}</td>
      <td class="num">${fmt.int(m.input_tokens)}</td>
      <td class="num">${fmt.int(m.output_tokens)}</td>
      <td class="num cost">${fmt.cost(m.cost_usd)}</td>
      <td class="num">${m.avg_latency_ms?.toFixed(0) ?? "—"} ms</td>
      <td class="num">${m.avg_output_tps?.toFixed(1) ?? "—"}</td>
      <td class="num">${m.avg_ttft_ms?.toFixed(0) ?? "—"} ms</td>
    </tr>`).join("")}</tbody></table>`;
}

async function loadAgents() {
  const w = windowSecs();
  const rows = await api("/api/cost/by-agent" + (w ? "?" + w : ""));
  $("#agents-table").innerHTML = `<table>
    <thead><tr><th>agent</th><th>pubkey</th><th class="num">calls</th><th class="num">in</th><th class="num">out</th><th class="num">cost</th></tr></thead>
    <tbody>${rows.map((a) => `<tr>
      <td>${a.agent}</td>
      <td class="muted small">${a.agent_pubkey ? fmt.shortId(a.agent_pubkey) : "—"}</td>
      <td class="num">${fmt.int(a.calls)}</td>
      <td class="num">${fmt.int(a.input_tokens)}</td>
      <td class="num">${fmt.int(a.output_tokens)}</td>
      <td class="num cost">${fmt.cost(a.cost_usd)}</td>
    </tr>`).join("")}</tbody></table>`;
}

async function loadEmbeddings() {
  const w = windowSecs();
  const rows = await api("/api/embeddings/summary" + (w ? "?" + w : ""));
  $("#embeddings-table").innerHTML = `<table>
    <thead><tr><th>provider</th><th>model</th><th class="num">spans</th><th class="num">items</th><th class="num">tokens</th><th class="num">cost</th><th class="num">avg tps</th></tr></thead>
    <tbody>${rows.map((e) => `<tr>
      <td class="provider">${e.provider}</td><td>${e.model}</td>
      <td class="num">${fmt.int(e.spans)}</td>
      <td class="num">${fmt.int(e.items)}</td>
      <td class="num">${fmt.int(e.tokens)}</td>
      <td class="num cost">${fmt.cost(e.cost_usd)}</td>
      <td class="num">${e.avg_throughput?.toFixed(1) ?? "—"}</td>
    </tr>`).join("")}</tbody></table>`;
}

function switchView(name) {
  if (name !== "traces") traceServiceFilter = null;
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
}

// ---- bootstrap ----
document.addEventListener("DOMContentLoaded", () => {
  $$("nav button").forEach((b) => {
    b.addEventListener("click", () => {
      switchView(b.dataset.view);
      refreshAll();
    });
  });
  $("#window").addEventListener("change", refreshAll);
  $("#refresh").addEventListener("click", refreshAll);
  fetch("/api/health").then((r) => r.json()).then((h) => {
    $("#db-path").textContent = `schema v${h.schema_version}`;
  });
  refreshAll();
});
