import { trace } from "@opentelemetry/api";
import type { LanguageModel, LanguageModelMiddleware } from "ai";
import {
    CONTEXT_MANAGEMENT_KEY,
    ContextWindowStatusStrategy,
    ContextUtilizationReminderStrategy,
    LLMSummarizationStrategy,
    ScratchpadStrategy,
    SystemPromptCachingStrategy,
    ToolResultDecayStrategy,
    createContextManagementRuntime,
    createDefaultPromptTokenEstimator,
    type ContextManagementRequestContext,
    type ContextManagementRuntime,
    type ContextManagementStrategy,
    type ContextManagementTelemetryEvent,
} from "ai-sdk-context-management";
import { createSystemReminderSink } from "ai-sdk-system-reminders";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { providerRegistry } from "@/llm/providers";
import { getContextWindow } from "@/llm/utils/context-window-cache";
import { config as configService } from "@/services/ConfigService";
import { isOnlyToolMode, type NudgeToolPermissions } from "@/services/nudge";
import type { AISdkTool } from "@/tools/types";

const DEFAULT_WORKING_TOKEN_BUDGET = 40000;
const DEFAULT_WARNING_THRESHOLD_PERCENT = 70;
const DEFAULT_SUMMARIZATION_THRESHOLD_PERCENT = 90;
const DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT = 70;

export interface ExecutionContextManagement {
    middleware: LanguageModelMiddleware;
    optionalTools: Record<string, AISdkTool>;
    requestContext: ContextManagementRequestContext;
}

function normalizeProviderId(providerId: string): string {
    const normalized = providerId.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    const registered = providerRegistry.getRegisteredProviders();
    const matches = registered.some((metadata) => metadata.id === normalized);

    return matches ? normalized : providerId;
}

function isResumableProvider(providerId: string): boolean {
    const normalized = normalizeProviderId(providerId);
    const provider = providerRegistry.getProvider(normalized);

    if (provider) {
        return provider.metadata.capabilities.sessionResumption === true;
    }

    const registered = providerRegistry
        .getRegisteredProviders()
        .find((metadata) => metadata.id === normalized);
    return registered?.capabilities.sessionResumption === true;
}


function serializeTelemetryValue(value: unknown): string {
    const seen = new WeakSet<object>();

    try {
        return JSON.stringify(value, (_key, current) => {
            if (current instanceof Error) {
                return {
                    name: current.name,
                    message: current.message,
                    stack: current.stack,
                };
            }

            if (typeof current === "bigint") {
                return current.toString();
            }

            if (typeof current === "object" && current !== null) {
                if (seen.has(current)) {
                    return "[Circular]";
                }
                seen.add(current);
            }

            return current;
        }) ?? "null";
    } catch (error) {
        const fallbackError = error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { message: String(error) };
        return JSON.stringify({
            serializationError: fallbackError,
            fallback: String(value),
        });
    }
}

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

function getBoolean(value: unknown, key: string): boolean | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const nested = value[key];
    return typeof nested === "boolean" ? nested : undefined;
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

function humanizeToken(token: string): string {
    return token.replace(/[-_]+/g, " ");
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

function buildSystemPromptCachingSummary(
    event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>,
    strategyPayload: Record<string, unknown> | undefined
): string {
    const before = getNumber(strategyPayload, "systemMessageCountBefore");
    const after = getNumber(strategyPayload, "systemMessageCountAfter");
    const tagged = getNumber(strategyPayload, "taggedSystemMessageCount");

    if (event.reason === "no-system-messages") {
        return "Skipped system prompt caching because the prompt has no system messages.";
    }

    if (before !== undefined && after !== undefined) {
        const taggedSuffix = tagged !== undefined
            ? `; kept ${formatCount(tagged, "tagged reminder")}.`
            : ".";
        return clipTelemetrySummary(
            `Reordered system messages and consolidated ${formatTelemetryNumber(before)} into ${formatTelemetryNumber(after)}${taggedSuffix}`
        );
    }

    return clipTelemetrySummary(
        `Adjusted the system-message prefix because ${humanizeToken(event.reason)}.`
    );
}

function buildToolResultDecaySummary(
    event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>,
    strategyPayload: Record<string, unknown> | undefined
): string {
    const currentPromptTokens = getNumber(strategyPayload, "currentPromptTokens");
    const truncatedCount = getNumber(strategyPayload, "truncatedCount") ?? 0;
    const placeholderCount = getNumber(strategyPayload, "placeholderCount") ?? 0;
    const tokensSaved = Math.max(0, event.estimatedTokensBefore - event.estimatedTokensAfter);

    if (event.reason === "below-token-threshold") {
        return clipTelemetrySummary(
            `Skipped tool-result decay because the prompt is within budget at ~${formatTelemetryNumber(currentPromptTokens ?? event.estimatedTokensBefore)} tokens.`
        );
    }

    if (event.reason === "no-tool-exchanges") {
        return "Skipped tool-result decay because there were no tool exchanges to compress.";
    }

    const parts: string[] = [];
    if (truncatedCount > 0) {
        parts.push(`truncated ${formatCount(truncatedCount, "tool result")}`);
    }
    if (placeholderCount > 0) {
        parts.push(`replaced ${formatCount(placeholderCount, "older tool result")} with placeholders`);
    }

    if (parts.length === 0) {
        parts.push("compressed stale tool results");
    }

    const warningCount = getNumber(strategyPayload, "warningCount") ?? 0;
    const warningSuffix = warningCount > 0
        ? `, warned about ${formatCount(warningCount, "at-risk result")}`
        : "";

    return clipTelemetrySummary(
        `${parts.join(" and ")}, saving ~${formatTelemetryNumber(tokensSaved)} tokens (${formatTelemetryNumber(event.estimatedTokensBefore)} -> ${formatTelemetryNumber(event.estimatedTokensAfter)})${warningSuffix}.`
    );
}

function buildScratchpadSummary(
    event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>,
    strategyPayload: Record<string, unknown> | undefined
): string {
    const noteChars = getNumber(strategyPayload, "notesCharCount") ?? 0;
    const keepLastMessages = getNumber(strategyPayload, "keepLastMessages");
    const forcedToolChoice = getBoolean(strategyPayload, "forcedToolChoice") ?? false;
    const estimatedTokens = getNumber(strategyPayload, "estimatedTokens");
    const forceThresholdTokens = getNumber(strategyPayload, "forceThresholdTokens");
    const appliedOmitCount = getNumber(strategyPayload, "appliedOmitCount") ?? 0;
    const removedExchanges = event.removedToolExchangesDelta;

    const parts = [
        `Rendered scratchpad context using ${formatTelemetryNumber(noteChars)} note chars`,
        `removed ${formatCount(removedExchanges, "tool exchange")} from future context`,
    ];

    if (appliedOmitCount > 0) {
        parts.push(`applied ${formatCount(appliedOmitCount, "omit tool id")}`);
    }

    if (keepLastMessages !== undefined) {
        parts.push(`kept the last ${formatTelemetryNumber(keepLastMessages)} non-system messages`);
    }

    if (forcedToolChoice) {
        parts.push(
            `forced the next tool call to scratchpad at ~${formatTelemetryNumber(
                estimatedTokens ?? event.estimatedTokensAfter
            )} tokens${forceThresholdTokens !== undefined ? ` (threshold ~${formatTelemetryNumber(forceThresholdTokens)})` : ""}`
        );
    }

    return clipTelemetrySummary(`${parts.join("; ")}.`);
}

function buildContextUtilizationReminderSummary(
    event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>,
    strategyPayload: Record<string, unknown> | undefined
): string {
    const currentTokens = getNumber(strategyPayload, "currentTokens") ?? event.estimatedTokensBefore;
    const warningThresholdTokens = getNumber(strategyPayload, "warningThresholdTokens");
    const utilizationPercent = getNumber(strategyPayload, "utilizationPercent");
    const mode = getString(strategyPayload, "mode") ?? "generic";

    if (event.reason === "below-warning-threshold") {
        return clipTelemetrySummary(
            `Skipped ${mode} context warning because the prompt is at ~${formatTelemetryNumber(currentTokens)} tokens${warningThresholdTokens !== undefined ? `, below the ~${formatTelemetryNumber(warningThresholdTokens)} warning threshold` : ""}.`
        );
    }

    return clipTelemetrySummary(
        `Inserted a ${mode} context warning at ~${formatTelemetryNumber(currentTokens)} tokens${utilizationPercent !== undefined ? ` (${formatTelemetryNumber(utilizationPercent)}% of the working budget)` : ""}.`
    );
}

function buildContextWindowStatusSummary(
    _event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>,
    strategyPayload: Record<string, unknown> | undefined
): string {
    const estimatedPromptTokens = getNumber(strategyPayload, "estimatedPromptTokens");
    const workingBudgetUtilizationPercent = getNumber(
        strategyPayload,
        "workingBudgetUtilizationPercent"
    );
    const rawContextWindow = getNumber(strategyPayload, "rawContextWindow");
    const rawContextUtilizationPercent = getNumber(
        strategyPayload,
        "rawContextUtilizationPercent"
    );

    if (estimatedPromptTokens === undefined) {
        return "Skipped context window status because no context capacity data was available.";
    }

    const parts = [
        `Inserted context status for ~${formatTelemetryNumber(estimatedPromptTokens)} prompt tokens`,
    ];

    if (workingBudgetUtilizationPercent !== undefined) {
        parts.push(`${formatTelemetryNumber(workingBudgetUtilizationPercent)}% of the working budget`);
    }

    if (rawContextWindow !== undefined && rawContextUtilizationPercent !== undefined) {
        parts.push(
            `${formatTelemetryNumber(rawContextUtilizationPercent)}% of the raw ${formatTelemetryNumber(rawContextWindow)}-token model window`
        );
    }

    return clipTelemetrySummary(`${parts.join(", ")}.`);
}

function buildSummarizationSummary(
    event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>,
    strategyPayload: Record<string, unknown> | undefined
): string {
    const estimatedTokens = getNumber(strategyPayload, "estimatedTokens") ?? event.estimatedTokensBefore;
    const messageCount = getNumber(strategyPayload, "messagesSummarizedCount");
    const summaryCharCount = getNumber(strategyPayload, "summaryCharCount");
    const tokensSaved = Math.max(0, event.estimatedTokensBefore - event.estimatedTokensAfter);

    if (event.reason === "below-token-threshold") {
        return clipTelemetrySummary(
            `Skipped summarization because the prompt is within budget at ~${formatTelemetryNumber(estimatedTokens)} tokens.`
        );
    }

    if (event.reason === "no-summarizable-messages") {
        return "Skipped summarization because there were no older messages eligible for compression.";
    }

    return clipTelemetrySummary(
        `Summarized ${formatCount(messageCount ?? 0, "message")} into a ${formatTelemetryNumber(
            summaryCharCount ?? 0
        )}-char summary, saving ~${formatTelemetryNumber(tokensSaved)} tokens.`
    );
}

function buildFallbackStrategySummary(
    event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>
): string {
    const tokensSaved = Math.max(0, event.estimatedTokensBefore - event.estimatedTokensAfter);

    if (event.outcome === "skipped") {
        return clipTelemetrySummary(
            `${event.strategyName} skipped because ${humanizeToken(event.reason)}.`
        );
    }

    return clipTelemetrySummary(
        `${event.strategyName} applied because ${humanizeToken(event.reason)}, saving ~${formatTelemetryNumber(tokensSaved)} tokens.`
    );
}

function buildStrategyCompleteSummary(
    event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>,
    strategyPayload: Record<string, unknown> | undefined
): string {
    switch (event.strategyName) {
        case "system-prompt-caching":
            return buildSystemPromptCachingSummary(event, strategyPayload);
        case "tool-result-decay":
            return buildToolResultDecaySummary(event, strategyPayload);
        case "scratchpad":
            return buildScratchpadSummary(event, strategyPayload);
        case "context-utilization-reminder":
            return buildContextUtilizationReminderSummary(event, strategyPayload);
        case "context-window-status":
            return buildContextWindowStatusSummary(event, strategyPayload);
        case "summarization":
        case "llm-summarization":
            return buildSummarizationSummary(event, strategyPayload);
        default:
            return buildFallbackStrategySummary(event);
    }
}

function buildRuntimeCompleteSummary(
    event: Extract<ContextManagementTelemetryEvent, { type: "runtime-complete" }>
): string {
    const tokensSaved = Math.max(0, event.estimatedTokensBefore - event.estimatedTokensAfter);
    return clipTelemetrySummary(
        `Completed context management: ~${formatTelemetryNumber(event.estimatedTokensBefore)} -> ~${formatTelemetryNumber(event.estimatedTokensAfter)} tokens, saved ~${formatTelemetryNumber(tokensSaved)} tokens, removed ${formatCount(event.removedToolExchangesTotal, "tool exchange")}, pinned ${formatCount(event.pinnedToolCallIdsTotal, "tool call id")}.`
    );
}

function buildToolExecuteSummary(
    event:
        | Extract<ContextManagementTelemetryEvent, { type: "tool-execute-start" }>
        | Extract<ContextManagementTelemetryEvent, { type: "tool-execute-complete" }>
        | Extract<ContextManagementTelemetryEvent, { type: "tool-execute-error" }>
): string {
    if (event.type === "tool-execute-start") {
        return clipTelemetrySummary(
            `Executing ${event.toolName}${event.strategyName ? ` for ${event.strategyName}` : ""}.`
        );
    }

    if (event.type === "tool-execute-error") {
        return clipTelemetrySummary(
            `${event.toolName} failed${event.strategyName ? ` during ${event.strategyName}` : ""}.`
        );
    }

    if (event.toolName === "scratchpad") {
        const inputNotes = getString(event.payloads.input, "notes") ?? "";
        const omitCount = getStringArray(event.payloads.input, "omitToolCallIds")?.length ?? 0;
        const keepLastMessages = getNumber(event.payloads.input, "keepLastMessages");

        return clipTelemetrySummary(
            `Updated scratchpad: ${formatTelemetryNumber(inputNotes.length)} note chars, ${formatCount(omitCount, "omit tool id")}${keepLastMessages !== undefined ? `, keep-last-messages=${formatTelemetryNumber(keepLastMessages)}` : ""}.`
        );
    }

    return clipTelemetrySummary(
        `Executed ${event.toolName}${event.strategyName ? ` for ${event.strategyName}` : ""}.`
    );
}

function buildDerivedTelemetryAttributes(
    event: ContextManagementTelemetryEvent
): Record<string, string | number | boolean> {
    const attributes: Record<string, string | number | boolean> = {
        "context_management.event_type": event.type,
    };

    switch (event.type) {
        case "runtime-start":
            attributes["context_management.strategy_count"] = event.strategyNames.length;
            attributes["context_management.optional_tool_count"] = event.optionalToolNames.length;
            attributes["context_management.summary"] = buildRuntimeStartSummary(event);
            break;
        case "strategy-complete": {
            const strategyPayload = isRecord(event.payloads.strategy) ? event.payloads.strategy : undefined;
            const tokensSaved = Math.max(0, event.estimatedTokensBefore - event.estimatedTokensAfter);
            attributes["context_management.tokens_saved"] = tokensSaved;
            attributes["context_management.summary"] = buildStrategyCompleteSummary(
                event,
                strategyPayload
            );

            switch (event.strategyName) {
                case "system-prompt-caching":
                    addAttribute(
                        attributes,
                        "context_management.system_message_count_before",
                        getNumber(strategyPayload, "systemMessageCountBefore")
                    );
                    addAttribute(
                        attributes,
                        "context_management.system_message_count_after",
                        getNumber(strategyPayload, "systemMessageCountAfter")
                    );
                    addAttribute(
                        attributes,
                        "context_management.tagged_system_message_count",
                        getNumber(strategyPayload, "taggedSystemMessageCount")
                    );
                    break;
                case "tool-result-decay":
                    addAttribute(
                        attributes,
                        "context_management.current_prompt_tokens",
                        getNumber(strategyPayload, "currentPromptTokens")
                    );
                    addAttribute(
                        attributes,
                        "context_management.truncated_tool_result_count",
                        getNumber(strategyPayload, "truncatedCount")
                    );
                    addAttribute(
                        attributes,
                        "context_management.placeholder_tool_result_count",
                        getNumber(strategyPayload, "placeholderCount")
                    );
                    addAttribute(
                        attributes,
                        "context_management.total_tool_exchanges",
                        getNumber(strategyPayload, "totalToolExchanges")
                    );
                    addAttribute(
                        attributes,
                        "context_management.warning_count",
                        getNumber(strategyPayload, "warningCount")
                    );
                    break;
                case "scratchpad": {
                    addAttribute(
                        attributes,
                        "context_management.notes_char_count",
                        getNumber(strategyPayload, "notesCharCount")
                    );
                    addAttribute(
                        attributes,
                        "context_management.applied_omit_tool_call_id_count",
                        getNumber(strategyPayload, "appliedOmitCount")
                    );
                    addAttribute(
                        attributes,
                        "context_management.keep_last_messages",
                        getNumber(strategyPayload, "keepLastMessages")
                    );
                    addAttribute(
                        attributes,
                        "context_management.forced_tool_choice",
                        getBoolean(strategyPayload, "forcedToolChoice")
                    );
                    addAttribute(
                        attributes,
                        "context_management.force_threshold_tokens",
                        getNumber(strategyPayload, "forceThresholdTokens")
                    );
                    addAttribute(
                        attributes,
                        "context_management.estimated_prompt_tokens",
                        getNumber(strategyPayload, "estimatedTokens")
                    );
                    break;
                }
                case "context-utilization-reminder":
                    addAttribute(
                        attributes,
                        "context_management.current_prompt_tokens",
                        getNumber(strategyPayload, "currentTokens")
                    );
                    addAttribute(
                        attributes,
                        "context_management.warning_threshold_tokens",
                        getNumber(strategyPayload, "warningThresholdTokens")
                    );
                    addAttribute(
                        attributes,
                        "context_management.utilization_percent",
                        getNumber(strategyPayload, "utilizationPercent")
                    );
                    break;
                case "context-window-status":
                    addAttribute(
                        attributes,
                        "context_management.estimated_prompt_tokens",
                        getNumber(strategyPayload, "estimatedPromptTokens")
                    );
                    addAttribute(
                        attributes,
                        "context_management.working_budget_utilization_percent",
                        getNumber(strategyPayload, "workingBudgetUtilizationPercent")
                    );
                    addAttribute(
                        attributes,
                        "context_management.raw_context_window",
                        getNumber(strategyPayload, "rawContextWindow")
                    );
                    addAttribute(
                        attributes,
                        "context_management.raw_context_utilization_percent",
                        getNumber(strategyPayload, "rawContextUtilizationPercent")
                    );
                    break;
                case "summarization":
                case "llm-summarization":
                    addAttribute(
                        attributes,
                        "context_management.messages_summarized_count",
                        getNumber(strategyPayload, "messagesSummarizedCount")
                    );
                    addAttribute(
                        attributes,
                        "context_management.summary_char_count",
                        getNumber(strategyPayload, "summaryCharCount")
                    );
                    break;
            }
            break;
        }
        case "tool-execute-start":
        case "tool-execute-complete":
        case "tool-execute-error":
            attributes["context_management.summary"] = buildToolExecuteSummary(event);
            if (event.toolName === "scratchpad") {
                addAttribute(
                    attributes,
                    "context_management.notes_char_count",
                    (getString(event.payloads.input, "notes") ?? "").length
                );
                addAttribute(
                    attributes,
                    "context_management.omit_tool_call_id_count",
                    getStringArray(event.payloads.input, "omitToolCallIds")?.length
                );
                addAttribute(
                    attributes,
                    "context_management.keep_last_messages",
                    getNumber(event.payloads.input, "keepLastMessages")
                );
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
    const attributes: Record<string, string | number | boolean> = {
        "context_management.request_context_json": serializeTelemetryValue(
            "requestContext" in event ? event.requestContext : null
        ),
    };

    switch (event.type) {
        case "runtime-start":
            attributes["context_management.strategy_names"] = event.strategyNames.join(",");
            attributes["context_management.optional_tool_names"] = event.optionalToolNames.join(",");
            attributes["context_management.estimated_tokens_before"] =
                event.estimatedTokensBefore;
            attributes["context_management.message_count"] = event.messageCount;
            attributes["context_management.provider_options_json"] = serializeTelemetryValue(
                event.payloads.providerOptions
            );
            break;
        case "strategy-complete":
            attributes["context_management.strategy_name"] = event.strategyName;
            attributes["context_management.outcome"] = event.outcome;
            attributes["context_management.reason"] = event.reason;
            attributes["context_management.estimated_tokens_before"] =
                event.estimatedTokensBefore;
            attributes["context_management.estimated_tokens_after"] =
                event.estimatedTokensAfter;
            attributes["context_management.removed_tool_exchanges_delta"] =
                event.removedToolExchangesDelta;
            attributes["context_management.removed_tool_exchanges_total"] =
                event.removedToolExchangesTotal;
            attributes["context_management.pinned_tool_call_ids_delta"] =
                event.pinnedToolCallIdsDelta;
            addAttribute(
                attributes,
                "context_management.working_token_budget",
                event.workingTokenBudget
            );
            attributes["context_management.message_count_before"] = event.messageCountBefore;
            attributes["context_management.message_count_after"] = event.messageCountAfter;
            attributes["context_management.strategy_payloads_json"] = serializeTelemetryValue(
                event.payloads.strategy ?? null
            );
            break;
        case "tool-execute-start":
            attributes["context_management.tool_name"] = event.toolName;
            addAttribute(
                attributes,
                "context_management.strategy_name",
                event.strategyName
            );
            addAttribute(
                attributes,
                "context_management.tool_call_id",
                event.toolCallId
            );
            attributes["context_management.tool_input_json"] = serializeTelemetryValue(
                event.payloads.input
            );
            break;
        case "tool-execute-complete":
            attributes["context_management.tool_name"] = event.toolName;
            addAttribute(
                attributes,
                "context_management.strategy_name",
                event.strategyName
            );
            addAttribute(
                attributes,
                "context_management.tool_call_id",
                event.toolCallId
            );
            attributes["context_management.tool_input_json"] = serializeTelemetryValue(
                event.payloads.input
            );
            attributes["context_management.tool_result_json"] = serializeTelemetryValue(
                event.payloads.result
            );
            break;
        case "tool-execute-error":
            attributes["context_management.tool_name"] = event.toolName;
            addAttribute(
                attributes,
                "context_management.strategy_name",
                event.strategyName
            );
            addAttribute(
                attributes,
                "context_management.tool_call_id",
                event.toolCallId
            );
            attributes["context_management.tool_input_json"] = serializeTelemetryValue(
                event.payloads.input
            );
            attributes["context_management.tool_error_json"] = serializeTelemetryValue(
                event.payloads.error
            );
            break;
        case "runtime-complete":
            attributes["context_management.estimated_tokens_before"] =
                event.estimatedTokensBefore;
            attributes["context_management.estimated_tokens_after"] =
                event.estimatedTokensAfter;
            attributes["context_management.removed_tool_exchanges_total"] =
                event.removedToolExchangesTotal;
            attributes["context_management.pinned_tool_call_ids_total"] =
                event.pinnedToolCallIdsTotal;
            attributes["context_management.message_count_before"] = event.messageCountBefore;
            attributes["context_management.message_count_after"] = event.messageCountAfter;
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
}

function emitTelemetryEvent(event: ContextManagementTelemetryEvent): void {
    const span = trace.getActiveSpan();
    if (!span) {
        return;
    }

    span.addEvent(buildTelemetryEventName(event), buildTelemetryAttributes(event));
}

function createSummarizationModel(options: {
    conversationId: string;
    agent: AgentInstance;
}): LanguageModel | undefined {
    try {
        const configName = configService.getSummarizationModelName();
        const llmService = configService.createLLMService(configName, {
            agentName: "context-summarizer",
            sessionId: `context-summarizer-${options.conversationId}-${options.agent.pubkey}`,
            conversationId: options.conversationId,
        });
        return llmService.createLanguageModel();
    } catch {
        trace.getActiveSpan()?.addEvent(
            "context_management.summarization_model_unavailable",
            {
                "context_management.conversation_id": options.conversationId,
                "context_management.agent_id": options.agent.pubkey,
            }
        );
        return undefined;
    }
}

function createConversationContextManagementRuntime(options: {
    conversationStore: ConversationStore;
    conversationId: string;
    agent: AgentInstance;
    scratchpadAvailable: boolean;
}): ContextManagementRuntime {
    const estimator = createDefaultPromptTokenEstimator();
    const strategies: ContextManagementStrategy[] = [
        new SystemPromptCachingStrategy(),
        new ToolResultDecayStrategy({ estimator }),
    ];

    const summarizationModel = createSummarizationModel({
        conversationId: options.conversationId,
        agent: options.agent,
    });

    if (summarizationModel) {
        strategies.push(
            new LLMSummarizationStrategy({
                model: summarizationModel,
                maxPromptTokens: Math.floor(
                    DEFAULT_WORKING_TOKEN_BUDGET * (DEFAULT_SUMMARIZATION_THRESHOLD_PERCENT / 100)
                ),
                estimator,
            })
        );
    }

    if (options.scratchpadAvailable) {
        strategies.push(
            new ScratchpadStrategy({
                scratchpadStore: {
                    get: ({ agentId }) =>
                        options.conversationStore.getContextManagementScratchpad(agentId),
                    set: async ({ agentId }, state) => {
                        options.conversationStore.setContextManagementScratchpad(agentId, state);
                        await options.conversationStore.save();
                    },
                    listConversation: (conversationId) =>
                        conversationId === options.conversationStore.getId()
                            ? options.conversationStore.listContextManagementScratchpads()
                            : [],
                },
                reminderTone: "informational",
                workingTokenBudget: DEFAULT_WORKING_TOKEN_BUDGET,
                forceToolThresholdRatio: DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT / 100,
                estimator,
            })
        );
    }

    strategies.push(
        new ContextUtilizationReminderStrategy({
            workingTokenBudget: DEFAULT_WORKING_TOKEN_BUDGET,
            warningThresholdRatio: DEFAULT_WARNING_THRESHOLD_PERCENT / 100,
            mode: options.scratchpadAvailable ? "scratchpad" : "generic",
            estimator,
        })
    );

    strategies.push(
        new ContextWindowStatusStrategy({
            workingTokenBudget: DEFAULT_WORKING_TOKEN_BUDGET,
            estimator,
            getContextWindow: ({ model }) => {
                if (!model) {
                    return undefined;
                }

                return getContextWindow(
                    normalizeProviderId(model.provider),
                    model.modelId
                );
            },
        })
    );

    return createContextManagementRuntime({
        strategies,
        telemetry: emitTelemetryEvent,
        estimator,
        reminderSink: createSystemReminderSink(getSystemReminderContext()),
    });
}

export function createExecutionContextManagement(options: {
    providerId: string;
    conversationId: string;
    agent: AgentInstance;
    conversationStore: ConversationStore;
    nudgeToolPermissions?: NudgeToolPermissions;
}): ExecutionContextManagement | undefined {
    if (isResumableProvider(options.providerId)) {
        return undefined;
    }

    const scratchpadAvailable =
        !options.nudgeToolPermissions || !isOnlyToolMode(options.nudgeToolPermissions);

    const runtime = createConversationContextManagementRuntime({
        conversationStore: options.conversationStore,
        conversationId: options.conversationId,
        agent: options.agent,
        scratchpadAvailable,
    });
    const optionalTools = scratchpadAvailable
        ? (runtime.optionalTools as unknown as Record<string, AISdkTool>)
        : {};

    return {
        middleware: runtime.middleware as LanguageModelMiddleware,
        optionalTools,
        requestContext: {
            conversationId: options.conversationId,
            agentId: options.agent.pubkey,
            agentLabel: options.agent.name || options.agent.slug,
        },
    };
}

export { CONTEXT_MANAGEMENT_KEY };
