#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
    LanguageModelV3Message,
    LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import {
    ToolResultDecayStrategy,
    createDefaultPromptTokenEstimator,
} from "ai-sdk-context-management";

type ParsedArgs = {
    cacheDir: string;
    coverage: number;
    htmlOut: string;
    jaegerUrl: string;
    jsonOut: string;
    maxTraces: number;
    sourceJson: string;
    traceFetchConcurrency: number;
};

type SourceUsageSpan = {
    agent?: string;
    inputTokens?: number;
    model?: string;
    provider?: string;
    service?: string;
    timestampUs?: number;
    traceId?: string;
};

type SourceUsageReport = {
    spans?: SourceUsageSpan[];
};

type ContextReplaySource = {
    selectionSummary?: TraceSelectionSummary;
    spans?: Array<SpanRecord & { contextEvents?: unknown[]; traceUrl?: string }>;
};

type JaegerField = {
    key: string;
    value?: unknown;
};

type JaegerSpan = {
    operationName: string;
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

type TraceSeed = {
    agent: string;
    inputTokens: number;
    model: string;
    provider: string;
    service: string;
    timestampUs: number;
    traceId: string;
};

type TraceSelectionSummary = {
    coveragePct: number;
    selectedInputTokens: number;
    selectedTraceCount: number;
    totalInputTokens: number;
    totalTraceCount: number;
};

type SpanRecord = {
    agent: string;
    conversationId: string;
    inputTokens: number;
    messages: LanguageModelV3Prompt;
    model: string;
    provider: string;
    service: string;
    spanId: string;
    timestampUs: number;
    traceId: string;
};

type VariantSpec = {
    description: string;
    id: string;
    name: string;
    options?: Record<string, unknown>;
};

type CandidateMessage = {
    classification: string;
    estimatedTokens: number;
    hash: string;
    preview: string;
    role: string;
    sampleSpanId: string;
    sampleTraceId: string;
};

type SpanSimulationResult = {
    afterTokens: number;
    changed: boolean;
    presentCandidateHashes: Set<string>;
    removedToolExchangeCount: number;
};

type CandidateRun = {
    count: number;
    endSpanId: string;
    endTimestampUs: number;
    persistedToThreadEnd: boolean;
    startSpanId: string;
    startTimestampUs: number;
    traceId: string;
};

type CandidateVariantStats = {
    cumulativeEstimatedTokens: number;
    maxCarrySpans: number;
    occurrences: number;
    persistedToThreadEnd: boolean;
    runs: CandidateRun[];
};

type VariantSummary = {
    avgTokensPerSpan: number;
    changedSpans: number;
    id: string;
    maxCarryLargeToolResult: number;
    meanSavingsPerChangedSpan: number;
    name: string;
    spansWithSavings: number;
    totalAfterTokens: number;
    totalRemovedToolExchanges: number;
    totalSavingsTokens: number;
    totalToolRunsOver20Spans: number;
};

type VariantComparisonRow = {
    baselineMaxCarry: number;
    baselineOccurrences: number;
    classification: string;
    estimatedTokens: number;
    hash: string;
    preview: string;
    role: string;
    sampleSpanId: string;
    sampleTraceId: string;
    variants: Record<string, CandidateVariantStats>;
};

type ReplayReport = {
    baselineEstimatedTokens: number;
    candidateCount: number;
    generatedAt: string;
    selectionSummary: TraceSelectionSummary;
    spanCount: number;
    traceCount: number;
    traceRows: Array<{
        agent: string;
        inputTokens: number;
        model: string;
        provider: string;
        service: string;
        traceId: string;
    }>;
    variantRows: VariantComparisonRow[];
    variantSummaries: VariantSummary[];
    worstSpanComparisons: Array<{
        afterTokens: number;
        changed: boolean;
        id: string;
        name: string;
        offendingMessagePresent: boolean;
        removedToolExchangeCount: number;
    }>;
    worstSpanSample: {
        baselineTokens: number;
        comparisonSpanId: string;
        conversationId: string;
        offendingMessageHash: string;
        offendingMessagePreview: string;
        offendingMessageTokens: number;
        spanId: string;
        traceId: string;
    };
};

const DEFAULT_COVERAGE = 0.7;
const DEFAULT_JAEGER_URL = "http://23.88.91.234:16686";
const DEFAULT_MAX_TRACES = 30;
const DEFAULT_TRACE_FETCH_CONCURRENCY = 2;
const LARGE_TOOL_RESULT_THRESHOLD = 2_000;

const VARIANTS: VariantSpec[] = [
    {
        description: "Current observed prompt snapshots, no extra mutations applied.",
        id: "baseline",
        name: "Baseline",
    },
    {
        description: "Current decay curve, but always on. Removes the total-prompt gate.",
        id: "always_on_current",
        name: "Always-On Current",
        options: {
            maxPromptTokens: undefined,
        },
    },
    {
        description: "Always on, with the placeholder minimum reduced from 800 to 400 tokens.",
        id: "always_on_floor_400",
        name: "Always-On Floor 400",
        options: {
            maxPromptTokens: undefined,
            placeholderMinSourceTokens: 400,
        },
    },
    {
        description: "Always on, with a smaller per-result budget of 150 tokens before decay.",
        id: "always_on_max_150",
        name: "Always-On Max 150",
        options: {
            maxPromptTokens: undefined,
            maxResultTokens: 150,
        },
    },
    {
        description: "Always on, with stronger pressure earlier as tool-context grows.",
        id: "always_on_pressure",
        name: "Always-On Aggressive Pressure",
        options: {
            maxPromptTokens: undefined,
            pressureAnchors: [
                { toolTokens: 100, depthFactor: 0.2 },
                { toolTokens: 2_000, depthFactor: 1 },
                { toolTokens: 10_000, depthFactor: 3 },
                { toolTokens: 50_000, depthFactor: 8 },
            ],
        },
    },
    {
        description: "Always on, with a smaller result budget and stronger pressure curve.",
        id: "always_on_combo",
        name: "Always-On Combo",
        options: {
            maxPromptTokens: undefined,
            maxResultTokens: 100,
            pressureAnchors: [
                { toolTokens: 100, depthFactor: 0.2 },
                { toolTokens: 2_000, depthFactor: 1 },
                { toolTokens: 10_000, depthFactor: 3 },
                { toolTokens: 50_000, depthFactor: 8 },
            ],
        },
    },
];

function usage(): string {
    return [
        "Usage: bun scripts/context-policy-replay.ts [options]",
        "",
        "Replay heavy Jaeger prompt snapshots through ToolResultDecayStrategy variants.",
        "",
        `  --jaeger-url <url>             Default: ${DEFAULT_JAEGER_URL}`,
        `  --coverage <n>                 Default: ${DEFAULT_COVERAGE}`,
        `  --max-traces <n>               Default: ${DEFAULT_MAX_TRACES}`,
        `  --trace-fetch-concurrency <n>  Default: ${DEFAULT_TRACE_FETCH_CONCURRENCY}`,
        "  --source-json <path>           Default: dist/jaeger-context-management-report.json",
        "  --cache-dir <path>             Default: dist/context-replay-cache",
        "  --out <path>                   Default: dist/context-policy-replay-report.html",
        "  --json-out <path>              Default: dist/context-policy-replay-report.json",
        "  -h, --help                     Show help",
    ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
    const parsed: ParsedArgs = {
        cacheDir: resolve(process.cwd(), "dist", "context-replay-cache"),
        coverage: DEFAULT_COVERAGE,
        htmlOut: resolve(process.cwd(), "dist", "context-policy-replay-report.html"),
        jaegerUrl: DEFAULT_JAEGER_URL,
        jsonOut: resolve(process.cwd(), "dist", "context-policy-replay-report.json"),
        maxTraces: DEFAULT_MAX_TRACES,
        sourceJson: resolve(process.cwd(), "dist", "jaeger-context-management-report.json"),
        traceFetchConcurrency: DEFAULT_TRACE_FETCH_CONCURRENCY,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === "-h" || arg === "--help") {
            console.log(usage());
            process.exit(0);
        }

        if (
            arg === "--jaeger-url"
            || arg === "--coverage"
            || arg === "--max-traces"
            || arg === "--trace-fetch-concurrency"
            || arg === "--source-json"
            || arg === "--cache-dir"
            || arg === "--out"
            || arg === "--json-out"
        ) {
            const value = argv[index + 1];
            if (!value) {
                throw new Error(`Missing value for ${arg}`);
            }

            if (arg === "--jaeger-url") {
                parsed.jaegerUrl = value.replace(/\/+$/, "");
            } else if (arg === "--coverage") {
                parsed.coverage = Number.parseFloat(value);
            } else if (arg === "--max-traces") {
                parsed.maxTraces = Number.parseInt(value, 10);
            } else if (arg === "--trace-fetch-concurrency") {
                parsed.traceFetchConcurrency = Number.parseInt(value, 10);
            } else if (arg === "--source-json") {
                parsed.sourceJson = resolve(process.cwd(), value);
            } else if (arg === "--cache-dir") {
                parsed.cacheDir = resolve(process.cwd(), value);
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

    return parsed;
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

function formatInt(value: number): string {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
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

function truncate(value: string, maxLength = 180): string {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 3)}...`;
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

function hashMessage(message: LanguageModelV3Message): string {
    return createHash("sha1").update(stableStringify(message)).digest("hex");
}

function previewForMessage(message: LanguageModelV3Message): string {
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

function classifyMessage(message: LanguageModelV3Message): string {
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

    return message.role;
}

function selectTopTraces(report: SourceUsageReport, coverage: number, maxTraces: number): {
    selected: TraceSeed[];
    summary: TraceSelectionSummary;
} {
    const traceMap = new Map<string, TraceSeed>();
    let totalInputTokens = 0;

    for (const span of report.spans ?? []) {
        const traceId = span.traceId ?? "";
        if (!traceId) {
            continue;
        }
        totalInputTokens += asNumber(span.inputTokens);
        const current = traceMap.get(traceId) ?? {
            agent: asString(span.agent),
            inputTokens: 0,
            model: asString(span.model),
            provider: asString(span.provider),
            service: asString(span.service),
            timestampUs: asNumber(span.timestampUs),
            traceId,
        };
        current.inputTokens += asNumber(span.inputTokens);
        if (!current.agent) current.agent = asString(span.agent);
        if (!current.model) current.model = asString(span.model);
        if (!current.provider) current.provider = asString(span.provider);
        if (!current.service) current.service = asString(span.service);
        if (!current.timestampUs) current.timestampUs = asNumber(span.timestampUs);
        traceMap.set(traceId, current);
    }

    const ranked = [...traceMap.values()].sort((left, right) => right.inputTokens - left.inputTokens);
    const selected: TraceSeed[] = [];
    let selectedInputTokens = 0;

    for (const trace of ranked) {
        selected.push(trace);
        selectedInputTokens += trace.inputTokens;
        if (selected.length >= maxTraces || selectedInputTokens / Math.max(totalInputTokens, 1) >= coverage) {
            break;
        }
    }

    return {
        selected,
        summary: {
            coveragePct: selectedInputTokens / Math.max(totalInputTokens, 1),
            selectedInputTokens,
            selectedTraceCount: selected.length,
            totalInputTokens,
            totalTraceCount: ranked.length,
        },
    };
}

function summarizeExistingSpans(spans: SpanRecord[]): {
    selected: TraceSeed[];
    summary: TraceSelectionSummary;
} {
    const traceMap = new Map<string, TraceSeed>();
    let totalInputTokens = 0;

    for (const span of spans) {
        totalInputTokens += asNumber(span.inputTokens);
        const current = traceMap.get(span.traceId) ?? {
            agent: span.agent || "unknown",
            inputTokens: 0,
            model: span.model || "unknown",
            provider: span.provider || "unknown",
            service: span.service || "unknown",
            timestampUs: span.timestampUs,
            traceId: span.traceId,
        };
        current.inputTokens += asNumber(span.inputTokens);
        if (!current.timestampUs || span.timestampUs < current.timestampUs) {
            current.timestampUs = span.timestampUs;
        }
        traceMap.set(span.traceId, current);
    }

    const selected = [...traceMap.values()].sort((left, right) => right.inputTokens - left.inputTokens);

    return {
        selected,
        summary: {
            coveragePct: 1,
            selectedInputTokens: totalInputTokens,
            selectedTraceCount: selected.length,
            totalInputTokens,
            totalTraceCount: selected.length,
        },
    };
}

function hasEmbeddedPromptSnapshots(source: unknown): source is ContextReplaySource {
    if (!source || typeof source !== "object") {
        return false;
    }
    const spans = (source as { spans?: unknown[] }).spans;
    if (!Array.isArray(spans) || spans.length === 0) {
        return false;
    }
    const first = spans[0];
    return Boolean(first && typeof first === "object" && Array.isArray((first as { messages?: unknown[] }).messages));
}

async function runCurlJson(url: string): Promise<JaegerResponse> {
    const process = Bun.spawn({
        cmd: ["curl", "-sS", "--compressed", "--max-time", "120", url],
        stderr: "pipe",
        stdout: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
    ]);

    if (exitCode !== 0) {
        throw new Error(stderr.trim() || `curl exited with ${exitCode}`);
    }

    return JSON.parse(stdout) as JaegerResponse;
}

async function fetchTrace(args: ParsedArgs, seed: TraceSeed): Promise<JaegerTrace> {
    const cachePath = resolve(args.cacheDir, `${seed.traceId}.json`);
    const cacheFile = Bun.file(cachePath);
    if (await cacheFile.exists()) {
        return JSON.parse(await cacheFile.text()) as JaegerTrace;
    }

    console.error(
        `Fetching trace ${seed.traceId} ${seed.provider} ${seed.agent || "unknown"} ${formatInt(seed.inputTokens)} tokens`
    );
    const response = await runCurlJson(`${args.jaegerUrl}/api/traces/${seed.traceId}`);
    const trace = response.data?.[0];
    if (!trace) {
        throw new Error(`No trace data returned for ${seed.traceId}`);
    }

    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(trace), "utf8");
    return trace;
}

function fieldMap(span: JaegerSpan): Map<string, unknown> {
    const map = new Map<string, unknown>();
    for (const tag of span.tags ?? []) {
        map.set(tag.key, tag.value);
    }
    return map;
}

function normalizeProvider(rawValues: string[]): string {
    for (const raw of rawValues) {
        const value = raw.toLowerCase();
        if (!value) {
            continue;
        }
        if (value.includes("anthropic")) return "anthropic";
        if (value.includes("ollama")) return "ollama";
        if (value.includes("codex")) return "codex";
        if (value.includes("openrouter")) return "openrouter";
        if (value.includes("openai")) return "openai";
        return value.split(/[.:/]/)[0];
    }
    return "unknown";
}

function traceConversationId(trace: JaegerTrace): string {
    for (const span of trace.spans ?? []) {
        const conversationId = asString(fieldMap(span).get("conversation.id"));
        if (conversationId) {
            return conversationId;
        }
    }
    return "unknown";
}

function parseTraceToSpanRecords(trace: JaegerTrace, seed: TraceSeed): SpanRecord[] {
    const conversationId = traceConversationId(trace);
    const records: SpanRecord[] = [];

    for (const span of trace.spans ?? []) {
        if (span.operationName !== "ai.streamText.doStream") {
            continue;
        }

        const tags = fieldMap(span);
        const rawPrompt = asString(tags.get("ai.prompt.messages"));
        if (!rawPrompt) {
            continue;
        }

        let prompt: LanguageModelV3Prompt;
        try {
            const parsed = JSON.parse(rawPrompt);
            if (!Array.isArray(parsed)) {
                continue;
            }
            prompt = parsed as LanguageModelV3Prompt;
        } catch {
            continue;
        }

        records.push({
            agent:
                asString(tags.get("ai.telemetry.metadata.agent.slug"))
                || seed.agent
                || "unknown",
            conversationId,
            inputTokens:
                asNumber(tags.get("ai.usage.inputTokens"))
                || asNumber(tags.get("ai.usage.promptTokens")),
            messages: prompt,
            model: asString(tags.get("ai.model.id")) || seed.model || "unknown",
            provider: normalizeProvider([
                asString(tags.get("ai.telemetry.metadata.llm.provider")),
                asString(tags.get("ai.model.provider")),
                asString(tags.get("gen_ai.system")),
                seed.provider,
            ]),
            service: seed.service || "unknown",
            spanId: span.spanID,
            timestampUs: span.startTime,
            traceId: span.traceID,
        });
    }

    return records.sort((left, right) => left.timestampUs - right.timestampUs);
}

function createMockState(prompt: LanguageModelV3Prompt) {
    const capturedRemoved: Array<{ reason: string; toolCallId: string; toolName: string }> = [];
    const state = {
        params: { prompt, providerOptions: {} },
        pinnedToolCallIds: new Set<string>() as ReadonlySet<string>,
        prompt,
        removedToolExchanges: [] as readonly unknown[],
        requestContext: { conversationId: "replay", agentId: "replay" },
        updatePrompt(nextPrompt: LanguageModelV3Prompt) {
            state.prompt = nextPrompt;
        },
        updateParams() {},
        addRemovedToolExchanges(exchanges: Array<{ reason: string; toolCallId: string; toolName: string }>) {
            capturedRemoved.push(...exchanges);
        },
        addPinnedToolCallIds() {},
        async emitReminder() {},
    };

    return { capturedRemoved, state };
}

function collectLargeToolResultCandidates(
    spans: SpanRecord[],
    estimator: ReturnType<typeof createDefaultPromptTokenEstimator>
): Map<string, CandidateMessage> {
    const candidates = new Map<string, CandidateMessage>();

    for (const span of spans) {
        for (const message of span.messages) {
            const classification = classifyMessage(message);
            if (classification !== "tool-result") {
                continue;
            }

            const estimatedTokens = estimator.estimateMessage(message);
            if (estimatedTokens < LARGE_TOOL_RESULT_THRESHOLD) {
                continue;
            }

            const hash = hashMessage(message);
            if (candidates.has(hash)) {
                continue;
            }

            candidates.set(hash, {
                classification,
                estimatedTokens,
                hash,
                preview: previewForMessage(message),
                role: message.role,
                sampleSpanId: span.spanId,
                sampleTraceId: span.traceId,
            });
        }
    }

    return candidates;
}

async function simulateVariant(
    spans: SpanRecord[],
    estimator: ReturnType<typeof createDefaultPromptTokenEstimator>,
    variant: VariantSpec,
    candidateHashes: ReadonlyMap<string, CandidateMessage>
): Promise<{
    bySpanId: Map<string, SpanSimulationResult>;
    summary: VariantSummary;
}> {
    const bySpanId = new Map<string, SpanSimulationResult>();
    let totalAfterTokens = 0;
    let totalRemovedToolExchanges = 0;
    let changedSpans = 0;
    let spansWithSavings = 0;
    let totalSavingsTokens = 0;

    for (const span of spans) {
        const beforeTokens = estimator.estimatePrompt(span.messages);

        let promptAfter = span.messages;
        let removedToolExchangeCount = 0;

        if (variant.id !== "baseline") {
            const promptClone = structuredClone(span.messages) as LanguageModelV3Prompt;
            const { capturedRemoved, state } = createMockState(promptClone);
            const strategy = new ToolResultDecayStrategy({
                estimator,
                placeholder: "[result omitted]",
                ...(variant.options ?? {}),
            });
            await strategy.apply(state as never);
            promptAfter = state.prompt;
            removedToolExchangeCount = capturedRemoved.length;
        }

        const afterTokens = estimator.estimatePrompt(promptAfter);
        const changed = afterTokens !== beforeTokens || removedToolExchangeCount > 0;
        const presentCandidateHashes = new Set<string>();
        for (const message of promptAfter) {
            const hash = hashMessage(message);
            if (candidateHashes.has(hash)) {
                presentCandidateHashes.add(hash);
            }
        }

        if (changed) {
            changedSpans += 1;
        }
        if (afterTokens < beforeTokens) {
            spansWithSavings += 1;
            totalSavingsTokens += beforeTokens - afterTokens;
        }

        totalAfterTokens += afterTokens;
        totalRemovedToolExchanges += removedToolExchangeCount;

        bySpanId.set(span.spanId, {
            afterTokens,
            changed,
            presentCandidateHashes,
            removedToolExchangeCount,
        });
    }

    return {
        bySpanId,
        summary: {
            avgTokensPerSpan: totalAfterTokens / Math.max(spans.length, 1),
            changedSpans,
            id: variant.id,
            maxCarryLargeToolResult: 0,
            meanSavingsPerChangedSpan: totalSavingsTokens / Math.max(spansWithSavings, 1),
            name: variant.name,
            spansWithSavings,
            totalAfterTokens,
            totalRemovedToolExchanges,
            totalSavingsTokens,
            totalToolRunsOver20Spans: 0,
        },
    };
}

function buildVariantComparisonRows(
    spans: SpanRecord[],
    candidates: ReadonlyMap<string, CandidateMessage>,
    variantSpanResults: ReadonlyMap<string, Map<string, SpanSimulationResult>>
): VariantComparisonRow[] {
    const threadMap = new Map<string, SpanRecord[]>();
    for (const span of spans) {
        const threadKey = `${span.conversationId}::${span.agent}`;
        const list = threadMap.get(threadKey) ?? [];
        list.push(span);
        threadMap.set(threadKey, list);
    }

    const rows = new Map<string, VariantComparisonRow>();
    for (const candidate of candidates.values()) {
        rows.set(candidate.hash, {
            baselineMaxCarry: 0,
            baselineOccurrences: 0,
            classification: candidate.classification,
            estimatedTokens: candidate.estimatedTokens,
            hash: candidate.hash,
            preview: candidate.preview,
            role: candidate.role,
            sampleSpanId: candidate.sampleSpanId,
            sampleTraceId: candidate.sampleTraceId,
            variants: {},
        });
    }

    for (const variant of VARIANTS) {
        const bySpanId = variantSpanResults.get(variant.id)!;
        const statsByHash = new Map<string, CandidateVariantStats>();
        for (const candidateHash of candidates.keys()) {
            statsByHash.set(candidateHash, {
                cumulativeEstimatedTokens: 0,
                maxCarrySpans: 0,
                occurrences: 0,
                persistedToThreadEnd: false,
                runs: [],
            });
        }

        for (const threadSpans of threadMap.values()) {
            threadSpans.sort((left, right) => left.timestampUs - right.timestampUs);
            for (const candidateHash of candidates.keys()) {
                const hits: Array<{ span: SpanRecord; spanIndex: number }> = [];
                for (const [spanIndex, span] of threadSpans.entries()) {
                    const result = bySpanId.get(span.spanId);
                    if (result?.presentCandidateHashes.has(candidateHash)) {
                        hits.push({ span, spanIndex });
                    }
                }

                const stats = statsByHash.get(candidateHash)!;
                stats.occurrences += hits.length;
                stats.cumulativeEstimatedTokens += hits.length * candidates.get(candidateHash)!.estimatedTokens;
                if (hits.length === 0) {
                    continue;
                }

                let runStart = 0;
                const flushRun = (startIndex: number, endIndex: number) => {
                    const first = hits[startIndex];
                    const last = hits[endIndex];
                    const runLength = last.spanIndex - first.spanIndex + 1;
                    const persistedToThreadEnd = last.spanIndex === threadSpans.length - 1;
                    stats.maxCarrySpans = Math.max(stats.maxCarrySpans, runLength - 1);
                    stats.persistedToThreadEnd = stats.persistedToThreadEnd || persistedToThreadEnd;
                    stats.runs.push({
                        count: runLength,
                        endSpanId: last.span.spanId,
                        endTimestampUs: last.span.timestampUs,
                        persistedToThreadEnd,
                        startSpanId: first.span.spanId,
                        startTimestampUs: first.span.timestampUs,
                        traceId: first.span.traceId,
                    });
                };

                for (let index = 1; index < hits.length; index += 1) {
                    if (hits[index].spanIndex !== hits[index - 1].spanIndex + 1) {
                        flushRun(runStart, index - 1);
                        runStart = index;
                    }
                }
                flushRun(runStart, hits.length - 1);
            }
        }

        for (const [hash, stats] of statsByHash) {
            const row = rows.get(hash)!;
            row.variants[variant.id] = stats;
            if (variant.id === "baseline") {
                row.baselineMaxCarry = stats.maxCarrySpans;
                row.baselineOccurrences = stats.occurrences;
            }
        }
    }

    return [...rows.values()]
        .filter((row) => row.baselineOccurrences > 0)
        .sort((left, right) => {
            const leftCost = left.estimatedTokens * left.baselineOccurrences;
            const rightCost = right.estimatedTokens * right.baselineOccurrences;
            return rightCost - leftCost;
        });
}

function enrichVariantSummaries(
    variantSummaries: VariantSummary[],
    rows: VariantComparisonRow[]
): VariantSummary[] {
    const byId = new Map<string, VariantSummary>();
    for (const summary of variantSummaries) {
        byId.set(summary.id, summary);
    }

    for (const variant of VARIANTS) {
        const summary = byId.get(variant.id);
        if (!summary) {
            continue;
        }

        let maxCarry = 0;
        let longRuns = 0;
        for (const row of rows) {
            const stats = row.variants[variant.id];
            if (!stats) {
                continue;
            }
            maxCarry = Math.max(maxCarry, stats.maxCarrySpans);
            for (const run of stats.runs) {
                if (run.count - 1 > 20) {
                    longRuns += 1;
                }
            }
        }

        summary.maxCarryLargeToolResult = maxCarry;
        summary.totalToolRunsOver20Spans = longRuns;
    }

    return variantSummaries;
}

function findComparisonSpanId(
    spans: SpanRecord[],
    row: VariantComparisonRow
): string {
    const baseline = row.variants.baseline;
    if (!baseline || baseline.runs.length === 0) {
        return row.sampleSpanId;
    }

    const targetRun = [...baseline.runs].sort((left, right) => right.count - left.count)[0];
    const threadKey = `${spans.find((span) => span.spanId === targetRun.startSpanId)?.conversationId ?? "unknown"}::${spans.find((span) => span.spanId === targetRun.startSpanId)?.agent ?? "unknown"}`;
    const threadSpans = spans
        .filter((span) => `${span.conversationId}::${span.agent}` === threadKey)
        .sort((left, right) => left.timestampUs - right.timestampUs);
    const startIndex = threadSpans.findIndex((span) => span.spanId === targetRun.startSpanId);

    if (startIndex >= 0 && startIndex + 1 < threadSpans.length) {
        return threadSpans[startIndex + 1].spanId;
    }

    return targetRun.startSpanId;
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

function renderHtml(report: ReplayReport): string {
    const variantRows = report.variantSummaries.map((summary) => [
        escapeHtml(summary.name),
        formatInt(Math.round(summary.totalAfterTokens)),
        formatInt(Math.round(report.baselineEstimatedTokens - summary.totalAfterTokens)),
        formatPct(((report.baselineEstimatedTokens - summary.totalAfterTokens) / Math.max(report.baselineEstimatedTokens, 1)) * 100),
        formatInt(summary.spansWithSavings),
        formatInt(summary.changedSpans),
        formatInt(summary.totalRemovedToolExchanges),
        formatInt(summary.maxCarryLargeToolResult),
        formatInt(summary.totalToolRunsOver20Spans),
    ]);

    const topMessageRows = report.variantRows.slice(0, 12).map((row) => [
        formatInt(row.estimatedTokens),
        formatInt(row.baselineOccurrences),
        formatInt(row.baselineMaxCarry),
        ...VARIANTS.filter((variant) => variant.id !== "baseline").map((variant) =>
            formatInt(row.variants[variant.id]?.maxCarrySpans ?? 0)
        ),
        escapeHtml(row.preview),
    ]);

    const traceRows = report.traceRows.map((trace) => [
        escapeHtml(trace.provider),
        escapeHtml(trace.agent || "unknown"),
        escapeHtml(trace.model || "unknown"),
        formatInt(trace.inputTokens),
        escapeHtml(trace.traceId),
    ]);

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Context Policy Replay</title>
    <style>
        :root {
            --bg: #f5f1e8;
            --panel: #fffdf8;
            --ink: #1f2a44;
            --muted: #5b6778;
            --grid: #ddd4c4;
            --accent: #8f2d56;
            --accent-soft: rgba(143, 45, 86, 0.1);
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            background:
                radial-gradient(circle at top left, rgba(42, 157, 143, 0.12), transparent 28rem),
                radial-gradient(circle at top right, rgba(143, 45, 86, 0.10), transparent 26rem),
                var(--bg);
            color: var(--ink);
            font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
            line-height: 1.45;
        }
        main { max-width: 1500px; margin: 0 auto; padding: 32px 24px 80px; }
        .hero, .panel, .summary-card, .callout { border: 1px solid var(--grid); border-radius: 22px; background: var(--panel); box-shadow: 0 14px 40px rgba(20, 34, 61, 0.05); }
        .hero { padding: 24px 28px; display: grid; gap: 12px; margin-bottom: 24px; }
        .summary-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom: 22px; }
        .summary-card { padding: 18px; }
        .summary-label, th {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--muted);
        }
        .summary-value { margin-top: 8px; font-size: 1.8rem; font-weight: 700; }
        .summary-note { margin-top: 6px; font-size: 14px; color: var(--muted); }
        .panel { padding: 20px; margin-bottom: 22px; }
        .callout { padding: 16px 18px; border-left: 4px solid var(--accent); background: var(--accent-soft); margin-bottom: 22px; }
        .table-wrap { overflow-x: auto; border: 1px solid var(--grid); border-radius: 16px; background: rgba(255,255,255,0.42); }
        table { width: 100%; border-collapse: collapse; min-width: 920px; }
        th, td { padding: 11px 14px; border-bottom: 1px solid rgba(221,212,196,0.72); text-align: left; vertical-align: top; }
        td { font-size: 14px; }
        th { background: rgba(31, 42, 68, 0.04); position: sticky; top: 0; }
        h1, h2 { margin: 0; letter-spacing: -0.02em; }
        p { margin: 0; color: var(--muted); }
    </style>
</head>
<body>
<main>
    <section class="hero">
        <div class="summary-label">Context policy replay</div>
        <h1>What happens if ToolResultDecayStrategy becomes always-on and more aggressive?</h1>
        <p>This replay benchmarks alternative tool-result decay policies against the prompt snapshots that were actually sent to the provider. It measures incremental savings beyond the current behavior that produced the traces.</p>
        <div class="summary-note">Selected ${formatInt(report.traceCount)} traces covering ${formatPct(report.selectionSummary.coveragePct * 100)} of the 4-day input-token volume.</div>
    </section>

    <section class="summary-grid">
        <div class="summary-card">
            <div class="summary-label">Selected traces</div>
            <div class="summary-value">${formatInt(report.traceCount)}</div>
            <div class="summary-note">${formatInt(report.selectionSummary.selectedInputTokens)} of ${formatInt(report.selectionSummary.totalInputTokens)} source input tokens</div>
        </div>
        <div class="summary-card">
            <div class="summary-label">Replay spans</div>
            <div class="summary-value">${formatInt(report.spanCount)}</div>
            <div class="summary-note">doStream snapshots replayed under each variant</div>
        </div>
        <div class="summary-card">
            <div class="summary-label">Baseline est. tokens</div>
            <div class="summary-value">${formatInt(Math.round(report.baselineEstimatedTokens))}</div>
            <div class="summary-note">Estimated from the sent prompt snapshots</div>
        </div>
        <div class="summary-card">
            <div class="summary-label">Candidate messages</div>
            <div class="summary-value">${formatInt(report.candidateCount)}</div>
            <div class="summary-note">Large tool results tracked at ${formatInt(LARGE_TOOL_RESULT_THRESHOLD)}+ estimated tokens</div>
        </div>
    </section>

    <div class="callout"><strong>Worst baseline case:</strong> span ${escapeHtml(report.worstSpanSample.spanId)} in trace ${escapeHtml(report.worstSpanSample.traceId)} introduces a ${formatInt(report.worstSpanSample.offendingMessageTokens)}-token tool result. The table below compares the first follow-up span (${escapeHtml(report.worstSpanSample.comparisonSpanId)}), which is the first point where decay could carry it forward or drop it.</div>

    <section class="panel">
        <h2 style="margin-bottom:12px;">Variant Summary</h2>
        ${renderTable(
            ["Variant", "Total est. tokens", "Savings", "Savings %", "Spans with savings", "Changed spans", "Removed tool exchanges", "Max large carry", "Runs >20 spans"],
            variantRows
        )}
    </section>

    <section class="panel">
        <h2 style="margin-bottom:12px;">Worst Span Comparison</h2>
        ${renderTable(
            ["Variant", "After tokens", "Changed", "Offending message still present", "Removed exchanges"],
            report.worstSpanComparisons.map((row) => [
                escapeHtml(row.name),
                formatInt(row.afterTokens),
                row.changed ? "yes" : "no",
                row.offendingMessagePresent ? "yes" : "no",
                formatInt(row.removedToolExchangeCount),
            ])
        )}
    </section>

    <section class="panel">
        <h2 style="margin-bottom:12px;">Top Baseline Offenders</h2>
        ${renderTable(
            ["Est. tokens", "Baseline occ", "Baseline max carry", ...VARIANTS.filter((variant) => variant.id !== "baseline").map((variant) => `${variant.name} max carry`), "Preview"],
            topMessageRows
        )}
    </section>

    <section class="panel">
        <h2 style="margin-bottom:12px;">Trace Selection</h2>
        ${renderTable(
            ["Provider", "Agent", "Model", "Input tokens", "Trace"],
            traceRows
        )}
    </section>
</main>
</body>
</html>`;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const estimator = createDefaultPromptTokenEstimator();
    const source = JSON.parse(await readFile(args.sourceJson, "utf8")) as SourceUsageReport | ContextReplaySource;

    let selected: TraceSeed[];
    let summary: TraceSelectionSummary;
    let spans: SpanRecord[];

    if (hasEmbeddedPromptSnapshots(source)) {
        spans = [...(source.spans ?? [])].sort((left, right) => left.timestampUs - right.timestampUs);
        const existing = summarizeExistingSpans(spans);
        selected = existing.selected;
        summary = source.selectionSummary ?? existing.summary;
        console.error(
            `Loaded ${formatInt(spans.length)} prompt snapshots from ${formatInt(summary.selectedTraceCount)} selected traces covering ${formatPct(summary.coveragePct * 100)} of ${formatInt(summary.totalInputTokens)} input tokens`
        );
    } else {
        const selectedResult = selectTopTraces(source as SourceUsageReport, args.coverage, args.maxTraces);
        selected = selectedResult.selected;
        summary = selectedResult.summary;

        console.error(
            `Selected ${summary.selectedTraceCount}/${summary.totalTraceCount} traces covering ${formatPct(summary.coveragePct * 100)} of ${formatInt(summary.totalInputTokens)} input tokens`
        );

        const traces: JaegerTrace[] = [];
        for (let index = 0; index < selected.length; index += args.traceFetchConcurrency) {
            const batch = selected.slice(index, index + args.traceFetchConcurrency);
            const fetched = await Promise.all(batch.map((seed) => fetchTrace(args, seed)));
            traces.push(...fetched);
        }

        spans = traces.flatMap((trace) => {
            const seed = selected.find((entry) => entry.traceId === trace.traceID);
            if (!seed) {
                return [];
            }
            return parseTraceToSpanRecords(trace, seed);
        }).sort((left, right) => left.timestampUs - right.timestampUs);
    }

    const candidates = collectLargeToolResultCandidates(spans, estimator);

    const baselineEstimatedTokens = spans.reduce(
        (sum, span) => sum + estimator.estimatePrompt(span.messages),
        0
    );

    const variantSpanResults = new Map<string, Map<string, SpanSimulationResult>>();
    const variantSummaries: VariantSummary[] = [];
    for (const variant of VARIANTS) {
        console.error(`Simulating ${variant.name}`);
        const { bySpanId, summary: variantSummary } = await simulateVariant(
            spans,
            estimator,
            variant,
            candidates
        );
        variantSpanResults.set(variant.id, bySpanId);
        variantSummaries.push(variantSummary);
    }

    const variantRows = buildVariantComparisonRows(spans, candidates, variantSpanResults);
    const enrichedSummaries = enrichVariantSummaries(variantSummaries, variantRows);

    const worstBaselineRow = variantRows[0];
    if (!worstBaselineRow) {
        throw new Error("No large tool-result candidates found to replay");
    }

    const comparisonSpanId = findComparisonSpanId(spans, worstBaselineRow);
    const baselineBySpan = variantSpanResults.get("baseline")!;
    const worstSpanBaselineResult = baselineBySpan.get(comparisonSpanId);
    if (!worstSpanBaselineResult) {
        throw new Error(`Missing baseline span simulation for ${comparisonSpanId}`);
    }

    const report: ReplayReport = {
        baselineEstimatedTokens,
        candidateCount: candidates.size,
        generatedAt: new Date().toISOString(),
        selectionSummary: summary,
        spanCount: spans.length,
        traceCount: selected.length,
        traceRows: selected.map((trace) => ({
            agent: trace.agent,
            inputTokens: trace.inputTokens,
            model: trace.model,
            provider: trace.provider,
            service: trace.service,
            traceId: trace.traceId,
        })),
        variantRows,
        variantSummaries: enrichedSummaries,
        worstSpanComparisons: VARIANTS.map((variant) => {
            const result = variantSpanResults.get(variant.id)?.get(comparisonSpanId);
            return {
                afterTokens: Math.round(result?.afterTokens ?? 0),
                changed: Boolean(result?.changed),
                id: variant.id,
                name: variant.name,
                offendingMessagePresent: Boolean(result?.presentCandidateHashes.has(worstBaselineRow.hash)),
                removedToolExchangeCount: result?.removedToolExchangeCount ?? 0,
            };
        }),
        worstSpanSample: {
            baselineTokens: Math.round(worstSpanBaselineResult.afterTokens),
            comparisonSpanId,
            conversationId:
                spans.find((span) => span.spanId === comparisonSpanId)?.conversationId
                || "unknown",
            offendingMessageHash: worstBaselineRow.hash,
            offendingMessagePreview: worstBaselineRow.preview,
            offendingMessageTokens: worstBaselineRow.estimatedTokens,
            spanId: worstBaselineRow.sampleSpanId,
            traceId: worstBaselineRow.sampleTraceId,
        },
    };

    const html = renderHtml(report);

    await mkdir(dirname(args.htmlOut), { recursive: true });
    await mkdir(dirname(args.jsonOut), { recursive: true });
    await writeFile(args.htmlOut, html, "utf8");
    await writeFile(args.jsonOut, JSON.stringify(report, null, 2), "utf8");

    console.log(`HTML report: ${args.htmlOut}`);
    console.log(`JSON data:   ${args.jsonOut}`);
    for (const summaryRow of enrichedSummaries) {
        console.log(
            `${summaryRow.name}: savings ${formatInt(Math.round(summaryRow.totalSavingsTokens))} tokens, max carry ${formatInt(summaryRow.maxCarryLargeToolResult)}`
        );
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
