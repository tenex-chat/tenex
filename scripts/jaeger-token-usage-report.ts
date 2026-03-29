#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type JaegerField = {
    key: string;
    type?: string;
    value?: unknown;
};

type JaegerLog = {
    timestamp?: number;
    fields?: JaegerField[];
};

type JaegerSpan = {
    traceID: string;
    spanID: string;
    operationName: string;
    startTime: number;
    duration: number;
    processID?: string;
    tags?: JaegerField[];
    logs?: JaegerLog[];
};

type JaegerProcess = {
    serviceName?: string;
};

type JaegerTrace = {
    traceID: string;
    spans?: JaegerSpan[];
    processes?: Record<string, JaegerProcess>;
};

type JaegerResponse = {
    data?: JaegerTrace[];
};

type UsageSpan = {
    agent: string;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cachedInputTokens: number;
    dayKey: string;
    dayLabel: string;
    durationMs: number;
    errorMessage: string;
    functionId: string;
    inputTokens: number;
    model: string;
    noCacheTokens: number;
    outputTokens: number;
    provider: string;
    providerRaw: string;
    rateLimit: boolean;
    service: string;
    spanId: string;
    status: string;
    success: boolean;
    timestampLabel: string;
    timestampUs: number;
    totalTokens: number;
    traceId: string;
    traceUrl: string;
    usageMissing: boolean;
};

type ProviderSummary = {
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cachedInputTokens: number;
    inputTokens: number;
    models: Map<string, number>;
    noCacheTokens: number;
    outputTokens: number;
    providersRaw: Set<string>;
    rateLimitErrors: number;
    requests: number;
    services: Set<string>;
    successfulRequests: number;
    usageMissing: number;
};

type ModelSummary = {
    inputTokens: number;
    outputTokens: number;
    provider: string;
    rateLimitErrors: number;
    requests: number;
};

type AgentSummary = {
    inputTokens: number;
    provider: string;
    rateLimitErrors: number;
    requests: number;
};

type ServiceSummary = {
    inputTokens: number;
    outputTokens: number;
    providers: Set<string>;
    rateLimitErrors: number;
    requests: number;
};

const DEFAULT_JAEGER_URL = "http://23.88.91.234:16686";
const OPERATION_NAME = "ai.streamText.doStream";
const DEFAULT_DAYS = 4;
const DEFAULT_QUERY_LIMIT = 10;
const BASE_WINDOW_US = 2 * 60 * 60 * 1_000_000;
const MIN_WINDOW_US = 5 * 60 * 1_000_000;
const WINDOW_SPLIT_PADDING_US = 1;
const TIME_ZONE = "Europe/Athens";
const PROVIDER_COLORS = [
    "#c1121f",
    "#1d3557",
    "#2a9d8f",
    "#f4a261",
    "#6d597a",
    "#588157",
    "#bc6c25",
    "#457b9d",
];

type ParsedArgs = {
    days: number;
    jaegerUrl: string;
    jsonOut: string;
    out: string;
    queryLimit: number;
    uiUrl: string;
};

function usage(): string {
    return [
        "Usage: bun scripts/jaeger-token-usage-report.ts [options]",
        "",
        "Fetch doStream spans from Jaeger via curl, aggregate token usage, and render an HTML report.",
        "",
        "Options:",
        `  --jaeger-url <url>  Jaeger query base URL (default: ${DEFAULT_JAEGER_URL})`,
        "  --ui-url <url>      Jaeger UI base URL for trace links (default: same as --jaeger-url)",
        `  --days <n>          Look back N days from now (default: ${DEFAULT_DAYS})`,
        `  --limit <n>         Per-query trace limit before recursive splitting (default: ${DEFAULT_QUERY_LIMIT})`,
        "  --out <path>        Output HTML path (default: dist/jaeger-token-usage-report.html)",
        "  --json-out <path>   Output JSON path (default: dist/jaeger-token-usage-report.json)",
        "  -h, --help          Show this help",
    ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
    const parsed: ParsedArgs = {
        days: DEFAULT_DAYS,
        jaegerUrl: DEFAULT_JAEGER_URL,
        jsonOut: resolve(process.cwd(), "dist", "jaeger-token-usage-report.json"),
        out: resolve(process.cwd(), "dist", "jaeger-token-usage-report.html"),
        queryLimit: DEFAULT_QUERY_LIMIT,
        uiUrl: DEFAULT_JAEGER_URL,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === "-h" || arg === "--help") {
            console.log(usage());
            process.exit(0);
        }

        if (
            arg === "--jaeger-url" ||
            arg === "--ui-url" ||
            arg === "--days" ||
            arg === "--limit" ||
            arg === "--out" ||
            arg === "--json-out"
        ) {
            const value = argv[index + 1];
            if (!value) {
                throw new Error(`Missing value for ${arg}`);
            }

            if (arg === "--jaeger-url") {
                parsed.jaegerUrl = value.replace(/\/+$/, "");
                if (parsed.uiUrl === DEFAULT_JAEGER_URL) {
                    parsed.uiUrl = parsed.jaegerUrl;
                }
            } else if (arg === "--ui-url") {
                parsed.uiUrl = value.replace(/\/+$/, "");
            } else if (arg === "--days") {
                parsed.days = Number.parseFloat(value);
            } else if (arg === "--limit") {
                parsed.queryLimit = Number.parseInt(value, 10);
            } else if (arg === "--out") {
                parsed.out = resolve(process.cwd(), value);
            } else if (arg === "--json-out") {
                parsed.jsonOut = resolve(process.cwd(), value);
            }

            index += 1;
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    if (!Number.isFinite(parsed.days) || parsed.days <= 0) {
        throw new Error("--days must be a positive number");
    }

    if (!Number.isInteger(parsed.queryLimit) || parsed.queryLimit <= 0) {
        throw new Error("--limit must be a positive integer");
    }

    return parsed;
}

function decode(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

function runCurlJson<T>(url: string): T {
    const processResult = Bun.spawnSync({
        cmd: ["curl", "-sS", "--compressed", "--max-time", "180", url],
        stderr: "pipe",
        stdout: "pipe",
    });

    if (processResult.exitCode !== 0) {
        const errorOutput = decode(processResult.stderr).trim() || `curl exited with ${processResult.exitCode}`;
        throw new Error(errorOutput);
    }

    const stdout = decode(processResult.stdout);
    return JSON.parse(stdout) as T;
}

function tagMap(span: JaegerSpan): Map<string, unknown> {
    const map = new Map<string, unknown>();

    for (const tag of span.tags ?? []) {
        map.set(tag.key, tag.value);
    }

    for (const log of span.logs ?? []) {
        for (const field of log.fields ?? []) {
            if (!map.has(field.key)) {
                map.set(field.key, field.value);
            }
        }
    }

    return map;
}

function asString(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}

function asNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return null;
}

function asBoolean(value: unknown): boolean {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        return value.toLowerCase() === "true";
    }
    return false;
}

function firstNumber(...values: Array<unknown>): number {
    for (const value of values) {
        const numeric = asNumber(value);
        if (numeric !== null) {
            return numeric;
        }
    }
    return 0;
}

function normalizeProvider(rawValues: Array<string>): string {
    for (const rawValue of rawValues) {
        const candidate = rawValue.toLowerCase();
        if (!candidate) {
            continue;
        }
        if (candidate.includes("anthropic")) {
            return "anthropic";
        }
        if (candidate.includes("openai")) {
            return "openai";
        }
        if (candidate.includes("openrouter")) {
            return "openrouter";
        }
        if (candidate.includes("google") || candidate.includes("vertex")) {
            return "google";
        }
        if (candidate.includes("groq")) {
            return "groq";
        }
        if (candidate.includes("xai")) {
            return "xai";
        }
        if (candidate.includes("perplexity") || candidate.includes("sonar")) {
            return "perplexity";
        }
        if (candidate.includes("mistral")) {
            return "mistral";
        }
        if (candidate.includes("ollama")) {
            return "ollama";
        }
        return candidate.split(/[.:/]/)[0] || candidate;
    }
    return "unknown";
}

function detectRateLimit(errorMessage: string): boolean {
    return /rate limit/i.test(errorMessage);
}

function logMessages(span: JaegerSpan): string[] {
    const messages: string[] = [];

    for (const log of span.logs ?? []) {
        for (const field of log.fields ?? []) {
            if (typeof field.value === "string" && field.value.trim().length > 0) {
                messages.push(field.value.trim());
            }
        }
    }

    return messages;
}

function dayKeyFor(usTimestamp: number): string {
    return new Intl.DateTimeFormat("en-CA", {
        day: "2-digit",
        month: "2-digit",
        timeZone: TIME_ZONE,
        year: "numeric",
    }).format(new Date(usTimestamp / 1000));
}

function dayLabelFor(dayKey: string): string {
    const [year, month, day] = dayKey.split("-").map((part) => Number.parseInt(part, 10));
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    return new Intl.DateTimeFormat("en-US", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
    }).format(utcDate);
}

function enumerateDayKeys(startUs: number, endUs: number): string[] {
    const stepUs = 6 * 60 * 60 * 1_000_000;
    const keys = new Set<string>();

    for (let cursor = startUs; cursor <= endUs; cursor += stepUs) {
        keys.add(dayKeyFor(cursor));
    }

    keys.add(dayKeyFor(endUs));
    return [...keys].sort();
}

function timestampLabelFor(usTimestamp: number): string {
    return new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: TIME_ZONE,
    }).format(new Date(usTimestamp / 1000));
}

function fullTimestampLabelFor(usTimestamp: number): string {
    return new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: TIME_ZONE,
    }).format(new Date(usTimestamp / 1000));
}

function formatInt(value: number): string {
    return new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 0,
    }).format(value);
}

function formatPct(value: number): string {
    return `${value.toFixed(1)}%`;
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;");
}

function traceLink(uiUrl: string, traceId: string, spanId: string): string {
    return `${uiUrl}/trace/${traceId}?uiFind=${spanId}`;
}

function usageSpanFromSpan(service: string, uiUrl: string, span: JaegerSpan): UsageSpan {
    const fields = tagMap(span);
    const messages = [
        asString(fields.get("otel.status_description")),
        asString(fields.get("exception.message")),
        asString(fields.get("error.exception")),
        asString(fields.get("error.message")),
        ...logMessages(span),
    ].filter(Boolean);
    const providerRaw = (
        asString(fields.get("ai.model.provider")) ||
        asString(fields.get("gen_ai.system")) ||
        asString(fields.get("ai.telemetry.metadata.llm.provider")) ||
        "unknown"
    ).trim();
    const provider = normalizeProvider([
        asString(fields.get("ai.telemetry.metadata.llm.provider")),
        providerRaw,
        asString(fields.get("gen_ai.system")),
        asString(fields.get("operation.name")),
    ]);
    const model =
        asString(fields.get("ai.model.id")) ||
        asString(fields.get("gen_ai.request.model")) ||
        asString(fields.get("ai.telemetry.metadata.llm.model")) ||
        "unknown";
    const functionId = asString(fields.get("ai.telemetry.functionId"));
    const agent =
        asString(fields.get("ai.telemetry.metadata.agent.slug")) ||
        (functionId.includes(".") ? functionId.split(".")[0] : "") ||
        "unknown";
    const inputTokens = firstNumber(
        fields.get("ai.usage.inputTokens"),
        fields.get("ai.usage.promptTokens"),
        fields.get("gen_ai.usage.input_tokens")
    );
    const outputTokens = firstNumber(
        fields.get("ai.usage.outputTokens"),
        fields.get("ai.usage.completionTokens"),
        fields.get("gen_ai.usage.output_tokens")
    );
    const totalTokens = firstNumber(fields.get("ai.usage.totalTokens"), inputTokens + outputTokens);
    const cachedInputTokens = firstNumber(fields.get("ai.usage.cachedInputTokens"));
    const cacheReadTokens = firstNumber(fields.get("ai.usage.inputTokenDetails.cacheReadTokens"));
    const cacheWriteTokens = firstNumber(fields.get("ai.usage.inputTokenDetails.cacheWriteTokens"));
    const noCacheTokens = firstNumber(fields.get("ai.usage.inputTokenDetails.noCacheTokens"));
    const status = asString(fields.get("otel.status_code")) || (asBoolean(fields.get("error")) ? "ERROR" : "OK");
    const errorMessage = messages[0] ?? "";
    const usageMissing = inputTokens === 0 && outputTokens === 0;
    const dayKey = dayKeyFor(span.startTime);

    return {
        agent,
        cacheReadTokens,
        cacheWriteTokens,
        cachedInputTokens,
        dayKey,
        dayLabel: dayLabelFor(dayKey),
        durationMs: Math.round(span.duration / 1000),
        errorMessage,
        functionId,
        inputTokens,
        model,
        noCacheTokens,
        outputTokens,
        provider,
        providerRaw,
        rateLimit: messages.some(detectRateLimit),
        service,
        spanId: span.spanID,
        status,
        success: status !== "ERROR" && !asBoolean(fields.get("error")),
        timestampLabel: timestampLabelFor(span.startTime),
        timestampUs: span.startTime,
        totalTokens,
        traceId: span.traceID,
        traceUrl: traceLink(uiUrl, span.traceID, span.spanID),
        usageMissing,
    };
}

async function fetchServices(jaegerUrl: string): Promise<string[]> {
    const response = runCurlJson<{ data?: string[] }>(`${jaegerUrl}/api/services`);
    return response.data ?? [];
}

async function fetchOperations(jaegerUrl: string, service: string): Promise<string[]> {
    const response = runCurlJson<{ data?: Array<{ name?: string }> }>(
        `${jaegerUrl}/api/operations?service=${encodeURIComponent(service)}`
    );
    return (response.data ?? []).map((operation) => operation.name ?? "").filter(Boolean);
}

async function fetchTraceWindow(
    jaegerUrl: string,
    service: string,
    startUs: number,
    endUs: number,
    queryLimit: number,
    depth = 0
): Promise<JaegerTrace[]> {
    const url =
        `${jaegerUrl}/api/traces?service=${encodeURIComponent(service)}` +
        `&operation=${encodeURIComponent(OPERATION_NAME)}` +
        `&lookback=custom&start=${startUs}&end=${endUs}&limit=${queryLimit}`;

    const span = endUs - startUs;
    let response: JaegerResponse;

    try {
        response = runCurlJson<JaegerResponse>(url);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (/operation timed out/i.test(message)) {
            if (span > MIN_WINDOW_US) {
                const midpoint = Math.floor((startUs + endUs) / 2);
                if (midpoint > startUs && midpoint < endUs) {
                    console.error(
                        `Timeout split ${service} window ${fullTimestampLabelFor(startUs)} -> ${fullTimestampLabelFor(endUs)}`
                    );
                    const left = await fetchTraceWindow(jaegerUrl, service, startUs, midpoint, queryLimit, depth + 1);
                    const right = await fetchTraceWindow(
                        jaegerUrl,
                        service,
                        midpoint + WINDOW_SPLIT_PADDING_US,
                        endUs,
                        queryLimit,
                        depth + 1
                    );
                    return [...left, ...right];
                }
            }

            if (queryLimit > 1) {
                const reducedLimit = Math.max(1, Math.floor(queryLimit / 2));
                if (reducedLimit < queryLimit) {
                    console.error(
                        `Timeout retry ${service} window ${fullTimestampLabelFor(startUs)} -> ${fullTimestampLabelFor(endUs)} with limit ${reducedLimit}`
                    );
                    return fetchTraceWindow(jaegerUrl, service, startUs, endUs, reducedLimit, depth + 1);
                }
            }
        }
        throw error;
    }

    const traces = response.data ?? [];

    if (traces.length < queryLimit || span <= MIN_WINDOW_US) {
        return traces;
    }

    const midpoint = Math.floor((startUs + endUs) / 2);
    if (midpoint <= startUs || midpoint >= endUs) {
        return traces;
    }

    console.error(
        `Splitting ${service} window ${fullTimestampLabelFor(startUs)} -> ${fullTimestampLabelFor(endUs)} at depth ${depth}`
    );

    const left = await fetchTraceWindow(jaegerUrl, service, startUs, midpoint, queryLimit, depth + 1);
    const right = await fetchTraceWindow(
        jaegerUrl,
        service,
        midpoint + WINDOW_SPLIT_PADDING_US,
        endUs,
        queryLimit,
        depth + 1
    );

    return [...left, ...right];
}

async function collectUsageSpans(
    args: ParsedArgs
): Promise<{ endUs: number; services: string[]; spans: UsageSpan[]; startUs: number }> {
    const services = await fetchServices(args.jaegerUrl);
    const targetServices: string[] = [];

    for (const service of services) {
        const operations = await fetchOperations(args.jaegerUrl, service);
        if (operations.includes(OPERATION_NAME)) {
            targetServices.push(service);
        }
    }

    const spansById = new Map<string, UsageSpan>();
    const endUs = Date.now() * 1000;
    const startUs = endUs - Math.round(args.days * 24 * 60 * 60 * 1_000_000);

    for (const service of targetServices) {
        console.error(`Fetching ${service} from ${fullTimestampLabelFor(startUs)} to ${fullTimestampLabelFor(endUs)}`);
        for (let windowStart = startUs; windowStart < endUs; windowStart += BASE_WINDOW_US) {
            const windowEnd = Math.min(windowStart + BASE_WINDOW_US - 1, endUs);
            console.error(
                `  Window ${fullTimestampLabelFor(windowStart)} -> ${fullTimestampLabelFor(windowEnd)}`
            );
            const traces = await fetchTraceWindow(
                args.jaegerUrl,
                service,
                windowStart,
                windowEnd,
                args.queryLimit
            );

            for (const trace of traces) {
                for (const span of trace.spans ?? []) {
                    if (span.operationName !== OPERATION_NAME) {
                        continue;
                    }

                    if (span.startTime < startUs || span.startTime > endUs) {
                        continue;
                    }

                    const usageSpan = usageSpanFromSpan(service, args.uiUrl, span);
                    spansById.set(`${service}:${span.traceID}:${span.spanID}`, usageSpan);
                }
            }
        }
    }

    return {
        endUs,
        services: targetServices,
        spans: [...spansById.values()].sort((left, right) => left.timestampUs - right.timestampUs),
        startUs,
    };
}

function summarizeProviders(spans: UsageSpan[]): Map<string, ProviderSummary> {
    const summary = new Map<string, ProviderSummary>();

    for (const span of spans) {
        const entry =
            summary.get(span.provider) ??
            {
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                cachedInputTokens: 0,
                inputTokens: 0,
                models: new Map<string, number>(),
                noCacheTokens: 0,
                outputTokens: 0,
                providersRaw: new Set<string>(),
                rateLimitErrors: 0,
                requests: 0,
                services: new Set<string>(),
                successfulRequests: 0,
                usageMissing: 0,
            };

        entry.cacheReadTokens += span.cacheReadTokens;
        entry.cacheWriteTokens += span.cacheWriteTokens;
        entry.cachedInputTokens += span.cachedInputTokens;
        entry.inputTokens += span.inputTokens;
        entry.noCacheTokens += span.noCacheTokens;
        entry.outputTokens += span.outputTokens;
        entry.providersRaw.add(span.providerRaw);
        entry.rateLimitErrors += span.rateLimit ? 1 : 0;
        entry.requests += 1;
        entry.successfulRequests += span.success ? 1 : 0;
        entry.services.add(span.service);
        entry.usageMissing += span.usageMissing ? 1 : 0;
        entry.models.set(span.model, (entry.models.get(span.model) ?? 0) + span.inputTokens);

        summary.set(span.provider, entry);
    }

    return summary;
}

function summarizeModels(spans: UsageSpan[]): Map<string, ModelSummary> {
    const summary = new Map<string, ModelSummary>();

    for (const span of spans) {
        const key = `${span.provider}::${span.model}`;
        const entry =
            summary.get(key) ??
            {
                inputTokens: 0,
                outputTokens: 0,
                provider: span.provider,
                rateLimitErrors: 0,
                requests: 0,
            };

        entry.inputTokens += span.inputTokens;
        entry.outputTokens += span.outputTokens;
        entry.rateLimitErrors += span.rateLimit ? 1 : 0;
        entry.requests += 1;
        summary.set(key, entry);
    }

    return summary;
}

function summarizeAgents(spans: UsageSpan[]): Map<string, AgentSummary> {
    const summary = new Map<string, AgentSummary>();

    for (const span of spans) {
        const key = `${span.provider}::${span.agent}`;
        const entry =
            summary.get(key) ??
            {
                inputTokens: 0,
                provider: span.provider,
                rateLimitErrors: 0,
                requests: 0,
            };

        entry.inputTokens += span.inputTokens;
        entry.rateLimitErrors += span.rateLimit ? 1 : 0;
        entry.requests += 1;
        summary.set(key, entry);
    }

    return summary;
}

function summarizeServices(spans: UsageSpan[]): Map<string, ServiceSummary> {
    const summary = new Map<string, ServiceSummary>();

    for (const span of spans) {
        const entry =
            summary.get(span.service) ??
            {
                inputTokens: 0,
                outputTokens: 0,
                providers: new Set<string>(),
                rateLimitErrors: 0,
                requests: 0,
            };

        entry.inputTokens += span.inputTokens;
        entry.outputTokens += span.outputTokens;
        entry.providers.add(span.provider);
        entry.rateLimitErrors += span.rateLimit ? 1 : 0;
        entry.requests += 1;
        summary.set(span.service, entry);
    }

    return summary;
}

function maxBy<T>(items: T[], selector: (item: T) => number): number {
    return items.reduce((max, item) => Math.max(max, selector(item)), 0);
}

function providerColorMap(providers: string[]): Map<string, string> {
    const map = new Map<string, string>();
    providers.forEach((provider, index) => {
        map.set(provider, PROVIDER_COLORS[index % PROVIDER_COLORS.length]);
    });
    return map;
}

function renderStackedBarChart(
    title: string,
    subtitle: string,
    dayKeys: string[],
    providerOrder: string[],
    values: Map<string, Map<string, number>>,
    colorMap: Map<string, string>
): string {
    const totals = dayKeys.map((dayKey) => {
        const dayValues = values.get(dayKey) ?? new Map<string, number>();
        return providerOrder.reduce((sum, provider) => sum + (dayValues.get(provider) ?? 0), 0);
    });
    const maxTotal = Math.max(...totals, 1);

    return `
        <section class="panel">
            <div class="panel-heading">
                <h2>${escapeHtml(title)}</h2>
                <p>${escapeHtml(subtitle)}</p>
            </div>
            <div class="chart-legend">
                ${providerOrder
                    .map(
                        (provider) => `
                            <span class="legend-item">
                                <span class="legend-swatch" style="background:${colorMap.get(provider)}"></span>
                                ${escapeHtml(provider)}
                            </span>
                        `
                    )
                    .join("")}
            </div>
            <div class="stack-chart">
                ${dayKeys
                    .map((dayKey, index) => {
                        const total = totals[index];
                        const totalHeight = (total / maxTotal) * 100;
                        const segments = values.get(dayKey) ?? new Map<string, number>();
                        return `
                            <div class="stack-column">
                                <div class="stack-total">${formatInt(total)}</div>
                                <div class="stack-shell">
                                    <div class="stack-fill" style="height:${totalHeight}%">
                                        ${providerOrder
                                            .filter((provider) => (segments.get(provider) ?? 0) > 0)
                                            .map((provider) => {
                                                const value = segments.get(provider) ?? 0;
                                                const segmentPct = total === 0 ? 0 : (value / total) * 100;
                                                return `<div class="stack-segment" title="${escapeHtml(
                                                    `${dayLabelFor(dayKey)}: ${provider} ${formatInt(value)}`
                                                )}" style="height:${segmentPct}%;background:${colorMap.get(provider)}"></div>`;
                                            })
                                            .join("")}
                                    </div>
                                </div>
                                <div class="stack-label">${escapeHtml(dayLabelFor(dayKey))}</div>
                            </div>
                        `;
                    })
                    .join("")}
            </div>
        </section>
    `;
}

function renderHorizontalBarChart(
    title: string,
    subtitle: string,
    rows: Array<{ color: string; label: string; value: number; extra?: string }>
): string {
    const maxValue = Math.max(...rows.map((row) => row.value), 1);

    return `
        <section class="panel">
            <div class="panel-heading">
                <h2>${escapeHtml(title)}</h2>
                <p>${escapeHtml(subtitle)}</p>
            </div>
            <div class="hbars">
                ${rows
                    .map((row) => {
                        const width = (row.value / maxValue) * 100;
                        return `
                            <div class="hbar-row">
                                <div class="hbar-label">${escapeHtml(row.label)}</div>
                                <div class="hbar-track">
                                    <div class="hbar-fill" style="width:${width}%;background:${row.color}"></div>
                                </div>
                                <div class="hbar-value">${formatInt(row.value)}</div>
                                <div class="hbar-extra">${escapeHtml(row.extra ?? "")}</div>
                            </div>
                        `;
                    })
                    .join("")}
            </div>
        </section>
    `;
}

function renderSummaryCards(cards: Array<{ label: string; value: string; note: string }>): string {
    return `
        <section class="summary-grid">
            ${cards
                .map(
                    (card) => `
                        <div class="summary-card">
                            <div class="summary-label">${escapeHtml(card.label)}</div>
                            <div class="summary-value">${escapeHtml(card.value)}</div>
                            <div class="summary-note">${escapeHtml(card.note)}</div>
                        </div>
                    `
                )
                .join("")}
        </section>
    `;
}

function renderTable(headers: string[], rows: string[][]): string {
    return `
        <div class="table-wrap">
            <table>
                <thead>
                    <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>
                </thead>
                <tbody>
                    ${rows
                        .map(
                            (row) => `
                                <tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>
                            `
                        )
                        .join("")}
                </tbody>
            </table>
        </div>
    `;
}

function renderHtmlReport(
    args: ParsedArgs,
    services: string[],
    spans: UsageSpan[],
    startUs: number,
    endUs: number
): string {
    const providerSummary = summarizeProviders(spans);
    const modelSummary = summarizeModels(spans);
    const agentSummary = summarizeAgents(spans);
    const serviceSummary = summarizeServices(spans);
    const providers = [...providerSummary.entries()]
        .sort((left, right) => right[1].inputTokens - left[1].inputTokens)
        .map(([provider]) => provider);
    const colorMap = providerColorMap(providers);
    const totalInputTokens = spans.reduce((sum, span) => sum + span.inputTokens, 0);
    const totalOutputTokens = spans.reduce((sum, span) => sum + span.outputTokens, 0);
    const totalRateLimitErrors = spans.reduce((sum, span) => sum + (span.rateLimit ? 1 : 0), 0);
    const usageMissing = spans.reduce((sum, span) => sum + (span.usageMissing ? 1 : 0), 0);
    const dayKeys = enumerateDayKeys(startUs, endUs);
    const dailyProviderValues = new Map<string, Map<string, number>>();
    const anthropicBreakdown = new Map<string, Map<string, number>>();

    for (const dayKey of dayKeys) {
        dailyProviderValues.set(dayKey, new Map<string, number>());
        anthropicBreakdown.set(
            dayKey,
            new Map<string, number>([
                ["no-cache", 0],
                ["cache-write", 0],
                ["cache-read", 0],
                ["unclassified", 0],
            ])
        );
    }

    for (const span of spans) {
        const dayProviderValues = dailyProviderValues.get(span.dayKey) ?? new Map<string, number>();
        dayProviderValues.set(span.provider, (dayProviderValues.get(span.provider) ?? 0) + span.inputTokens);
        dailyProviderValues.set(span.dayKey, dayProviderValues);

        if (span.provider === "anthropic") {
            const breakdown = anthropicBreakdown.get(span.dayKey) ?? new Map<string, number>();
            const accounted =
                span.noCacheTokens + span.cacheWriteTokens + span.cacheReadTokens;
            breakdown.set("no-cache", (breakdown.get("no-cache") ?? 0) + span.noCacheTokens);
            breakdown.set("cache-write", (breakdown.get("cache-write") ?? 0) + span.cacheWriteTokens);
            breakdown.set("cache-read", (breakdown.get("cache-read") ?? 0) + span.cacheReadTokens);
            breakdown.set(
                "unclassified",
                (breakdown.get("unclassified") ?? 0) + Math.max(span.inputTokens - accounted, 0)
            );
            anthropicBreakdown.set(span.dayKey, breakdown);
        }
    }

    const providerRows = [...providerSummary.entries()]
        .sort((left, right) => right[1].inputTokens - left[1].inputTokens)
        .map(([provider, summary]) => {
            const topModel = [...summary.models.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "n/a";
            const inputShare = totalInputTokens === 0 ? 0 : (summary.inputTokens / totalInputTokens) * 100;
            return [
                `<span class="provider-chip"><span class="dot" style="background:${colorMap.get(provider)}"></span>${escapeHtml(
                    provider
                )}</span>`,
                escapeHtml([...summary.providersRaw].sort().join(", ")),
                formatInt(summary.inputTokens),
                formatInt(summary.outputTokens),
                formatInt(summary.requests),
                formatInt(summary.successfulRequests),
                formatInt(summary.rateLimitErrors),
                formatPct(inputShare),
                formatInt(Math.round(summary.inputTokens / Math.max(summary.requests, 1))),
                formatInt(summary.cacheWriteTokens),
                formatInt(summary.noCacheTokens),
                escapeHtml([...summary.services].sort().join(", ")),
                escapeHtml(topModel),
            ];
        });

    const topModelsRows = [...modelSummary.entries()]
        .sort((left, right) => right[1].inputTokens - left[1].inputTokens)
        .slice(0, 12)
        .map(([key, summary]) => {
            const [, model] = key.split("::");
            return [
                escapeHtml(summary.provider),
                escapeHtml(model),
                formatInt(summary.inputTokens),
                formatInt(summary.outputTokens),
                formatInt(summary.requests),
                formatInt(summary.rateLimitErrors),
            ];
        });

    const topAgentRows = [...agentSummary.entries()]
        .sort((left, right) => right[1].inputTokens - left[1].inputTokens)
        .slice(0, 12)
        .map(([key, summary]) => {
            const [, agent] = key.split("::");
            return [
                escapeHtml(summary.provider),
                escapeHtml(agent),
                formatInt(summary.inputTokens),
                formatInt(summary.requests),
                formatInt(summary.rateLimitErrors),
            ];
        });

    const serviceRows = [...serviceSummary.entries()]
        .sort((left, right) => right[1].inputTokens - left[1].inputTokens)
        .map(([service, summary]) => [
            escapeHtml(service),
            formatInt(summary.inputTokens),
            formatInt(summary.outputTokens),
            formatInt(summary.requests),
            formatInt(summary.rateLimitErrors),
            escapeHtml([...summary.providers].sort().join(", ")),
        ]);

    const heaviestSpansRows = [...spans]
        .sort((left, right) => right.inputTokens - left.inputTokens)
        .slice(0, 25)
        .map((span) => [
            escapeHtml(span.timestampLabel),
            escapeHtml(span.provider),
            escapeHtml(span.model),
            escapeHtml(span.agent),
            escapeHtml(span.service),
            formatInt(span.inputTokens),
            formatInt(span.outputTokens),
            formatInt(span.cacheWriteTokens),
            escapeHtml(span.status),
            span.rateLimit ? "yes" : "no",
            `<a href="${escapeHtml(span.traceUrl)}" target="_blank" rel="noreferrer">open trace</a>`,
        ]);

    const anthropicRows = spans
        .filter((span) => span.provider === "anthropic")
        .sort((left, right) => right.inputTokens - left.inputTokens)
        .slice(0, 20)
        .map((span) => [
            escapeHtml(span.timestampLabel),
            escapeHtml(span.model),
            escapeHtml(span.agent),
            formatInt(span.inputTokens),
            formatInt(span.cacheWriteTokens),
            formatInt(span.noCacheTokens),
            formatInt(span.outputTokens),
            escapeHtml(span.status),
            span.rateLimit ? "yes" : "no",
            `<a href="${escapeHtml(span.traceUrl)}" target="_blank" rel="noreferrer">open trace</a>`,
        ]);

    const rateLimitRows = spans
        .filter((span) => span.rateLimit)
        .sort((left, right) => right.timestampUs - left.timestampUs)
        .slice(0, 25)
        .map((span) => [
            escapeHtml(span.timestampLabel),
            escapeHtml(span.provider),
            escapeHtml(span.model),
            escapeHtml(span.agent),
            escapeHtml(span.service),
            formatInt(span.inputTokens),
            escapeHtml(span.errorMessage || "rate limit detected in logs"),
            `<a href="${escapeHtml(span.traceUrl)}" target="_blank" rel="noreferrer">open trace</a>`,
        ]);

    const providerBars = providers.map((provider) => {
        const summary = providerSummary.get(provider)!;
        const share = totalInputTokens === 0 ? 0 : (summary.inputTokens / totalInputTokens) * 100;
        return {
            color: colorMap.get(provider)!,
            label: provider,
            value: summary.inputTokens,
            extra: `${formatPct(share)} of input`,
        };
    });

    const anthropicColorMap = new Map<string, string>([
        ["no-cache", "#c1121f"],
        ["cache-write", "#f4a261"],
        ["cache-read", "#2a9d8f"],
        ["unclassified", "#9aa5b1"],
    ]);

    const anthropicProviders = ["no-cache", "cache-write", "cache-read", "unclassified"];

    return `
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Jaeger Token Usage Report</title>
    <style>
        :root {
            color-scheme: light;
            --bg: #f7f3eb;
            --panel: #fffdf9;
            --ink: #132238;
            --muted: #5f6c7b;
            --grid: #ded5c7;
            --accent: #c1121f;
            --accent-soft: rgba(193, 18, 31, 0.12);
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            background:
                radial-gradient(circle at top left, rgba(42, 157, 143, 0.1), transparent 28rem),
                radial-gradient(circle at top right, rgba(193, 18, 31, 0.08), transparent 24rem),
                var(--bg);
            color: var(--ink);
            font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
            line-height: 1.45;
        }

        main {
            max-width: 1440px;
            margin: 0 auto;
            padding: 32px 24px 80px;
        }

        .hero {
            display: grid;
            gap: 18px;
            margin-bottom: 28px;
            padding: 24px 28px;
            border: 1px solid var(--grid);
            border-radius: 24px;
            background: linear-gradient(150deg, rgba(255, 253, 249, 0.96), rgba(250, 246, 239, 0.92));
            box-shadow: 0 22px 60px rgba(20, 34, 61, 0.08);
        }

        .eyebrow {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: var(--muted);
        }

        h1, h2, h3 {
            margin: 0;
            font-weight: 700;
            letter-spacing: -0.02em;
        }

        h1 {
            font-size: clamp(2rem, 3vw, 3rem);
            max-width: 18ch;
        }

        p {
            margin: 0;
            color: var(--muted);
        }

        .hero-meta {
            display: grid;
            gap: 8px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 13px;
            color: var(--muted);
        }

        .summary-grid,
        .two-up {
            display: grid;
            gap: 16px;
        }

        .summary-grid {
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            margin-bottom: 22px;
        }

        .two-up {
            grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
            margin-bottom: 22px;
        }

        .summary-card,
        .panel {
            border: 1px solid var(--grid);
            border-radius: 20px;
            background: var(--panel);
            box-shadow: 0 14px 40px rgba(20, 34, 61, 0.05);
        }

        .summary-card {
            padding: 18px;
        }

        .summary-label {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--muted);
        }

        .summary-value {
            margin-top: 8px;
            font-size: 1.9rem;
            font-weight: 700;
            color: var(--ink);
        }

        .summary-note {
            margin-top: 6px;
            font-size: 14px;
            color: var(--muted);
        }

        .panel {
            padding: 20px;
        }

        .panel-heading {
            display: grid;
            gap: 6px;
            margin-bottom: 18px;
        }

        .chart-legend {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-bottom: 16px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
        }

        .legend-item {
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }

        .legend-swatch,
        .dot {
            width: 11px;
            height: 11px;
            border-radius: 999px;
            display: inline-block;
            flex: 0 0 auto;
        }

        .stack-chart {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
            gap: 14px;
            align-items: end;
        }

        .stack-column {
            display: grid;
            gap: 8px;
            justify-items: center;
        }

        .stack-total {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
            color: var(--muted);
        }

        .stack-shell {
            width: 64px;
            height: 250px;
            padding: 4px;
            border-radius: 18px;
            border: 1px solid var(--grid);
            background:
                linear-gradient(to top, rgba(209, 217, 224, 0.36) 1px, transparent 1px) 0 0 / 100% 20%,
                linear-gradient(180deg, rgba(255, 255, 255, 0.8), rgba(236, 231, 222, 0.6));
            display: flex;
            align-items: flex-end;
        }

        .stack-fill {
            width: 100%;
            border-radius: 14px;
            overflow: hidden;
            display: flex;
            flex-direction: column-reverse;
            min-height: 2px;
        }

        .stack-segment {
            width: 100%;
        }

        .stack-label {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
            color: var(--muted);
        }

        .hbars {
            display: grid;
            gap: 12px;
        }

        .hbar-row {
            display: grid;
            grid-template-columns: minmax(120px, 180px) minmax(160px, 1fr) minmax(72px, 96px) minmax(110px, 150px);
            gap: 12px;
            align-items: center;
        }

        .hbar-label,
        .hbar-value,
        .hbar-extra {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
        }

        .hbar-track {
            height: 16px;
            border-radius: 999px;
            background: rgba(95, 108, 123, 0.15);
            overflow: hidden;
        }

        .hbar-fill {
            height: 100%;
            border-radius: 999px;
        }

        .provider-chip {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-weight: 600;
        }

        .table-wrap {
            overflow-x: auto;
            border: 1px solid var(--grid);
            border-radius: 16px;
            background: rgba(255, 255, 255, 0.42);
        }

        table {
            width: 100%;
            border-collapse: collapse;
            min-width: 860px;
        }

        th,
        td {
            padding: 11px 14px;
            border-bottom: 1px solid rgba(222, 213, 199, 0.72);
            text-align: left;
            vertical-align: top;
        }

        th {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: var(--muted);
            background: rgba(19, 34, 56, 0.03);
            position: sticky;
            top: 0;
        }

        td {
            font-size: 14px;
        }

        a {
            color: var(--accent);
            text-decoration: none;
            font-weight: 600;
        }

        a:hover {
            text-decoration: underline;
        }

        .section {
            display: grid;
            gap: 14px;
            margin-top: 24px;
        }

        .callout {
            padding: 16px 18px;
            border-left: 4px solid var(--accent);
            border-radius: 14px;
            background: var(--accent-soft);
            color: var(--ink);
        }

        .small {
            font-size: 13px;
            color: var(--muted);
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }

        @media (max-width: 880px) {
            main {
                padding: 24px 16px 64px;
            }

            .hero {
                padding: 20px;
            }

            .two-up {
                grid-template-columns: 1fr;
            }

            .hbar-row {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <main>
        <section class="hero">
            <div class="eyebrow">Jaeger doStream token usage</div>
            <h1>Where the token budget is going across the last ${escapeHtml(args.days.toString())} days.</h1>
            <p>This report only includes <code>${escapeHtml(OPERATION_NAME)}</code> spans found in Jaeger and normalizes token fields across both <code>ai.usage.inputTokens</code> and older <code>ai.usage.promptTokens</code> variants.</p>
            <div class="hero-meta">
                <div>Window: ${escapeHtml(fullTimestampLabelFor(startUs))} to ${escapeHtml(fullTimestampLabelFor(endUs))} (${escapeHtml(TIME_ZONE)})</div>
                <div>Jaeger: ${escapeHtml(args.jaegerUrl)}</div>
                <div>Services scanned: ${escapeHtml(services.join(", "))}</div>
                <div>Trace scope: ${escapeHtml(OPERATION_NAME)}</div>
            </div>
        </section>

        ${renderSummaryCards([
            {
                label: "Requests",
                value: formatInt(spans.length),
                note: `${formatInt(spans.length - usageMissing)} spans had usage counters`,
            },
            {
                label: "Input Tokens",
                value: formatInt(totalInputTokens),
                note: "Normalized from inputTokens/promptTokens fields",
            },
            {
                label: "Output Tokens",
                value: formatInt(totalOutputTokens),
                note: "Normalized from outputTokens/completionTokens fields",
            },
            {
                label: "Providers",
                value: formatInt(providers.length),
                note: providers.join(", "),
            },
            {
                label: "Rate-Limit Errors",
                value: formatInt(totalRateLimitErrors),
                note: spans.length === 0 ? "0.0%" : `${formatPct((totalRateLimitErrors / spans.length) * 100)} of requests`,
            },
            {
                label: "Anthropic Input",
                value: formatInt(providerSummary.get("anthropic")?.inputTokens ?? 0),
                note: providers.includes("anthropic")
                    ? `${formatPct(((providerSummary.get("anthropic")?.inputTokens ?? 0) / Math.max(totalInputTokens, 1)) * 100)} of total input`
                    : "No anthropic spans in window",
            },
        ])}

        <div class="callout">
            <strong>Key interpretation:</strong> if Anthropic dominates both input tokens and rate-limit errors, the immediate suspects are high-frequency calls, large system prompts, or large cache writes. Anthropic cache-write tokens are broken out separately below because they can be a major share of the input budget.
        </div>

        <div class="two-up">
            ${renderStackedBarChart(
                "Daily input tokens by provider",
                "Each bar is one local calendar day in Europe/Athens; bar height is total input volume and each segment shows provider share.",
                dayKeys,
                providers,
                dailyProviderValues,
                colorMap
            )}
            ${renderHorizontalBarChart(
                "Provider share of input tokens",
                "Sorted by total input tokens over the full window.",
                providerBars
            )}
        </div>

        <div class="two-up">
            ${renderStackedBarChart(
                "Anthropic input composition",
                "Anthropic-only daily input split into no-cache tokens, cache writes, cache reads, and anything unclassified by the trace fields.",
                dayKeys,
                anthropicProviders,
                anthropicBreakdown,
                anthropicColorMap
            )}
            ${renderHorizontalBarChart(
                "Service share of input tokens",
                "Useful for separating production daemon usage from tester traffic.",
                [...serviceSummary.entries()]
                    .sort((left, right) => right[1].inputTokens - left[1].inputTokens)
                    .map(([service, summary]) => ({
                        color: "#1d3557",
                        label: service,
                        value: summary.inputTokens,
                        extra: `${formatInt(summary.requests)} req`,
                    }))
            )}
        </div>

        <section class="section">
            <div class="panel-heading">
                <h2>Provider summary</h2>
                <p>Breakdown by normalized provider family. Raw variants show the exact provider tags found on the spans.</p>
            </div>
            ${renderTable(
                [
                    "Provider",
                    "Raw variants",
                    "Input",
                    "Output",
                    "Requests",
                    "Successful",
                    "Rate-limit errors",
                    "Input share",
                    "Avg input/req",
                    "Cache write",
                    "No-cache",
                    "Services",
                    "Top model",
                ],
                providerRows
            )}
        </section>

        <section class="section">
            <div class="panel-heading">
                <h2>Top models</h2>
                <p>Highest input-token consumers across the whole 4-day window.</p>
            </div>
            ${renderTable(["Provider", "Model", "Input", "Output", "Requests", "Rate-limit errors"], topModelsRows)}
        </section>

        <section class="section">
            <div class="panel-heading">
                <h2>Top agents</h2>
                <p>Where the input budget lands at the agent level when the trace includes an agent slug.</p>
            </div>
            ${renderTable(["Provider", "Agent", "Input", "Requests", "Rate-limit errors"], topAgentRows)}
        </section>

        <section class="section">
            <div class="panel-heading">
                <h2>Service breakdown</h2>
                <p>Useful for telling daemon traffic apart from memtest or conversation-memory test traffic.</p>
            </div>
            ${renderTable(["Service", "Input", "Output", "Requests", "Rate-limit errors", "Providers"], serviceRows)}
        </section>

        <section class="section">
            <div class="panel-heading">
                <h2>Heaviest doStream spans</h2>
                <p>The individual spans with the largest input-token totals. These are the fastest route to concrete examples in Jaeger.</p>
            </div>
            ${renderTable(
                [
                    "Timestamp",
                    "Provider",
                    "Model",
                    "Agent",
                    "Service",
                    "Input",
                    "Output",
                    "Cache write",
                    "Status",
                    "Rate limit",
                    "Trace",
                ],
                heaviestSpansRows
            )}
        </section>

        <section class="section">
            <div class="panel-heading">
                <h2>Anthropic focus</h2>
                <p>Highest-input Anthropic spans, with cache-write and no-cache token columns separated to show prompt-caching behavior.</p>
            </div>
            ${renderTable(
                [
                    "Timestamp",
                    "Model",
                    "Agent",
                    "Input",
                    "Cache write",
                    "No-cache",
                    "Output",
                    "Status",
                    "Rate limit",
                    "Trace",
                ],
                anthropicRows
            )}
        </section>

        <section class="section">
            <div class="panel-heading">
                <h2>Rate-limit spans</h2>
                <p>Recent spans where the Jaeger tags or log fields included rate-limit text such as "This request would exceed your account's rate limit."</p>
            </div>
            ${renderTable(
                ["Timestamp", "Provider", "Model", "Agent", "Service", "Input", "Error text", "Trace"],
                rateLimitRows
            )}
        </section>

        <section class="section">
            <div class="small">
                Generated ${escapeHtml(fullTimestampLabelFor(Date.now() * 1000))}. Missing usage counts usually correspond to failed requests where Jaeger recorded the span but the provider never returned token counters.
            </div>
        </section>
    </main>
</body>
</html>
    `;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const { endUs, services, spans, startUs } = await collectUsageSpans(args);
    const html = renderHtmlReport(args, services, spans, startUs, endUs);

    await mkdir(dirname(args.out), { recursive: true });
    await mkdir(dirname(args.jsonOut), { recursive: true });

    await writeFile(args.out, html, "utf8");
    await writeFile(
        args.jsonOut,
        JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                jaegerUrl: args.jaegerUrl,
                services,
                spans,
            },
            null,
            2
        ),
        "utf8"
    );

    const providerSummary = summarizeProviders(spans);
    const sortedProviders = [...providerSummary.entries()].sort((left, right) => right[1].inputTokens - left[1].inputTokens);

    console.log(`HTML report: ${args.out}`);
    console.log(`JSON data:   ${args.jsonOut}`);
    console.log(`Spans:       ${formatInt(spans.length)}`);
    console.log(`Providers:   ${sortedProviders.map(([provider]) => provider).join(", ") || "none"}`);
    console.log("Input by provider:");
    for (const [provider, summary] of sortedProviders) {
        console.log(
            `  ${provider.padEnd(12)} ${formatInt(summary.inputTokens).padStart(12)} input  ${formatInt(summary.rateLimitErrors).padStart(4)} rate-limit errors`
        );
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
