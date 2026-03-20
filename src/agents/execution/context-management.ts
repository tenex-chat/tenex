import { context as otelContext, trace, type Span } from "@opentelemetry/api";
import type {
    LanguageModelV3CallOptions,
    LanguageModelV3Message,
    LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import type { LanguageModel, LanguageModelMiddleware } from "ai";
import {
    CONTEXT_MANAGEMENT_KEY,
    ScratchpadStrategy,
    SummarizationStrategy,
    SystemPromptCachingStrategy,
    createContextManagementRuntime,
    createDefaultPromptTokenEstimator,
    type ContextManagementRequestContext,
    type ContextManagementRuntime,
    type ContextManagementStrategy,
    type ContextManagementStrategyExecution,
    type ContextManagementStrategyState,
    type ContextManagementTelemetryEvent,
    type PromptTokenEstimator,
} from "ai-sdk-context-management";
import { createSystemReminderSink } from "ai-sdk-system-reminders";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { getContextWindow } from "@/llm/utils/context-window-cache";
import { config as configService } from "@/services/ConfigService";
import { isOnlyToolMode, type NudgeToolPermissions } from "@/services/nudge";
import type { AISdkTool } from "@/tools/types";

const DEFAULT_WORKING_TOKEN_BUDGET = 72000;
const DEFAULT_WARNING_THRESHOLD_PERCENT = 70;
const DEFAULT_SUMMARIZATION_THRESHOLD_PERCENT = 90;
const DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT = 70;
const MANAGED_CONTEXT_BUDGET_SCOPE = "managed-context";

interface ContextManagementSettings {
    enabled: boolean;
    tokenBudget: number;
    scratchpadEnabled: boolean;
    forceScratchpadEnabled: boolean;
    forceScratchpadThresholdPercent: number;
    utilizationWarningEnabled: boolean;
    utilizationWarningThresholdPercent: number;
    summarizationFallbackEnabled: boolean;
    summarizationFallbackThresholdPercent: number;
}

export interface ExecutionContextManagement {
    middleware: LanguageModelMiddleware;
    optionalTools: Record<string, AISdkTool>;
    requestContext: ContextManagementRequestContext;
}

function normalizeProviderId(providerId: string): string {
    return providerId.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
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

function getRuntimeCompletePayload(
    event: Extract<ContextManagementTelemetryEvent, { type: "runtime-complete" }>
): {
    prompt?: LanguageModelV3Prompt;
    providerOptions?: unknown;
    toolChoice?: unknown;
} {
    const payloads = event.payloads;
    return {
        prompt: Array.isArray(payloads.prompt) ? payloads.prompt as LanguageModelV3Prompt : undefined,
        providerOptions: payloads.providerOptions,
        ...(payloads.toolChoice !== undefined ? { toolChoice: payloads.toolChoice } : {}),
    };
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

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : fallback;
}

function normalizePercent(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.min(100, Math.max(0, value))
        : fallback;
}

function getContextManagementSettings(): ContextManagementSettings {
    const raw = configService.getContextManagementConfig();

    return {
        enabled: raw?.enabled ?? true,
        tokenBudget: Math.floor(
            normalizePositiveNumber(raw?.tokenBudget, DEFAULT_WORKING_TOKEN_BUDGET)
        ),
        scratchpadEnabled: raw?.scratchpadEnabled ?? true,
        forceScratchpadEnabled: raw?.forceScratchpadEnabled ?? true,
        forceScratchpadThresholdPercent: normalizePercent(
            raw?.forceScratchpadThresholdPercent,
            DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT
        ),
        utilizationWarningEnabled: raw?.utilizationWarningEnabled ?? true,
        utilizationWarningThresholdPercent: normalizePercent(
            raw?.utilizationWarningThresholdPercent,
            DEFAULT_WARNING_THRESHOLD_PERCENT
        ),
        summarizationFallbackEnabled: raw?.summarizationFallbackEnabled ?? true,
        summarizationFallbackThresholdPercent: normalizePercent(
            raw?.summarizationFallbackThresholdPercent,
            DEFAULT_SUMMARIZATION_THRESHOLD_PERCENT
        ),
    };
}

function isManagedContextSystemMessage(message: LanguageModelV3Message): boolean {
    if (message.role !== "system") {
        return false;
    }

    const contextManagementOptions = message.providerOptions?.contextManagement;
    if (!isRecord(contextManagementOptions)) {
        return false;
    }

    const type = contextManagementOptions.type;
    return type === "summary" || type === "compaction-summary";
}

function createManagedContextTokenEstimator(
    baseEstimator: PromptTokenEstimator
): PromptTokenEstimator {
    return {
        estimateMessage(message: LanguageModelV3Message): number {
            if (message.role === "system" && !isManagedContextSystemMessage(message)) {
                return 0;
            }

            return baseEstimator.estimateMessage(message);
        },
        estimatePrompt(prompt: LanguageModelV3Prompt): number {
            return prompt.reduce((sum, message) => sum + this.estimateMessage(message), 0);
        },
        estimateTools(): number {
            return 0;
        },
    };
}

function estimateRequestTokens(
    estimator: PromptTokenEstimator,
    prompt: LanguageModelV3Prompt,
    tools: LanguageModelV3CallOptions["tools"]
): number {
    return estimator.estimatePrompt(prompt) + (estimator.estimateTools?.(tools) ?? 0);
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

function formatPercent(numerator: number, denominator: number): number {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
        return 0;
    }

    return Math.round((numerator / denominator) * 100);
}

function buildManagedContextUtilizationReminder(options: {
    currentTokens: number;
    warningThresholdTokens: number;
    utilizationPercent: number;
    mode: "scratchpad" | "generic";
}): string {
    const { currentTokens, warningThresholdTokens, utilizationPercent, mode } = options;
    const lines = [
        `[Context utilization: ~${formatTelemetryNumber(utilizationPercent)}% of managed working budget]`,
        `Managed working-context tokens: ~${formatTelemetryNumber(currentTokens)}. Warning threshold: ~${formatTelemetryNumber(warningThresholdTokens)}.`,
        "This excludes base system prompts, tool definitions, and reminder blocks.",
    ];

    if (mode === "scratchpad") {
        lines.push("Your managed working context is getting tight. Use scratchpad(...) now to:");
        lines.push("- Rewrite your current working state so it reflects what matters now");
        lines.push("- Update key/value entries and notes for current progress, findings, and next steps");
        lines.push("- Omit stale tool call IDs you no longer need");
        lines.push("- Reduce keepLastMessages if the recent tail is larger than necessary");
    } else {
        lines.push("Your managed working context is getting tight. Trim or summarize stale working context before continuing.");
    }

    lines.push("[/Context utilization]");
    return lines.join("\n");
}

class ManagedContextUtilizationReminderStrategy implements ContextManagementStrategy {
    readonly name = "context-utilization-reminder";
    private readonly workingTokenBudget: number;
    private readonly warningThresholdRatio: number;
    private readonly estimator: PromptTokenEstimator;
    private readonly mode: "scratchpad" | "generic";

    constructor(options: {
        workingTokenBudget: number;
        warningThresholdRatio?: number;
        estimator: PromptTokenEstimator;
        mode?: "scratchpad" | "generic";
    }) {
        this.workingTokenBudget = Math.max(1, Math.floor(options.workingTokenBudget));
        this.warningThresholdRatio = Math.min(
            1,
            Math.max(0, options.warningThresholdRatio ?? (DEFAULT_WARNING_THRESHOLD_PERCENT / 100))
        );
        this.estimator = options.estimator;
        this.mode = options.mode ?? "generic";
    }

    async apply(
        state: ContextManagementStrategyState
    ): Promise<ContextManagementStrategyExecution> {
        const currentTokens = estimateRequestTokens(this.estimator, state.prompt, state.params?.tools);
        const warningThresholdTokens = Math.floor(this.workingTokenBudget * this.warningThresholdRatio);

        if (currentTokens < warningThresholdTokens) {
            return {
                reason: "below-warning-threshold",
                workingTokenBudget: this.workingTokenBudget,
                payloads: {
                    currentTokens,
                    warningThresholdTokens,
                    warningThresholdRatio: this.warningThresholdRatio,
                    mode: this.mode,
                    budgetScope: MANAGED_CONTEXT_BUDGET_SCOPE,
                },
            };
        }

        const utilizationPercent = formatPercent(currentTokens, this.workingTokenBudget);
        const reminderText = buildManagedContextUtilizationReminder({
            currentTokens,
            warningThresholdTokens,
            utilizationPercent,
            mode: this.mode,
        });

        await state.emitReminder({
            kind: "context-utilization",
            content: reminderText,
        });

        return {
            reason: "warning-injected",
            workingTokenBudget: this.workingTokenBudget,
            payloads: {
                currentTokens,
                warningThresholdTokens,
                warningThresholdRatio: this.warningThresholdRatio,
                utilizationPercent,
                mode: this.mode,
                budgetScope: MANAGED_CONTEXT_BUDGET_SCOPE,
                reminderText,
            },
        };
    }
}

function buildManagedContextWindowStatusReminder(options: {
    estimatedRequestTokens: number;
    estimatedMessageTokens: number;
    estimatedToolTokens: number;
    managedContextTokens: number;
    staticOverheadTokens: number;
    rawContextWindow?: number;
    workingTokenBudget: number;
}): string {
    const {
        estimatedRequestTokens,
        estimatedMessageTokens,
        estimatedToolTokens,
        managedContextTokens,
        staticOverheadTokens,
        rawContextWindow,
        workingTokenBudget,
    } = options;
    const lines = [
        "[Context status]",
        `Current request after context management: ~${formatTelemetryNumber(estimatedRequestTokens)} tokens.`,
        `Managed working context: ~${formatTelemetryNumber(managedContextTokens)} tokens.`,
    ];

    if (staticOverheadTokens > 0) {
        lines.push(
            `Static overhead outside the working budget: ~${formatTelemetryNumber(staticOverheadTokens)} tokens.`
        );
    }

    if (estimatedToolTokens > 0) {
        lines.push(
            `Breakdown: ~${formatTelemetryNumber(estimatedMessageTokens)} message tokens + ~${formatTelemetryNumber(estimatedToolTokens)} tool-definition tokens.`
        );
    }

    lines.push(
        `Working budget target (managed context only): ~${formatTelemetryNumber(workingTokenBudget)} tokens (~${formatTelemetryNumber(formatPercent(managedContextTokens, workingTokenBudget))}% used).`
    );

    if (rawContextWindow !== undefined) {
        lines.push(
            `Raw model context window: ~${formatTelemetryNumber(rawContextWindow)} tokens (~${formatTelemetryNumber(formatPercent(estimatedRequestTokens, rawContextWindow))}% used).`
        );
    }

    lines.push("[/Context status]");
    return lines.join("\n");
}

class ManagedContextWindowStatusStrategy implements ContextManagementStrategy {
    readonly name = "context-window-status";
    private readonly workingTokenBudget: number;
    private readonly managedEstimator: PromptTokenEstimator;
    private readonly requestEstimator: PromptTokenEstimator;
    private readonly getContextWindow?: (options: {
        model?: { provider: string; modelId: string };
        requestContext: ContextManagementRequestContext;
    }) => number | undefined;

    constructor(options: {
        workingTokenBudget: number;
        managedEstimator: PromptTokenEstimator;
        requestEstimator: PromptTokenEstimator;
        getContextWindow?: (options: {
            model?: { provider: string; modelId: string };
            requestContext: ContextManagementRequestContext;
        }) => number | undefined;
    }) {
        this.workingTokenBudget = Math.max(1, Math.floor(options.workingTokenBudget));
        this.managedEstimator = options.managedEstimator;
        this.requestEstimator = options.requestEstimator;
        this.getContextWindow = options.getContextWindow;
    }

    async apply(
        state: ContextManagementStrategyState
    ): Promise<ContextManagementStrategyExecution> {
        const estimatedMessageTokens = this.requestEstimator.estimatePrompt(state.prompt);
        const estimatedToolTokens = this.requestEstimator.estimateTools?.(state.params?.tools) ?? 0;
        const estimatedRequestTokens = estimatedMessageTokens + estimatedToolTokens;
        const managedContextTokens = estimateRequestTokens(
            this.managedEstimator,
            state.prompt,
            state.params?.tools
        );
        const staticOverheadTokens = Math.max(0, estimatedRequestTokens - managedContextTokens);
        const rawContextWindow = this.getContextWindow?.({
            model: state.model,
            requestContext: state.requestContext,
        });
        const reminderText = buildManagedContextWindowStatusReminder({
            estimatedRequestTokens,
            estimatedMessageTokens,
            estimatedToolTokens,
            managedContextTokens,
            staticOverheadTokens,
            rawContextWindow,
            workingTokenBudget: this.workingTokenBudget,
        });

        await state.emitReminder({
            kind: "context-window-status",
            content: reminderText,
        });

        return {
            reason: "context-window-status-injected",
            workingTokenBudget: this.workingTokenBudget,
            payloads: {
                estimatedPromptTokens: estimatedRequestTokens,
                estimatedMessageTokens,
                estimatedToolTokens,
                managedContextTokens,
                staticOverheadTokens,
                rawContextWindow,
                rawContextUtilizationPercent: rawContextWindow !== undefined
                    ? formatPercent(estimatedRequestTokens, rawContextWindow)
                    : undefined,
                workingTokenBudget: this.workingTokenBudget,
                workingBudgetUtilizationPercent: formatPercent(
                    managedContextTokens,
                    this.workingTokenBudget
                ),
                budgetScope: MANAGED_CONTEXT_BUDGET_SCOPE,
                reminderText,
            },
        };
    }
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



function buildScratchpadSummary(
    event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>,
    strategyPayload: Record<string, unknown> | undefined
): string {
    const entryCount = getNumber(strategyPayload, "entryCount") ?? 0;
    const entryCharCount = getNumber(strategyPayload, "entryCharCount") ?? 0;
    const keepLastMessages = getNumber(strategyPayload, "keepLastMessages");
    const forcedToolChoice = getBoolean(strategyPayload, "forcedToolChoice") ?? false;
    const estimatedTokens = getNumber(strategyPayload, "estimatedTokens");
    const forceThresholdTokens = getNumber(strategyPayload, "forceThresholdTokens");
    const appliedOmitCount = getNumber(strategyPayload, "appliedOmitCount") ?? 0;
    const removedExchanges = event.removedToolExchangesDelta;

    const parts = [
        `Rendered scratchpad context using ${formatCount(entryCount, "entry", "entries")} across ~${formatTelemetryNumber(entryCharCount)} chars`,
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
    const budgetScope = getString(strategyPayload, "budgetScope");
    const scopeLabel = budgetScope === MANAGED_CONTEXT_BUDGET_SCOPE
        ? "managed context"
        : "prompt";
    const budgetLabel = budgetScope === MANAGED_CONTEXT_BUDGET_SCOPE
        ? "managed working budget"
        : "working budget";

    if (event.reason === "below-warning-threshold") {
        return clipTelemetrySummary(
            `Skipped ${mode} context warning because the ${scopeLabel} is at ~${formatTelemetryNumber(currentTokens)} tokens${warningThresholdTokens !== undefined ? `, below the ~${formatTelemetryNumber(warningThresholdTokens)} warning threshold` : ""}.`
        );
    }

    return clipTelemetrySummary(
        `Inserted a ${mode} context warning at ~${formatTelemetryNumber(currentTokens)} ${scopeLabel} tokens${utilizationPercent !== undefined ? ` (${formatTelemetryNumber(utilizationPercent)}% of the ${budgetLabel})` : ""}.`
    );
}

function buildContextWindowStatusSummary(
    _event: Extract<ContextManagementTelemetryEvent, { type: "strategy-complete" }>,
    strategyPayload: Record<string, unknown> | undefined
): string {
    const estimatedPromptTokens = getNumber(strategyPayload, "estimatedPromptTokens");
    const managedContextTokens = getNumber(strategyPayload, "managedContextTokens");
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

    const parts = managedContextTokens !== undefined
        ? [
            `Inserted context status for ~${formatTelemetryNumber(managedContextTokens)} managed-context tokens (~${formatTelemetryNumber(estimatedPromptTokens)} total request tokens)`,
        ]
        : [`Inserted context status for ~${formatTelemetryNumber(estimatedPromptTokens)} request tokens`];

    if (workingBudgetUtilizationPercent !== undefined) {
        parts.push(
            `${formatTelemetryNumber(workingBudgetUtilizationPercent)}% of the managed working budget`
        );
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
        const omitCount = getStringArray(event.payloads.input, "omitToolCallIds")?.length ?? 0;
        const setEntriesCount = getRecordKeyCount(event.payloads.input, "setEntries") ?? 0;
        const replaceEntriesCount = getRecordKeyCount(event.payloads.input, "replaceEntries") ?? 0;
        const removeEntryKeysCount = getStringArray(event.payloads.input, "removeEntryKeys")?.length ?? 0;
        const keepLastMessages = getNumber(event.payloads.input, "keepLastMessages");
        const entryCharCount = (getRecordStringCharCount(event.payloads.input, "setEntries") ?? 0)
            + (getRecordStringCharCount(event.payloads.input, "replaceEntries") ?? 0);

        return clipTelemetrySummary(
            `Updated scratchpad: ${formatCount(setEntriesCount + replaceEntriesCount, "entry update", "entry updates")} across ~${formatTelemetryNumber(entryCharCount)} chars, ${formatCount(removeEntryKeysCount, "entry removal", "entry removals")}, ${formatCount(omitCount, "omit tool id")}${keepLastMessages !== undefined ? `, keep-last-messages=${formatTelemetryNumber(keepLastMessages)}` : ""}.`
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
                case "scratchpad": {
                    addAttribute(
                        attributes,
                        "context_management.entry_count",
                        getNumber(strategyPayload, "entryCount")
                    );
                    addAttribute(
                        attributes,
                        "context_management.entry_char_count",
                        getNumber(strategyPayload, "entryCharCount")
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
                    addAttribute(
                        attributes,
                        "context_management.budget_scope",
                        getString(strategyPayload, "budgetScope")
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
                        "context_management.managed_context_tokens",
                        getNumber(strategyPayload, "managedContextTokens")
                    );
                    addAttribute(
                        attributes,
                        "context_management.static_overhead_tokens",
                        getNumber(strategyPayload, "staticOverheadTokens")
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
                    addAttribute(
                        attributes,
                        "context_management.budget_scope",
                        getString(strategyPayload, "budgetScope")
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
                    "context_management.entry_char_count",
                    (getRecordStringCharCount(event.payloads.input, "setEntries") ?? 0)
                        + (getRecordStringCharCount(event.payloads.input, "replaceEntries") ?? 0)
                );
                addAttribute(
                    attributes,
                    "context_management.entry_update_count",
                    (getRecordKeyCount(event.payloads.input, "setEntries") ?? 0)
                        + (getRecordKeyCount(event.payloads.input, "replaceEntries") ?? 0)
                );
                addAttribute(
                    attributes,
                    "context_management.entry_removal_count",
                    getStringArray(event.payloads.input, "removeEntryKeys")?.length
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
            {
                const payload = getRuntimeCompletePayload(event);
                if (payload?.prompt !== undefined) {
                    attributes["context_management.final_prompt_json"] = serializeTelemetryValue(
                        payload.prompt
                    );
                }
                if (payload?.providerOptions !== undefined) {
                    attributes["context_management.final_provider_options_json"] =
                        serializeTelemetryValue(payload.providerOptions);
                }
                if (payload?.toolChoice !== undefined) {
                    attributes["context_management.final_tool_choice_json"] =
                        serializeTelemetryValue(payload.toolChoice);
                }
            }
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

function createTelemetryCallback(): (event: ContextManagementTelemetryEvent) => void {
    const tracer = trace.getTracer("tenex");
    let runtimeSpan: Span | undefined;

    return (event: ContextManagementTelemetryEvent): void => {
        const attributes = buildTelemetryAttributes(event);
        const eventName = buildTelemetryEventName(event);

        if (event.type === "runtime-start") {
            runtimeSpan = tracer.startSpan(
                "tenex.context_management",
                { attributes },
                otelContext.active()
            );
            runtimeSpan.addEvent(eventName, attributes);
            return;
        }

        if (event.type === "runtime-complete") {
            if (runtimeSpan) {
                runtimeSpan.addEvent(eventName, attributes);
                runtimeSpan.setAttribute(
                    "context_management.estimated_tokens_before",
                    event.estimatedTokensBefore
                );
                runtimeSpan.setAttribute(
                    "context_management.estimated_tokens_after",
                    event.estimatedTokensAfter
                );
                runtimeSpan.setAttribute(
                    "context_management.message_count_before",
                    event.messageCountBefore
                );
                runtimeSpan.setAttribute(
                    "context_management.message_count_after",
                    event.messageCountAfter
                );
                runtimeSpan.end();
                runtimeSpan = undefined;
            }
            return;
        }

        // For strategy-complete and tool-execute-* events, add to the runtime
        // span if it exists, otherwise fall back to the active span (handles
        // pre-runtime tool execution like scratchpad tools).
        const span = runtimeSpan ?? trace.getActiveSpan();
        if (span) {
            span.addEvent(eventName, attributes);
        }
    };
}

function createSummarizationModel(options: {
    conversationId: string;
    agent: AgentInstance;
}): LanguageModel | undefined {
    try {
        const configName = configService.getSummarizationModelName();
        const llmService = configService.createLLMService(configName, {
            agentName: "context-summarizer",
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
    const settings = getContextManagementSettings();
    const requestEstimator = createDefaultPromptTokenEstimator();
    const managedContextEstimator = createManagedContextTokenEstimator(requestEstimator);
    const scratchpadEnabled = settings.scratchpadEnabled && options.scratchpadAvailable;

    const strategies: ContextManagementStrategy[] = [
        new SystemPromptCachingStrategy(),
    ];

    const summarizationModel = createSummarizationModel({
        conversationId: options.conversationId,
        agent: options.agent,
    });

    if (summarizationModel && settings.summarizationFallbackEnabled) {
        strategies.push(
            new SummarizationStrategy({
                model: summarizationModel,
                maxPromptTokens: Math.floor(
                    settings.tokenBudget
                        * (settings.summarizationFallbackThresholdPercent / 100)
                ),
                estimator: managedContextEstimator,
            })
        );
    }

    if (scratchpadEnabled) {
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
                workingTokenBudget: settings.tokenBudget,
                forceToolThresholdRatio: settings.forceScratchpadEnabled
                    ? settings.forceScratchpadThresholdPercent / 100
                    : undefined,
                estimator: managedContextEstimator,
            })
        );
    }

    if (settings.utilizationWarningEnabled) {
        strategies.push(
            new ManagedContextUtilizationReminderStrategy({
                workingTokenBudget: settings.tokenBudget,
                warningThresholdRatio: settings.utilizationWarningThresholdPercent / 100,
                mode: scratchpadEnabled ? "scratchpad" : "generic",
                estimator: managedContextEstimator,
            })
        );
    }

    strategies.push(
        new ManagedContextWindowStatusStrategy({
            workingTokenBudget: settings.tokenBudget,
            managedEstimator: managedContextEstimator,
            requestEstimator,
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
        telemetry: createTelemetryCallback(),
        estimator: requestEstimator,
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
    const settings = getContextManagementSettings();

    if (!settings.enabled) {
        return undefined;
    }

    const scratchpadAvailable =
        settings.scratchpadEnabled
        && (!options.nudgeToolPermissions || !isOnlyToolMode(options.nudgeToolPermissions));

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
