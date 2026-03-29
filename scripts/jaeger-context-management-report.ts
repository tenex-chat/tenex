#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createDefaultPromptTokenEstimator } from "ai-sdk-context-management";
import type { ModelMessage } from "ai";
import { normalizeMessagesForContextManagement } from "@/agents/execution/context-management/normalize-messages";

type JaegerField = {
    key: string;
    value?: unknown;
};

type JaegerLog = {
    fields?: JaegerField[];
    timestamp?: number;
};

type JaegerSpan = {
    duration: number;
    logs?: JaegerLog[];
    operationName: string;
    processID?: string;
    spanID: string;
    startTime: number;
    tags?: JaegerField[];
    traceID: string;
};

type JaegerTrace = {
    spans?: JaegerSpan[];
    traceID: string;
};

type JaegerResponse = {
    data?: JaegerTrace[];
};

type ContextEvent = {
    attributes: Record<string, string | number | boolean>;
    name: string;
    sourceContextKey: string;
    timestamp: number;
};

type MessageEntry = {
    classification: string;
    estimatedTokens: number;
    followingMessages: number;
    hash: string;
    index: number;
    preview: string;
    role: string;
};

type CarrySpanRecord = {
    agent: string;
    contextEvents: ContextEvent[];
    conversationId: string;
    inputTokens: number;
    model: string;
    messages: MessageEntry[];
    provider: string;
    service: string;
    spanId: string;
    timestampUs: number;
    traceId: string;
    traceUrl: string;
};

type CarryRun = {
    agent: string;
    conversationId: string;
    count: number;
    endFollowingMessages: number;
    endTimestampUs: number;
    persistedToThreadEnd: boolean;
    provider: string;
    startTimestampUs: number;
    traceId: string;
    traceUrl: string;
};

type MessageAggregate = {
    classification: string;
    estimatedTokens: number;
    maxCarrySpans: number;
    maxFollowingMessages: number;
    occurrences: number;
    preview: string;
    role: string;
    runs: CarryRun[];
    threads: Set<string>;
};

type ParsedArgs = {
    coverage: number;
    days: number;
    htmlOut: string;
    jaegerUrl: string;
    jsonOut: string;
    maxTraces: number;
    queryLimit: number;
    sourceJson: string;
    traceFetchConcurrency: number;
    uiUrl: string;
};

type SelectionSummary = {
    coveragePct: number;
    selectedInputTokens: number;
    selectedSpanCount: number;
    selectedTraceCount: number;
    totalInputTokens: number;
    totalTraceCount: number;
};

type SourceUsageSpan = {
    agent?: string;
    inputTokens?: number;
    model?: string;
    provider?: string;
    service?: string;
    spanId?: string;
    timestampUs?: number;
    traceId?: string;
};

type SourceUsageReport = {
    spans?: SourceUsageSpan[];
};

const CONTEXT_SPAN_NAME = "tenex.context_management";
const DEFAULT_DAYS = 4;
const DEFAULT_JAEGER_URL = "http://23.88.91.234:16686";
const DEFAULT_MAX_TRACES = 40;
const DEFAULT_QUERY_LIMIT = 10;
const BASE_WINDOW_US = 2 * 60 * 60 * 1_000_000;
const CURL_MAX_TIME_SECONDS = 120;
const DEFAULT_COVERAGE = 0.8;
const DEFAULT_TRACE_FETCH_CONCURRENCY = 2;
const MIN_WINDOW_US = 5 * 60 * 1_000_000;
const OPERATION_NAME = "ai.streamText.doStream";
const TIME_ZONE = "Europe/Athens";
const LARGE_MESSAGE_THRESHOLD = 2_000;
const WINDOW_CONCURRENCY = 4;
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

function usage(): string {
    return [
        "Usage: bun scripts/jaeger-context-management-report.ts [options]",
        "",
        "Build a context-management carry report from Jaeger doStream traces.",
        "",
        `  --jaeger-url <url>  Default: ${DEFAULT_JAEGER_URL}`,
        "  --ui-url <url>      Default: same as --jaeger-url",
        `  --days <n>          Default: ${DEFAULT_DAYS}`,
        `  --coverage <n>      Default: ${DEFAULT_COVERAGE}`,
        `  --limit <n>         Default: ${DEFAULT_QUERY_LIMIT}`,
        `  --max-traces <n>    Default: ${DEFAULT_MAX_TRACES}`,
        `  --source-json <p>   Default: dist/jaeger-token-usage-report.json`,
        `  --trace-fetch-concurrency <n> Default: ${DEFAULT_TRACE_FETCH_CONCURRENCY}`,
        "  --out <path>        Default: dist/jaeger-context-management-report.html",
        "  --json-out <path>   Default: dist/jaeger-context-management-report.json",
        "  -h, --help          Show help",
    ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
    const parsed: ParsedArgs = {
        coverage: DEFAULT_COVERAGE,
        days: DEFAULT_DAYS,
        htmlOut: resolve(process.cwd(), "dist", "jaeger-context-management-report.html"),
        jaegerUrl: DEFAULT_JAEGER_URL,
        jsonOut: resolve(process.cwd(), "dist", "jaeger-context-management-report.json"),
        maxTraces: DEFAULT_MAX_TRACES,
        queryLimit: DEFAULT_QUERY_LIMIT,
        sourceJson: resolve(process.cwd(), "dist", "jaeger-token-usage-report.json"),
        traceFetchConcurrency: DEFAULT_TRACE_FETCH_CONCURRENCY,
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
            arg === "--coverage" ||
            arg === "--limit" ||
            arg === "--max-traces" ||
            arg === "--source-json" ||
            arg === "--trace-fetch-concurrency" ||
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
            } else if (arg === "--coverage") {
                parsed.coverage = Number.parseFloat(value);
            } else if (arg === "--limit") {
                parsed.queryLimit = Number.parseInt(value, 10);
            } else if (arg === "--max-traces") {
                parsed.maxTraces = Number.parseInt(value, 10);
            } else if (arg === "--source-json") {
                parsed.sourceJson = resolve(process.cwd(), value);
            } else if (arg === "--trace-fetch-concurrency") {
                parsed.traceFetchConcurrency = Number.parseInt(value, 10);
            } else if (arg === "--out") {
                parsed.htmlOut = resolve(process.cwd(), value);
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

    if (!Number.isFinite(parsed.coverage) || parsed.coverage <= 0 || parsed.coverage > 1) {
        throw new Error("--coverage must be > 0 and <= 1");
    }

    if (!Number.isInteger(parsed.queryLimit) || parsed.queryLimit <= 0) {
        throw new Error("--limit must be a positive integer");
    }

    if (!Number.isInteger(parsed.maxTraces) || parsed.maxTraces <= 0) {
        throw new Error("--max-traces must be a positive integer");
    }

    if (!Number.isInteger(parsed.traceFetchConcurrency) || parsed.traceFetchConcurrency <= 0) {
        throw new Error("--trace-fetch-concurrency must be a positive integer");
    }

    return parsed;
}

function decode(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

function runCurlJson<T>(url: string): T {
    const result = Bun.spawnSync({
        cmd: ["curl", "-sS", "--compressed", "--max-time", String(CURL_MAX_TIME_SECONDS), url],
        stderr: "pipe",
        stdout: "pipe",
    });

    if (result.exitCode !== 0) {
        const errorOutput = decode(result.stderr).trim() || `curl exited with ${result.exitCode}`;
        throw new Error(errorOutput);
    }

    return JSON.parse(decode(result.stdout)) as T;
}

function fieldMap(span: JaegerSpan): Map<string, unknown> {
    const map = new Map<string, unknown>();
    for (const tag of span.tags ?? []) {
        map.set(tag.key, tag.value);
    }
    return map;
}

function contextEventAttributes(log: JaegerLog): Record<string, string | number | boolean> {
    const attributes: Record<string, string | number | boolean> = {};
    for (const field of log.fields ?? []) {
        if (!field.key || field.value === undefined || field.value === null) {
            continue;
        }
        if (
            typeof field.value === "string"
            || typeof field.value === "number"
            || typeof field.value === "boolean"
        ) {
            attributes[field.key] = field.value;
        } else {
            attributes[field.key] = JSON.stringify(field.value);
        }
    }
    return attributes;
}

function asString(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (value === undefined || value === null) {
        return "";
    }
    return String(value);
}

function asNumber(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return 0;
}

function normalizeProvider(rawValues: Array<string>): string {
    for (const raw of rawValues) {
        const candidate = raw.toLowerCase();
        if (!candidate) {
            continue;
        }
        if (candidate.includes("anthropic")) {
            return "anthropic";
        }
        if (candidate.includes("openrouter")) {
            return "openrouter";
        }
        if (candidate.includes("ollama")) {
            return "ollama";
        }
        if (candidate.includes("openai")) {
            return "openai";
        }
        if (candidate.includes("codex")) {
            return "codex";
        }
        return candidate.split(/[.:/]/)[0];
    }
    return "unknown";
}

function stableStringify(value: unknown): string {
    if (value === null || value === undefined) {
        return "null";
    }
    if (typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function hashMessage(value: unknown): string {
    return createHash("sha1").update(stableStringify(value)).digest("hex");
}

function formatInt(value: number): string {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatPct(value: number): string {
    return `${value.toFixed(1)}%`;
}

function dayLabel(usTimestamp: number): string {
    return new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: TIME_ZONE,
    }).format(new Date(usTimestamp / 1000));
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;");
}

function truncate(value: string, maxLength = 220): string {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 3)}...`;
}

function previewForMessage(message: ModelMessage): string {
    if (typeof message.content === "string") {
        return truncate(message.content.replace(/\s+/g, " ").trim());
    }

    const chunks: string[] = [];
    for (const part of message.content) {
        switch (part.type) {
            case "text":
            case "reasoning":
                chunks.push(part.text);
                break;
            case "tool-call":
                chunks.push(`tool-call:${part.toolName} ${stableStringify(part.input)}`);
                break;
            case "tool-result":
                chunks.push(`tool-result:${part.toolName} ${stableStringify(part.output)}`);
                break;
            case "file":
                chunks.push(`file:${part.filename ?? "unnamed"} ${part.mediaType}`);
                break;
            case "tool-approval-response":
                chunks.push("tool-approval-response");
                break;
        }
    }
    return truncate(chunks.join(" ").replace(/\s+/g, " ").trim());
}

function classifyMessage(message: ModelMessage): string {
    const preview = previewForMessage(message);
    if (message.role === "system") {
        if (preview.includes("# Your Identity")) {
            return "system:identity";
        }
        if (preview.includes("## Your Home Directory")) {
            return "system:home-directory";
        }
        if (preview.includes("## Project Context")) {
            return "system:project-context";
        }
        return "system";
    }

    if (Array.isArray(message.content)) {
        if (message.content.some((part) => part.type === "tool-result")) {
            return "tool-result";
        }
        if (message.content.some((part) => part.type === "tool-call")) {
            return "tool-call";
        }
    }

    if (preview.includes("<system-reminders>")) {
        return `${message.role}:system-reminders`;
    }

    return message.role;
}

function traceLink(uiUrl: string, traceId: string, spanId: string): string {
    return `${uiUrl}/trace/${traceId}?uiFind=${spanId}`;
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
            if (queryLimit > 1) {
                const smallerLimit = Math.max(1, Math.floor(queryLimit / 2));
                if (smallerLimit < queryLimit) {
                    console.error(
                        `Timeout retry ${service} ${dayLabel(startUs)} -> ${dayLabel(endUs)} limit ${smallerLimit}`
                    );
                    return fetchTraceWindow(jaegerUrl, service, startUs, endUs, smallerLimit, depth + 1);
                }
            }

            if (span > MIN_WINDOW_US) {
                const midpoint = Math.floor((startUs + endUs) / 2);
                if (midpoint > startUs && midpoint < endUs) {
                    console.error(
                        `Timeout split ${service} ${dayLabel(startUs)} -> ${dayLabel(endUs)}`
                    );
                    const left = await fetchTraceWindow(jaegerUrl, service, startUs, midpoint, queryLimit, depth + 1);
                    const right = await fetchTraceWindow(
                        jaegerUrl,
                        service,
                        midpoint + 1,
                        endUs,
                        queryLimit,
                        depth + 1
                    );
                    return [...left, ...right];
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

    console.error(`Split ${service} ${dayLabel(startUs)} -> ${dayLabel(endUs)} at depth ${depth}`);
    const left = await fetchTraceWindow(jaegerUrl, service, startUs, midpoint, queryLimit, depth + 1);
    const right = await fetchTraceWindow(jaegerUrl, service, midpoint + 1, endUs, queryLimit, depth + 1);
    return [...left, ...right];
}

function parsePromptMessages(rawPrompt: string): ModelMessage[] | null {
    try {
        const parsed = JSON.parse(rawPrompt);
        if (!Array.isArray(parsed)) {
            return null;
        }
        return parsed as ModelMessage[];
    } catch {
        return null;
    }
}

function traceConversationId(trace: JaegerTrace): string {
    for (const span of trace.spans ?? []) {
        const map = fieldMap(span);
        const conversationId = asString(map.get("conversation.id"));
        if (conversationId) {
            return conversationId;
        }
    }
    return "unknown";
}

function pairedContextEvents(trace: JaegerTrace, doStreamSpan: JaegerSpan): ContextEvent[] {
    const candidates = (trace.spans ?? [])
        .filter((span) => span.operationName === CONTEXT_SPAN_NAME && span.startTime <= doStreamSpan.startTime)
        .sort((left, right) => right.startTime - left.startTime);
    const paired = candidates[0];
    if (!paired) {
        return [];
    }
    return (paired.logs ?? []).map((log) => ({
        attributes: contextEventAttributes(log),
        name: asString(contextEventAttributes(log).event),
        sourceContextKey: `${trace.traceID}:${paired.spanID}`,
        timestamp: log.timestamp ?? paired.startTime,
    }));
}

function buildCarrySpanRecord(uiUrl: string, service: string, trace: JaegerTrace, span: JaegerSpan): CarrySpanRecord | null {
    const tags = fieldMap(span);
    const rawPrompt = asString(tags.get("ai.prompt.messages"));
    const promptMessages = parsePromptMessages(rawPrompt);
    if (!promptMessages) {
        return null;
    }

    const normalizedMessages = normalizeMessagesForContextManagement(promptMessages);
    const estimator = createDefaultPromptTokenEstimator();
    const messages = normalizedMessages.map((message, index) => ({
        classification: classifyMessage(message),
        estimatedTokens: estimator.estimateMessage(message as never),
        followingMessages: normalizedMessages.length - index - 1,
        hash: hashMessage(message),
        index,
        preview: previewForMessage(message),
        role: message.role,
    }));

    const provider = normalizeProvider([
        asString(tags.get("ai.telemetry.metadata.llm.provider")),
        asString(tags.get("ai.model.provider")),
        asString(tags.get("gen_ai.system")),
    ]);
    const agent =
        asString(tags.get("ai.telemetry.metadata.agent.slug"))
        || asString(fieldMap(trace.spans?.find((item) => item.operationName === CONTEXT_SPAN_NAME) ?? span).get("agent.slug"))
        || "unknown";

    return {
        agent,
        contextEvents: pairedContextEvents(trace, span),
        conversationId: traceConversationId(trace),
        inputTokens: asNumber(tags.get("ai.usage.inputTokens"))
            || asNumber(tags.get("ai.usage.promptTokens"))
            || asNumber(tags.get("gen_ai.usage.input_tokens")),
        messages,
        model:
            asString(tags.get("ai.model.id"))
            || asString(tags.get("gen_ai.request.model"))
            || "unknown",
        provider,
        service,
        spanId: span.spanID,
        timestampUs: span.startTime,
        traceId: span.traceID,
        traceUrl: traceLink(uiUrl, span.traceID, span.spanID),
    };
}

function sourceSelectionSummary(sourceSpans: SourceUsageSpan[], maxTraces: number, coverageTarget: number): {
    selectedTraceIds: string[];
    summary: SelectionSummary;
} {
    const traceStats = new Map<string, {
        inputTokens: number;
        spanCount: number;
    }>();

    let totalInputTokens = 0;

    for (const span of sourceSpans) {
        const traceId = span.traceId ?? "";
        if (!traceId) {
            continue;
        }
        const inputTokens = asNumber(span.inputTokens);
        totalInputTokens += inputTokens;
        const stats = traceStats.get(traceId) ?? {
            inputTokens: 0,
            spanCount: 0,
        };
        stats.inputTokens += inputTokens;
        stats.spanCount += 1;
        traceStats.set(traceId, stats);
    }

    const ranked = [...traceStats.entries()]
        .sort((left, right) => right[1].inputTokens - left[1].inputTokens);

    const selectedTraceIds: string[] = [];
    let selectedInputTokens = 0;
    let selectedSpanCount = 0;

    for (const [traceId, stats] of ranked) {
        selectedTraceIds.push(traceId);
        selectedInputTokens += stats.inputTokens;
        selectedSpanCount += stats.spanCount;
        if (selectedTraceIds.length >= maxTraces || selectedInputTokens / Math.max(totalInputTokens, 1) >= coverageTarget) {
            break;
        }
    }

    return {
        selectedTraceIds,
        summary: {
            coveragePct: selectedInputTokens / Math.max(totalInputTokens, 1),
            selectedInputTokens,
            selectedSpanCount,
            selectedTraceCount: selectedTraceIds.length,
            totalInputTokens,
            totalTraceCount: ranked.length,
        },
    };
}

async function fetchTraceById(jaegerUrl: string, traceId: string): Promise<JaegerTrace | null> {
    const response = runCurlJson<JaegerResponse>(`${jaegerUrl}/api/traces/${traceId}`);
    return response.data?.[0] ?? null;
}

async function collectCarrySpansFromSource(args: ParsedArgs): Promise<{
    endUs: number;
    selectionSummary: SelectionSummary;
    services: string[];
    spans: CarrySpanRecord[];
    startUs: number;
}> {
    const source = JSON.parse(await readFile(args.sourceJson, "utf8")) as SourceUsageReport;
    const sourceSpans = source.spans ?? [];
    const { selectedTraceIds, summary } = sourceSelectionSummary(sourceSpans, args.maxTraces, args.coverage);

    const traceSeedById = new Map<string, SourceUsageSpan>();
    for (const span of sourceSpans) {
        const traceId = span.traceId ?? "";
        if (traceId && !traceSeedById.has(traceId)) {
            traceSeedById.set(traceId, span);
        }
    }

    console.error(
        `Selected ${summary.selectedTraceCount}/${summary.totalTraceCount} traces covering ${formatPct(summary.coveragePct * 100)} of ${formatInt(summary.totalInputTokens)} input tokens`
    );

    const records = new Map<string, CarrySpanRecord>();
    const services = new Set<string>();

    for (let index = 0; index < selectedTraceIds.length; index += args.traceFetchConcurrency) {
        const batch = selectedTraceIds.slice(index, index + args.traceFetchConcurrency);
        const traces = await Promise.all(
            batch.map(async (traceId) => {
                const seed = traceSeedById.get(traceId);
                console.error(
                    `Fetching trace ${traceId} ${seed?.provider ?? "unknown"} ${seed?.agent ?? "unknown"} ${formatInt(asNumber(seed?.inputTokens))} tokens`
                );
                return fetchTraceById(args.jaegerUrl, traceId);
            })
        );

        for (const trace of traces) {
            if (!trace) {
                continue;
            }
            for (const span of trace.spans ?? []) {
                if (span.operationName !== OPERATION_NAME) {
                    continue;
                }
                const service =
                    asString(fieldMap(trace.spans?.find((item) => item.spanID === span.spanID) ?? span).get("service.name"))
                    || asString(traceSeedById.get(trace.traceID)?.service)
                    || "unknown";
                const record = buildCarrySpanRecord(args.uiUrl, service, trace, span);
                if (record) {
                    services.add(record.service);
                    records.set(`${record.traceId}:${record.spanId}`, record);
                }
            }
        }
    }

    const timestamps = sourceSpans
        .map((span) => asNumber(span.timestampUs))
        .filter((timestamp) => timestamp > 0);

    return {
        endUs: Math.max(...timestamps, Date.now() * 1000),
        selectionSummary: summary,
        services: [...services].sort(),
        spans: [...records.values()].sort((left, right) => left.timestampUs - right.timestampUs),
        startUs: Math.min(...timestamps, Date.now() * 1000),
    };
}

async function collectCarrySpans(args: ParsedArgs): Promise<{
    endUs: number;
    selectionSummary: SelectionSummary;
    services: string[];
    spans: CarrySpanRecord[];
    startUs: number;
}> {
    try {
        return await collectCarrySpansFromSource(args);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Falling back to full Jaeger scan: ${message}`);
    }

    const services = await fetchServices(args.jaegerUrl);
    const targetServices: string[] = [];
    for (const service of services) {
        const operations = await fetchOperations(args.jaegerUrl, service);
        if (operations.includes(OPERATION_NAME)) {
            targetServices.push(service);
        }
    }

    const endUs = Date.now() * 1000;
    const startUs = endUs - Math.round(args.days * 24 * 60 * 60 * 1_000_000);
    const records = new Map<string, CarrySpanRecord>();

    for (const service of targetServices) {
        console.error(`Fetching ${service} from ${dayLabel(startUs)} to ${dayLabel(endUs)}`);
        const windows: Array<{ end: number; start: number }> = [];
        for (let windowStart = startUs; windowStart < endUs; windowStart += BASE_WINDOW_US) {
            windows.push({
                end: Math.min(windowStart + BASE_WINDOW_US - 1, endUs),
                start: windowStart,
            });
        }

        for (let index = 0; index < windows.length; index += WINDOW_CONCURRENCY) {
            const batch = windows.slice(index, index + WINDOW_CONCURRENCY);
            const batchResults = await Promise.all(
                batch.map(async (window) => {
                    console.error(`  Window ${dayLabel(window.start)} -> ${dayLabel(window.end)}`);
                    const traces = await fetchTraceWindow(
                        args.jaegerUrl,
                        service,
                        window.start,
                        window.end,
                        args.queryLimit
                    );
                    return { traces, window };
                })
            );

            for (const { traces } of batchResults) {
                for (const trace of traces) {
                    for (const span of trace.spans ?? []) {
                        if (span.operationName !== OPERATION_NAME) {
                            continue;
                        }
                        if (span.startTime < startUs || span.startTime > endUs) {
                            continue;
                        }
                        const record = buildCarrySpanRecord(args.uiUrl, service, trace, span);
                        if (record) {
                            records.set(`${record.traceId}:${record.spanId}`, record);
                        }
                    }
                }
            }
        }
    }

    return {
        endUs,
        selectionSummary: {
            coveragePct: 1,
            selectedInputTokens: 0,
            selectedSpanCount: records.size,
            selectedTraceCount: 0,
            totalInputTokens: 0,
            totalTraceCount: 0,
        },
        services: targetServices,
        spans: [...records.values()].sort((left, right) => left.timestampUs - right.timestampUs),
        startUs,
    };
}

function median(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return sorted[middle];
}

function aggregateMessages(spans: CarrySpanRecord[]): Map<string, MessageAggregate> {
    const byThread = new Map<string, CarrySpanRecord[]>();

    for (const span of spans) {
        const threadKey = `${span.conversationId}::${span.agent}`;
        const list = byThread.get(threadKey) ?? [];
        list.push(span);
        byThread.set(threadKey, list);
    }

    const aggregates = new Map<string, MessageAggregate>();

    for (const [threadKey, threadSpans] of byThread) {
        threadSpans.sort((left, right) => left.timestampUs - right.timestampUs);
        const occurrences = new Map<
            string,
            Array<{ entry: MessageEntry; spanIndex: number; timestampUs: number; traceId: string; traceUrl: string }>
        >();

        for (const [spanIndex, span] of threadSpans.entries()) {
            for (const entry of span.messages) {
                const list = occurrences.get(entry.hash) ?? [];
                list.push({
                    entry,
                    spanIndex,
                    timestampUs: span.timestampUs,
                    traceId: span.traceId,
                    traceUrl: span.traceUrl,
                });
                occurrences.set(entry.hash, list);

                const aggregate = aggregates.get(entry.hash) ?? {
                    classification: entry.classification,
                    estimatedTokens: entry.estimatedTokens,
                    maxCarrySpans: 0,
                    maxFollowingMessages: 0,
                    occurrences: 0,
                    preview: entry.preview,
                    role: entry.role,
                    runs: [],
                    threads: new Set<string>(),
                };

                aggregate.occurrences += 1;
                aggregate.maxFollowingMessages = Math.max(aggregate.maxFollowingMessages, entry.followingMessages);
                aggregate.threads.add(threadKey);
                aggregates.set(entry.hash, aggregate);
            }
        }

        for (const [hash, items] of occurrences) {
            items.sort((left, right) => left.spanIndex - right.spanIndex);
            let runStart = 0;

            const flushRun = (startIndex: number, endIndex: number) => {
                const first = items[startIndex];
                const last = items[endIndex];
                const aggregate = aggregates.get(hash);
                if (!aggregate) {
                    return;
                }
                const runLength = last.spanIndex - first.spanIndex + 1;
                const persistedToThreadEnd = last.spanIndex === threadSpans.length - 1;
                aggregate.maxCarrySpans = Math.max(aggregate.maxCarrySpans, runLength - 1);
                aggregate.runs.push({
                    agent: threadSpans[last.spanIndex].agent,
                    conversationId: threadSpans[last.spanIndex].conversationId,
                    count: runLength,
                    endFollowingMessages: last.entry.followingMessages,
                    endTimestampUs: last.timestampUs,
                    persistedToThreadEnd,
                    provider: threadSpans[last.spanIndex].provider,
                    startTimestampUs: first.timestampUs,
                    traceId: first.traceId,
                    traceUrl: first.traceUrl,
                });
            };

            for (let index = 1; index < items.length; index += 1) {
                if (items[index].spanIndex !== items[index - 1].spanIndex + 1) {
                    flushRun(runStart, index - 1);
                    runStart = index;
                }
            }
            flushRun(runStart, items.length - 1);
        }
    }

    return aggregates;
}

function summarizeContext(spans: CarrySpanRecord[]) {
    const toolDecay = {
        applied: 0,
        inputPlaceholderCount: 0,
        outputPlaceholderCount: 0,
        skipped: 0,
        total: 0,
    };
    const summarization = {
        applied: 0,
        messagesSummarized: 0,
        skipped: 0,
        total: 0,
    };
    const runtimes = {
        count: 0,
        tokensSavedTotal: 0,
        runtimesWithSavings: 0,
    };

    const seenEvents = new Set<string>();

    for (const span of spans) {
        for (const event of span.contextEvents) {
            const eventKey = `${event.sourceContextKey}:${event.name}:${event.timestamp}`;
            if (seenEvents.has(eventKey)) {
                continue;
            }
            seenEvents.add(eventKey);

            if (event.name === "context_management.strategy_complete.tool-result-decay") {
                toolDecay.total += 1;
                if (asString(event.attributes["context_management.outcome"]) === "applied") {
                    toolDecay.applied += 1;
                } else {
                    toolDecay.skipped += 1;
                }
                toolDecay.outputPlaceholderCount += asNumber(event.attributes["context_management.placeholder_tool_result_count"]);
                toolDecay.inputPlaceholderCount += asNumber(event.attributes["context_management.placeholder_tool_input_count"]);
            } else if (event.name === "context_management.strategy_complete.summarization") {
                summarization.total += 1;
                if (asString(event.attributes["context_management.outcome"]) === "applied") {
                    summarization.applied += 1;
                } else {
                    summarization.skipped += 1;
                }
                summarization.messagesSummarized += asNumber(event.attributes["context_management.messages_summarized_count"]);
            } else if (event.name === "context_management.runtime_complete") {
                runtimes.count += 1;
                const tokensSaved = asNumber(event.attributes["context_management.tokens_saved"]);
                runtimes.tokensSavedTotal += tokensSaved;
                if (tokensSaved > 0) {
                    runtimes.runtimesWithSavings += 1;
                }
            }
        }
    }

    return { runtimes, summarization, toolDecay };
}

function providerColorMap(providers: string[]): Map<string, string> {
    const map = new Map<string, string>();
    providers.forEach((provider, index) => {
        map.set(provider, PROVIDER_COLORS[index % PROVIDER_COLORS.length]);
    });
    return map;
}

function renderTable(headers: string[], rows: string[][]): string {
    return `
        <div class="table-wrap">
            <table>
                <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
                <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>
            </table>
        </div>
    `;
}

function renderSummaryCards(cards: Array<{ label: string; note: string; value: string }>): string {
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

function renderBarChart(
    title: string,
    subtitle: string,
    rows: Array<{ color: string; extra: string; label: string; value: number }>
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
                                <div class="hbar-track"><div class="hbar-fill" style="width:${width}%;background:${row.color}"></div></div>
                                <div class="hbar-value">${formatInt(row.value)}</div>
                                <div class="hbar-extra">${escapeHtml(row.extra)}</div>
                            </div>
                        `;
                    })
                    .join("")}
            </div>
        </section>
    `;
}

function renderReport(
    args: ParsedArgs,
    services: string[],
    spans: CarrySpanRecord[],
    startUs: number,
    endUs: number,
    selectionSummary: SelectionSummary
): string {
    const aggregates = aggregateMessages(spans);
    const contextSummary = summarizeContext(spans);
    const aggregateRows = [...aggregates.entries()].map(([hash, aggregate]) => ({
        cumulativeEstimatedTokens: aggregate.estimatedTokens * aggregate.occurrences,
        hash,
        ...aggregate,
    }));

    const topBySize = [...aggregateRows]
        .sort((left, right) => right.estimatedTokens - left.estimatedTokens)
        .slice(0, 20);
    const topByCumulative = [...aggregateRows]
        .sort((left, right) => right.cumulativeEstimatedTokens - left.cumulativeEstimatedTokens)
        .slice(0, 20);
    const largeNonSystem = aggregateRows.filter((item) => item.estimatedTokens >= LARGE_MESSAGE_THRESHOLD && !item.role.startsWith("system"));
    const quickDropRuns = largeNonSystem.flatMap((item) => item.runs).filter((run) => !run.persistedToThreadEnd && run.count - 1 <= 3).length;
    const totalLargeNonSystemRuns = largeNonSystem.flatMap((item) => item.runs).length;
    const topCumulativeSystemShare = topByCumulative.filter((item) => item.role === "system").length / Math.max(topByCumulative.length, 1);

    const providerCounts = new Map<string, number>();
    for (const span of spans) {
        providerCounts.set(span.provider, (providerCounts.get(span.provider) ?? 0) + 1);
    }
    const providers = [...providerCounts.entries()].sort((left, right) => right[1] - left[1]).map(([provider]) => provider);
    const colorMap = providerColorMap(providers);

    const topSizeRows = topBySize.map((item) => {
        const medianCarry = median(item.runs.map((run) => run.count - 1));
        return [
            escapeHtml(item.classification),
            escapeHtml(item.role),
            formatInt(item.estimatedTokens),
            formatInt(item.occurrences),
            formatInt(item.cumulativeEstimatedTokens),
            `${medianCarry.toFixed(1)} spans`,
            formatInt(item.maxCarrySpans),
            formatInt(item.maxFollowingMessages),
            `<a href="${escapeHtml(item.runs[0]?.traceUrl ?? "#")}" target="_blank" rel="noreferrer">${escapeHtml(item.runs[0]?.traceId ?? item.hash.slice(0, 12))}</a>`,
            escapeHtml(item.preview),
        ];
    });

    const topCarryRows = [...largeNonSystem]
        .sort((left, right) => right.maxCarrySpans - left.maxCarrySpans)
        .slice(0, 20)
        .map((item) => [
            escapeHtml(item.classification),
            formatInt(item.estimatedTokens),
            formatInt(item.maxCarrySpans),
            formatInt(Math.round(median(item.runs.map((run) => run.count - 1)))),
            formatInt(item.maxFollowingMessages),
            item.runs.some((run) => run.persistedToThreadEnd) ? "yes" : "no",
            escapeHtml(item.preview),
        ]);

    const topCumulativeRows = topByCumulative.map((item) => [
        escapeHtml(item.classification),
        formatInt(item.estimatedTokens),
        formatInt(item.occurrences),
        formatInt(item.cumulativeEstimatedTokens),
        formatInt(item.threads.size),
        escapeHtml(item.preview),
    ]);

    const providerBars = providers.map((provider) => ({
        color: colorMap.get(provider)!,
        extra: `${formatInt(providerCounts.get(provider) ?? 0)} spans`,
        label: provider,
        value: spans
            .filter((span) => span.provider === provider)
            .reduce((sum, span) => sum + span.messages.reduce((messageSum, message) => messageSum + message.estimatedTokens, 0), 0),
    }));

    const verdict =
        topCumulativeSystemShare >= 0.5
            ? "Partially. The largest prompt-cost culprits are mostly static system messages, so ai-sdk-context-management is not the main lever for the biggest individual message costs. The decay/summarization machinery appears to be trimming dynamic context, but it cannot remove the dominant static prompts."
            : totalLargeNonSystemRuns > 0 && quickDropRuns / totalLargeNonSystemRuns >= 0.6
                ? "Mostly yes. Large non-system messages are usually dropped within a few subsequent doStream calls, and the decay telemetry shows placeholders/savings happening at runtime."
                : "Not convincingly. Large non-system messages are hanging around long enough that the decay/summarization strategies do not appear to be curtailing them aggressively."
        ;

    return `
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Jaeger Context Management Report</title>
    <style>
        :root {
            --bg: #f7f3eb;
            --panel: #fffdf9;
            --ink: #14213d;
            --muted: #5f6c7b;
            --grid: #ded5c7;
            --accent: #c1121f;
            --accent-soft: rgba(193, 18, 31, 0.12);
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            background:
                radial-gradient(circle at top left, rgba(42, 157, 143, 0.12), transparent 28rem),
                radial-gradient(circle at top right, rgba(193, 18, 31, 0.08), transparent 24rem),
                var(--bg);
            color: var(--ink);
            font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
            line-height: 1.45;
        }
        main { max-width: 1500px; margin: 0 auto; padding: 32px 24px 80px; }
        .hero, .panel, .summary-card, .callout { border: 1px solid var(--grid); border-radius: 22px; background: var(--panel); box-shadow: 0 14px 40px rgba(20, 34, 61, 0.05); }
        .hero { padding: 24px 28px; display: grid; gap: 16px; margin-bottom: 24px; }
        .eyebrow, .summary-label, th, .hbar-label, .hbar-value, .hbar-extra, .small {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }
        .eyebrow, .summary-label, th { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
        h1, h2 { margin: 0; letter-spacing: -0.02em; }
        h1 { font-size: clamp(2rem, 3vw, 3rem); max-width: 18ch; }
        p { margin: 0; color: var(--muted); }
        .summary-grid, .two-up { display: grid; gap: 16px; }
        .summary-grid { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom: 22px; }
        .two-up { grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); margin-bottom: 22px; }
        .summary-card { padding: 18px; }
        .summary-value { margin-top: 8px; font-size: 1.9rem; font-weight: 700; }
        .summary-note { margin-top: 6px; font-size: 14px; color: var(--muted); }
        .panel { padding: 20px; }
        .panel-heading { display: grid; gap: 6px; margin-bottom: 16px; }
        .callout { padding: 16px 18px; border-left: 4px solid var(--accent); background: var(--accent-soft); margin-bottom: 22px; }
        .hbars { display: grid; gap: 12px; }
        .hbar-row { display: grid; grid-template-columns: minmax(130px, 180px) minmax(180px, 1fr) minmax(90px, 110px) minmax(110px, 150px); gap: 12px; align-items: center; }
        .hbar-track { height: 16px; border-radius: 999px; background: rgba(95, 108, 123, 0.15); overflow: hidden; }
        .hbar-fill { height: 100%; border-radius: 999px; }
        .table-wrap { overflow-x: auto; border: 1px solid var(--grid); border-radius: 16px; background: rgba(255,255,255,0.42); }
        table { width: 100%; border-collapse: collapse; min-width: 920px; }
        th, td { padding: 11px 14px; border-bottom: 1px solid rgba(222,213,199,0.72); text-align: left; vertical-align: top; }
        td { font-size: 14px; }
        th { background: rgba(20, 34, 61, 0.03); position: sticky; top: 0; }
        a { color: var(--accent); text-decoration: none; font-weight: 600; }
        a:hover { text-decoration: underline; }
        @media (max-width: 880px) {
            main { padding: 24px 16px 64px; }
            .two-up { grid-template-columns: 1fr; }
            .hbar-row { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
<main>
    <section class="hero">
        <div class="eyebrow">Jaeger context carry report</div>
        <h1>Are large prompt messages actually getting buried and removed?</h1>
        <p>This report analyzes doStream prompt payloads from Jaeger, estimates per-message token weight with the same default estimator TENEX uses for context management, and measures how long large messages stay present across conversation-agent threads.</p>
        <div class="small">Window: ${escapeHtml(dayLabel(startUs))} to ${escapeHtml(dayLabel(endUs))} (${escapeHtml(TIME_ZONE)}). Services: ${escapeHtml(services.join(", "))}.</div>
        <div class="small">Trace coverage for detailed carry analysis: ${formatInt(selectionSummary.selectedTraceCount)} of ${formatInt(selectionSummary.totalTraceCount)} traces, representing ${formatPct(selectionSummary.coveragePct * 100)} of 4-day input tokens.</div>
    </section>

    ${renderSummaryCards([
        {
            label: "Trace coverage",
            note: `${formatInt(selectionSummary.selectedTraceCount)} traces / ${formatInt(selectionSummary.selectedSpanCount)} source spans`,
            value: formatPct(selectionSummary.coveragePct * 100),
        },
        {
            label: "doStream spans",
            note: "Prompt payloads parsed from ai.prompt.messages",
            value: formatInt(spans.length),
        },
        {
            label: "Unique messages",
            note: "Exact message hashes across all prompts",
            value: formatInt(aggregateRows.length),
        },
        {
            label: "Large non-system msgs",
            note: `Estimated at >= ${formatInt(LARGE_MESSAGE_THRESHOLD)} tokens`,
            value: formatInt(largeNonSystem.length),
        },
        {
            label: "Quickly dropped",
            note: totalLargeNonSystemRuns === 0 ? "No large non-system runs" : `${formatPct((quickDropRuns / totalLargeNonSystemRuns) * 100)} removed within 3 later doStreams`,
            value: formatInt(quickDropRuns),
        },
        {
            label: "Tool decay placeholders",
            note: `Outputs ${formatInt(contextSummary.toolDecay.outputPlaceholderCount)} / Inputs ${formatInt(contextSummary.toolDecay.inputPlaceholderCount)}`,
            value: formatInt(contextSummary.toolDecay.total),
        },
        {
            label: "Runtime tokens saved",
            note: `${formatInt(contextSummary.runtimes.runtimesWithSavings)} runtimes saved >0 tokens`,
            value: formatInt(contextSummary.runtimes.tokensSavedTotal),
        },
    ])}

    <div class="callout"><strong>Verdict:</strong> ${escapeHtml(verdict)}</div>

    <div class="two-up">
        ${renderBarChart(
            "Cumulative message cost by provider",
            "Estimated per-message tokens multiplied by every prompt occurrence. This is not the span input total; it isolates message carry cost.",
            providerBars
        )}
        ${renderBarChart(
            "Top individual messages by size",
            "Largest single messages by estimated token weight, regardless of how often they recur.",
            topBySize.slice(0, 8).map((item) => ({
                color: colorMap.get(item.runs[0]?.provider ?? providers[0] ?? "anthropic") ?? "#c1121f",
                extra: item.classification,
                label: truncate(item.preview, 42),
                value: item.estimatedTokens,
            }))
        )}
    </div>

    <section class="panel" style="margin-bottom:22px;">
        <div class="panel-heading">
            <h2>Context-management telemetry</h2>
            <p>These counts come from the paired <code>tenex.context_management</code> span logs that sit next to doStream spans in the same Jaeger traces.</p>
        </div>
        ${renderTable(
            ["Metric", "Value"],
            [
                ["Tool-result-decay strategy events", formatInt(contextSummary.toolDecay.total)],
                ["Tool-result-decay applied", formatInt(contextSummary.toolDecay.applied)],
                ["Tool-result-decay skipped", formatInt(contextSummary.toolDecay.skipped)],
                ["Placeholdered tool outputs", formatInt(contextSummary.toolDecay.outputPlaceholderCount)],
                ["Placeholdered tool inputs", formatInt(contextSummary.toolDecay.inputPlaceholderCount)],
                ["Summarization strategy events", formatInt(contextSummary.summarization.total)],
                ["Summarization applied", formatInt(contextSummary.summarization.applied)],
                ["Messages summarized", formatInt(contextSummary.summarization.messagesSummarized)],
                ["Runtime-complete events", formatInt(contextSummary.runtimes.count)],
                ["Runtime-complete tokens saved", formatInt(contextSummary.runtimes.tokensSavedTotal)],
            ]
        )}
    </section>

    <section class="panel" style="margin-bottom:22px;">
        <div class="panel-heading">
            <h2>Top individual messages by size</h2>
            <p>These are the largest single prompt messages, with carry-through stats showing how many later doStream calls they survive.</p>
        </div>
        ${renderTable(
            ["Classification", "Role", "Est. tokens", "Occurrences", "Cumulative est. tokens", "Median carry", "Max carry", "Max buried under", "Sample trace", "Preview"],
            topSizeRows
        )}
    </section>

    <section class="panel" style="margin-bottom:22px;">
        <div class="panel-heading">
            <h2>Top messages by cumulative carry cost</h2>
            <p>Big messages that recur many times are the ones that matter most for overall prompt pressure.</p>
        </div>
        ${renderTable(
            ["Classification", "Est. tokens", "Occurrences", "Cumulative est. tokens", "Threads", "Preview"],
            topCumulativeRows
        )}
    </section>

    <section class="panel" style="margin-bottom:22px;">
        <div class="panel-heading">
            <h2>Large non-system messages with the longest carry</h2>
            <p>This is the closest view of whether decay/summarization are letting big dynamic messages linger too long.</p>
        </div>
        ${renderTable(
            ["Classification", "Est. tokens", "Max carried spans", "Median carried spans", "Max buried under", "Persists to thread end", "Preview"],
            topCarryRows
        )}
    </section>

    <section class="small">
        Generated ${escapeHtml(dayLabel(Date.now() * 1000))}. Message token estimates use <code>ai-sdk-context-management</code>'s default estimator from version <code>0.8.3</code>.
    </section>
</main>
</body>
</html>
    `;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const { endUs, selectionSummary, services, spans, startUs } = await collectCarrySpans(args);
    const reportHtml = renderReport(args, services, spans, startUs, endUs, selectionSummary);

    await mkdir(dirname(args.htmlOut), { recursive: true });
    await mkdir(dirname(args.jsonOut), { recursive: true });

    await writeFile(args.htmlOut, reportHtml, "utf8");
    await writeFile(
        args.jsonOut,
        JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                selectionSummary,
                services,
                spans,
                startUs,
                endUs,
            },
            null,
            2
        ),
        "utf8"
    );

    console.log(`HTML report: ${args.htmlOut}`);
    console.log(`JSON data:   ${args.jsonOut}`);
    console.log(`Spans:       ${formatInt(spans.length)}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
