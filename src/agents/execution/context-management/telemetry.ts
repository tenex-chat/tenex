import { AsyncLocalStorage } from "node:async_hooks";
import { context as otelContext, trace, type Span } from "@opentelemetry/api";
import type {
    ContextManagementStrategyPayload,
    ContextManagementTelemetryEvent,
} from "ai-sdk-context-management";
import { analysisTelemetryService } from "@/services/analysis/AnalysisTelemetryService";
import { MANAGED_CONTEXT_BUDGET_SCOPE } from "./budget-profile";

interface ContextManagementAnalysisScope {
    requestId: string;
    projectId?: string;
    conversationId?: string;
    agentSlug?: string;
    agentId?: string;
    provider: string;
    model: string;
}

const analysisScopeStorage = new AsyncLocalStorage<ContextManagementAnalysisScope>();

function addAttribute(
    attributes: Record<string, string | number | boolean>,
    key: string,
    value: string | number | boolean | undefined
): void {
    if (value !== undefined) {
        attributes[key] = value;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function getNumber(value: unknown, key: string): number | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const nested = value[key];
    return typeof nested === "number" && Number.isFinite(nested) ? nested : undefined;
}

function getString(value: unknown, key: string): string | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const nested = value[key];
    return typeof nested === "string" && nested.length > 0 ? nested : undefined;
}

function getStringArray(value: unknown, key: string): string[] | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const nested = value[key];
    if (!Array.isArray(nested)) {
        return undefined;
    }

    return nested.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function getRecordKeyCount(value: unknown, key: string): number | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const nested = value[key];
    if (!isRecord(nested)) {
        return undefined;
    }

    return Object.keys(nested).length;
}

function getRecordStringCharCount(value: unknown, key: string): number | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const nested = value[key];
    if (!isRecord(nested)) {
        return undefined;
    }

    let total = 0;
    for (const [entryKey, entryValue] of Object.entries(nested)) {
        if (typeof entryValue === "string") {
            total += entryKey.length + entryValue.length;
        }
    }

    return total;
}

function getScratchpadNotes(value: unknown): string | undefined {
    const directNotes = getString(value, "notes");
    if (directNotes !== undefined) {
        return directNotes;
    }

    const entries = isRecord(value) && isRecord(value.entries)
        ? value.entries
        : undefined;
    if (typeof entries?.notes === "string" && entries.notes.trim().length > 0) {
        return entries.notes;
    }

    const setEntries = isRecord(value) && isRecord(value.setEntries)
        ? value.setEntries
        : undefined;
    const replaceEntries = isRecord(value) && isRecord(value.replaceEntries)
        ? value.replaceEntries
        : undefined;
    const notes = typeof replaceEntries?.notes === "string"
        ? replaceEntries.notes
        : typeof setEntries?.notes === "string"
            ? setEntries.notes
            : undefined;

    return notes?.trim().length ? notes : undefined;
}

function getScratchpadEntryUpdateCount(value: unknown): number {
    if (getString(value, "notes") !== undefined) {
        return 1;
    }

    return (getRecordKeyCount(value, "setEntries") ?? 0)
        + (getRecordKeyCount(value, "replaceEntries") ?? 0);
}

function getScratchpadEntryCharCount(value: unknown): number {
    const notes = getScratchpadNotes(value);
    if (notes !== undefined) {
        return notes.length;
    }

    return (getRecordStringCharCount(value, "setEntries") ?? 0)
        + (getRecordStringCharCount(value, "replaceEntries") ?? 0);
}

function formatTelemetryNumber(value: number): string {
    return Math.round(value).toLocaleString("en-US");
}

function formatCount(value: number, singular: string, plural = `${singular}s`): string {
    return `${formatTelemetryNumber(value)} ${value === 1 ? singular : plural}`;
}

function clipTelemetrySummary(summary: string): string {
    const trimmed = summary.trim().replace(/\s+/g, " ");
    return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

function buildRuntimeStartSummary(event: Extract<ContextManagementTelemetryEvent, { type: "runtime-start" }>): string {
    const optionalTools = event.optionalToolNames.length > 0
        ? event.optionalToolNames.join(", ")
        : "none";
    return clipTelemetrySummary(
        `Running ${formatCount(event.strategyNames.length, "strategy")} over ~${formatTelemetryNumber(event.estimatedTokensBefore)} tokens; optional tools: ${optionalTools}.`
    );
}

function buildToolResultDecaySummary(
    _event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>,
    payload: Extract<ContextManagementStrategyPayload, { kind: "tool-result-decay" }> | undefined
): string {
    if (!payload) {
        return "Evaluated tool-result decay.";
    }

    return clipTelemetrySummary(
        `Evaluated tool-result decay across ${formatTelemetryNumber(payload.totalToolExchanges ?? 0)} exchanges; ${formatTelemetryNumber(payload.placeholderCount ?? 0)} outputs and ${formatTelemetryNumber(payload.inputPlaceholderCount ?? 0)} inputs placeholdered.`
    );
}

function buildScratchpadSummary(
    event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>,
    payload: Extract<ContextManagementStrategyPayload, { kind: "scratchpad" }> | undefined
): string {
    if (event.reason === "scratchpad-idle") {
        return "Skipped scratchpad reminder because no scratchpad state exists yet.";
    }

    if (!payload) {
        return "Rendered scratchpad context.";
    }

    if (payload.forcedToolChoice) {
        return "Rendered scratchpad context and forced scratchpad tool choice.";
    }

    return "Rendered scratchpad context.";
}

function buildRemindersSummary(
    payload: Extract<ContextManagementStrategyPayload, { kind: "reminders" }> | undefined
): string {
    if (!payload || payload.emittedCount === 0) {
        return "Evaluated reminders.";
    }

    return clipTelemetrySummary(
        `Applied ${formatCount(payload.emittedCount, "reminder")} across ${formatCount(payload.reminderTypes.length, "type")}.`
    );
}

function buildCompactionSummary(payload: Extract<ContextManagementStrategyPayload, { kind: "compaction-tool" }> | undefined): string {
    if (!payload) {
        return "Evaluated compaction.";
    }

    if (payload.mode === "stored" && payload.editCount > 0) {
        return "Reapplied stored compactions.";
    }

    if (payload.mode === "manual" && payload.compactedMessageCount > 0) {
        return `Applied manual compaction over ${formatCount(payload.compactedMessageCount, "message")}.`;
    }

    if (payload.mode === "auto" && payload.compactedMessageCount > 0) {
        return `Auto-compacted ${formatCount(payload.compactedMessageCount, "message")}.`;
    }

    return "Evaluated compaction.";
}

function buildFallbackStrategySummary(event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>): string {
    return `${event.strategyName} ${event.outcome}.`;
}

function buildStrategyCompleteSummary(
    event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>
): string {
    const payload = event.strategyPayload;

    if (!payload) {
        if (event.strategyName === "compaction-tool") {
            return "Evaluated compaction.";
        }
        return buildFallbackStrategySummary(event);
    }

    switch (payload.kind) {
        case "tool-result-decay":
            return buildToolResultDecaySummary(event, payload);
        case "scratchpad":
            return buildScratchpadSummary(event, payload);
        case "reminders":
            return buildRemindersSummary(payload);
        case "compaction-tool":
            return buildCompactionSummary(payload);
        default:
            return buildFallbackStrategySummary(event);
    }
}

function buildRuntimeCompleteSummary(
    event: Extract<ContextManagementTelemetryEvent, { type: "runtime-complete" }>
): string {
    const tokensSaved = Math.max(0, event.estimatedTokensBefore - event.estimatedTokensAfter);
    return `Completed context management; saved ~${formatTelemetryNumber(tokensSaved)} tokens.`;
}

function buildToolExecuteSummary(
    event: Extract<ContextManagementTelemetryEvent, {
        type: "tool-execute-start" | "tool-execute-complete" | "tool-execute-error";
    }>
): string {
    if (event.toolName === "scratchpad" && event.type === "tool-execute-complete") {
        return "Updated scratchpad.";
    }

    if (event.toolName === "compact_context" && event.type === "tool-execute-complete") {
        const result = isRecord(event.payloads.result) ? event.payloads.result : undefined;
        return result?.ok === true
            ? "Queued context compaction."
            : "Rejected context compaction request.";
    }

    if (event.type === "tool-execute-error") {
        return `Tool ${event.toolName} failed during context management.`;
    }

    return `Executed context-management tool ${event.toolName}.`;
}

function buildDerivedTelemetryAttributes(
    event: ContextManagementTelemetryEvent
): Record<string, string | number | boolean> {
    const attributes: Record<string, string | number | boolean> = {};

    switch (event.type) {
        case "runtime-start":
            attributes["context_management.strategy_count"] = event.strategyNames.length;
            attributes["context_management.optional_tool_count"] = event.optionalToolNames.length;
            attributes["context_management.summary"] = buildRuntimeStartSummary(event);
            break;
        case "strategy-complete": {
            const tokensSaved = Math.max(
                0,
                event.estimatedTokensBefore - event.estimatedTokensAfter
            );
            attributes["context_management.tokens_saved"] = tokensSaved;
            attributes["context_management.summary"] = buildStrategyCompleteSummary(event);

            const payload = event.strategyPayload;
            if (!payload) {
                break;
            }

            switch (payload.kind) {
                case "tool-result-decay":
                    addAttribute(attributes, "context_management.current_prompt_tokens", payload.currentPromptTokens);
                    addAttribute(attributes, "context_management.tool_context_tokens", payload.toolContextTokens);
                    addAttribute(attributes, "context_management.forecast_tool_context_tokens", payload.forecastToolContextTokens);
                    addAttribute(attributes, "context_management.warning_forecast_extra_tokens", payload.warningForecastExtraTokens);
                    addAttribute(attributes, "context_management.depth_factor", payload.depthFactor);
                    addAttribute(attributes, "context_management.forecast_depth_factor", payload.forecastDepthFactor);
                    addAttribute(attributes, "context_management.max_result_tokens", payload.maxResultTokens);
                    addAttribute(attributes, "context_management.placeholder_min_source_tokens", payload.placeholderMinSourceTokens);
                    addAttribute(attributes, "context_management.placeholder_tool_result_count", payload.placeholderCount);
                    addAttribute(attributes, "context_management.placeholder_tool_input_count", payload.inputPlaceholderCount);
                    addAttribute(attributes, "context_management.total_tool_exchanges", payload.totalToolExchanges);
                    addAttribute(attributes, "context_management.warning_count", payload.warningCount);
                    break;
                case "scratchpad":
                    attributes["context_management.entry_count"] = payload.entryCount;
                    attributes["context_management.entry_char_count"] = payload.entryCharCount;
                    addAttribute(attributes, "context_management.preserve_turns", payload.preserveTurns ?? undefined);
                    attributes["context_management.forced_tool_choice"] = payload.forcedToolChoice;
                    addAttribute(attributes, "context_management.force_threshold_tokens", payload.forceThresholdTokens);
                    attributes["context_management.estimated_prompt_tokens"] = payload.estimatedTokens;
                    break;
                case "reminders":
                    attributes["context_management.reminder_count"] = payload.emittedCount;
                    attributes["context_management.reminder_provider_count"] = payload.providerCount;
                    attributes["context_management.reminder_built_in_count"] = payload.builtInCount;
                    attributes["context_management.reminder_deferred_count"] = payload.deferredCount;
                    attributes["context_management.budget_scope"] = MANAGED_CONTEXT_BUDGET_SCOPE;
                    break;
                case "compaction-tool":
                    addAttribute(
                        attributes,
                        "context_management.compaction_mode",
                        payload.mode
                    );
                    addAttribute(
                        attributes,
                        "context_management.compaction_edit_count",
                        payload.editCount
                    );
                    addAttribute(
                        attributes,
                        "context_management.compaction_message_count",
                        payload.compactedMessageCount
                    );
                    addAttribute(
                        attributes,
                        "context_management.compaction_from_index",
                        payload.fromIndex
                    );
                    addAttribute(
                        attributes,
                        "context_management.compaction_to_index",
                        payload.toIndex
                    );
                    addAttribute(
                        attributes,
                        "context_management.summary_char_count",
                        payload.summaryCharCount
                    );
                    break;
                default:
                    break;
            }
            break;
        }
        case "tool-execute-start":
        case "tool-execute-complete":
        case "tool-execute-error":
            attributes["context_management.summary"] = buildToolExecuteSummary(event);
            if (event.toolName === "scratchpad") {
                attributes["context_management.entry_char_count"] = getScratchpadEntryCharCount(
                    event.payloads.input
                );
                attributes["context_management.entry_update_count"] = getScratchpadEntryUpdateCount(
                    event.payloads.input
                );
                attributes["context_management.entry_removal_count"] =
                    getStringArray(event.payloads.input, "removeEntryKeys")?.length ?? 0;
                addAttribute(
                    attributes,
                    "context_management.preserve_turns",
                    getNumber(event.payloads.input, "preserveTurns")
                );
            } else if (event.toolName === "compact_context") {
                addAttribute(
                    attributes,
                    "context_management.summary_char_count",
                    getString(event.payloads.input, "message")?.length
                );
                if (event.type === "tool-execute-complete") {
                    const result = isRecord(event.payloads.result) ? event.payloads.result : undefined;
                    addAttribute(
                        attributes,
                        "context_management.compaction_requested",
                        result?.ok === true
                            ? true
                            : undefined
                    );
                    addAttribute(
                        attributes,
                        "context_management.compaction_message_count",
                        getNumber(result, "compactedMessageCount")
                    );
                }
            }
            break;
        case "runtime-complete":
            attributes["context_management.tokens_saved"] = Math.max(
                0,
                event.estimatedTokensBefore - event.estimatedTokensAfter
            );
            attributes["context_management.summary"] = buildRuntimeCompleteSummary(event);
            break;
    }

    return attributes;
}

function sanitizeTelemetrySegment(value: string): string {
    return value
        .trim()
        .replace(/[^a-zA-Z0-9_.-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase();
}

function buildTelemetryAttributes(
    event: ContextManagementTelemetryEvent
): Record<string, string | number | boolean> {
    const attributes: Record<string, string | number | boolean> = {};

    switch (event.type) {
        case "runtime-start":
            attributes["context_management.strategy_names"] = event.strategyNames.join(",");
            attributes["context_management.optional_tool_names"] = event.optionalToolNames.join(",");
            attributes["context_management.estimated_tokens_before"] = event.estimatedTokensBefore;
            break;
        case "strategy-complete":
            attributes["context_management.strategy_name"] = event.strategyName;
            attributes["context_management.outcome"] = event.outcome;
            attributes["context_management.reason"] = event.reason;
            attributes["context_management.estimated_tokens_before"] = event.estimatedTokensBefore;
            attributes["context_management.estimated_tokens_after"] = event.estimatedTokensAfter;
            attributes["context_management.removed_tool_exchanges_delta"] = event.removedToolExchangesDelta;
            attributes["context_management.removed_tool_exchanges_total"] = event.removedToolExchangesTotal;
            attributes["context_management.pinned_tool_call_ids_delta"] = event.pinnedToolCallIdsDelta;
            addAttribute(
                attributes,
                "context_management.working_token_budget",
                event.workingTokenBudget
            );
            break;
        case "tool-execute-start":
            attributes["context_management.tool_name"] = event.toolName;
            addAttribute(attributes, "context_management.strategy_name", event.strategyName);
            addAttribute(attributes, "context_management.tool_call_id", event.toolCallId);
            break;
        case "tool-execute-complete":
            attributes["context_management.tool_name"] = event.toolName;
            addAttribute(attributes, "context_management.strategy_name", event.strategyName);
            addAttribute(attributes, "context_management.tool_call_id", event.toolCallId);
            break;
        case "tool-execute-error":
            attributes["context_management.tool_name"] = event.toolName;
            addAttribute(attributes, "context_management.strategy_name", event.strategyName);
            addAttribute(attributes, "context_management.tool_call_id", event.toolCallId);
            break;
        case "runtime-complete":
            attributes["context_management.estimated_tokens_before"] = event.estimatedTokensBefore;
            attributes["context_management.estimated_tokens_after"] = event.estimatedTokensAfter;
            attributes["context_management.removed_tool_exchanges_total"] =
                event.removedToolExchangesTotal;
            attributes["context_management.pinned_tool_call_ids_total"] =
                event.pinnedToolCallIdsTotal;
            break;
    }

    return {
        ...attributes,
        ...buildDerivedTelemetryAttributes(event),
    };
}

function buildTelemetryEventName(event: ContextManagementTelemetryEvent): string {
    switch (event.type) {
        case "runtime-start":
            return "context_management.runtime_start";
        case "strategy-complete":
            return `context_management.strategy_complete.${sanitizeTelemetrySegment(
                event.strategyName
            )}`;
        case "tool-execute-start":
            return `context_management.tool_execute_start.${sanitizeTelemetrySegment(
                event.toolName
            )}`;
        case "tool-execute-complete":
            return `context_management.tool_execute_complete.${sanitizeTelemetrySegment(
                event.toolName
            )}`;
        case "tool-execute-error":
            return `context_management.tool_execute_error.${sanitizeTelemetrySegment(
                event.toolName
            )}`;
        case "runtime-complete":
            return "context_management.runtime_complete";
    }

    return "context_management.unknown";
}

export function createTelemetryCallback(): (event: ContextManagementTelemetryEvent) => void {
    const tracer = trace.getTracer("tenex");
    let runtimeSpan: Span | undefined;
    return (event: ContextManagementTelemetryEvent): void => {
        const attributes = buildTelemetryAttributes(event);
        const eventName = buildTelemetryEventName(event);
        const analysisScope = analysisScopeStorage.getStore();

        if (event.type === "runtime-start") {
            runtimeSpan = tracer.startSpan(
                "tenex.context_management",
                { attributes },
                otelContext.active()
            );
            runtimeSpan.addEvent(eventName, attributes);
            return;
        }

        const span = runtimeSpan ?? trace.getActiveSpan();
        if (span) {
            span.addEvent(eventName, attributes);
        }

        if (analysisScope) {
            analysisTelemetryService.recordContextManagementEvent(event, analysisScope);
        }

        if (event.type === "runtime-complete" && runtimeSpan) {
            runtimeSpan.setAttribute(
                "context_management.estimated_tokens_before",
                event.estimatedTokensBefore
            );
            runtimeSpan.setAttribute(
                "context_management.estimated_tokens_after",
                event.estimatedTokensAfter
            );
            runtimeSpan.end();
            runtimeSpan = undefined;
        }
    };
}

export function withContextManagementAnalysisScope<T>(
    scope: ContextManagementAnalysisScope | undefined,
    fn: () => Promise<T>
): Promise<T> {
    if (!scope) {
        return fn();
    }

    return analysisScopeStorage.run(scope, fn);
}
