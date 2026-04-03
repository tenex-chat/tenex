import { config as configService } from "@/services/ConfigService";

export const DEFAULT_WORKING_TOKEN_BUDGET = 40000;
export const DEFAULT_WARNING_THRESHOLD_PERCENT = 70;
export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 90;
export const DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT = 70;
export const DEFAULT_ANTHROPIC_PROMPT_CACHING_TTL = "1h" as const;
export const DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_TRIGGER_TOOL_USES = 25;
export const DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_KEEP_TOOL_USES = 10;
export const DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_CLEAR_AT_LEAST_INPUT_TOKENS = 4000;
export const DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_CLEAR_TOOL_INPUTS = true;
export const DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_EXCLUDE_TOOLS = [
    "delegate",
    "delegate_followup",
    "delegate_crossproject",
] as const;

export interface ContextManagementStrategyToggles {
    anthropicPromptCaching: boolean;
    reminders: boolean;
    scratchpad: boolean;
    toolResultDecay: boolean;
    compaction: boolean;
    contextUtilizationReminder: boolean;
    contextWindowStatus: boolean;
}

export interface AnthropicServerToolEditingSettings {
    enabled: boolean;
    triggerToolUses: number;
    keepToolUses: number;
    clearAtLeastInputTokens: number;
    clearToolInputs: boolean;
    excludeTools: string[];
}

export interface AnthropicPromptCachingSettings {
    ttl: "5m" | "1h";
    serverToolEditing: AnthropicServerToolEditingSettings;
}

export interface ContextManagementSettings {
    enabled: boolean;
    tokenBudget: number;
    forceScratchpadThresholdPercent: number;
    utilizationWarningThresholdPercent: number;
    compactionThresholdPercent: number;
    anthropicPromptCaching: AnthropicPromptCachingSettings;
    strategies: ContextManagementStrategyToggles;
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

function normalizeInteger(
    value: number | undefined,
    fallback: number,
    minimum: number
): number {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(minimum, Math.floor(value))
        : fallback;
}

function normalizeAnthropicPromptCachingTtl(
    value: "5m" | "1h" | undefined
): "5m" | "1h" {
    return value === "5m" || value === "1h"
        ? value
        : DEFAULT_ANTHROPIC_PROMPT_CACHING_TTL;
}

function normalizeToolList(value: string[] | undefined): string[] {
    if (!Array.isArray(value)) {
        return [...DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_EXCLUDE_TOOLS];
    }

    const normalized = value
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    return normalized.length > 0
        ? [...new Set(normalized)]
        : [...DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_EXCLUDE_TOOLS];
}

export function getContextManagementSettings(): ContextManagementSettings {
    const raw = configService.getContextManagementConfig();

    const rawStrategies = raw?.strategies;
    const rawAnthropicPromptCaching = raw?.anthropicPromptCaching;
    const rawServerToolEditing = rawAnthropicPromptCaching?.serverToolEditing;
    const anthropicPromptCaching =
        rawStrategies?.anthropicPromptCaching
        ?? rawStrategies?.systemPromptCaching
        ?? true;
    const anthropicServerToolEditingEnabled = (
        rawServerToolEditing?.enabled
        ?? rawAnthropicPromptCaching?.clearToolUses
    ) !== false;

    return {
        enabled: raw?.enabled !== false,
        tokenBudget: Math.floor(
            normalizePositiveNumber(raw?.tokenBudget, DEFAULT_WORKING_TOKEN_BUDGET)
        ),
        forceScratchpadThresholdPercent: normalizePercent(
            raw?.forceScratchpadThresholdPercent,
            DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT
        ),
        utilizationWarningThresholdPercent: normalizePercent(
            raw?.utilizationWarningThresholdPercent,
            DEFAULT_WARNING_THRESHOLD_PERCENT
        ),
        compactionThresholdPercent: normalizePercent(
            raw?.compactionThresholdPercent,
            DEFAULT_COMPACTION_THRESHOLD_PERCENT
        ),
        anthropicPromptCaching: {
            ttl: normalizeAnthropicPromptCachingTtl(rawAnthropicPromptCaching?.ttl),
            serverToolEditing: {
                enabled: anthropicServerToolEditingEnabled,
                triggerToolUses: normalizeInteger(
                    rawServerToolEditing?.triggerToolUses,
                    DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_TRIGGER_TOOL_USES,
                    1
                ),
                keepToolUses: normalizeInteger(
                    rawServerToolEditing?.keepToolUses,
                    DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_KEEP_TOOL_USES,
                    0
                ),
                clearAtLeastInputTokens: normalizeInteger(
                    rawServerToolEditing?.clearAtLeastInputTokens,
                    DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_CLEAR_AT_LEAST_INPUT_TOKENS,
                    0
                ),
                clearToolInputs:
                    rawServerToolEditing?.clearToolInputs
                    ?? DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_CLEAR_TOOL_INPUTS,
                excludeTools: normalizeToolList(rawServerToolEditing?.excludeTools),
            },
        },
        strategies: {
            anthropicPromptCaching,
            reminders: rawStrategies?.reminders !== false,
            scratchpad: rawStrategies?.scratchpad !== false,
            toolResultDecay: rawStrategies?.toolResultDecay !== false,
            compaction: rawStrategies?.compaction !== false,
            contextUtilizationReminder: rawStrategies?.contextUtilizationReminder !== false,
            contextWindowStatus: rawStrategies?.contextWindowStatus !== false,
        },
    };
}
