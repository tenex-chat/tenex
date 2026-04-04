import { config as configService } from "@/services/ConfigService";

export const DEFAULT_WORKING_TOKEN_BUDGET = 40000;
export const DEFAULT_WARNING_THRESHOLD_PERCENT = 70;
export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 90;
export const DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT = 70;
export const DEFAULT_ANTHROPIC_PROMPT_CACHING_TTL = "1h" as const;

export interface ContextManagementStrategyToggles {
    anthropicPromptCaching: boolean;
    reminders: boolean;
    scratchpad: boolean;
    toolResultDecay: boolean;
    compaction: boolean;
    contextUtilizationReminder: boolean;
    contextWindowStatus: boolean;
}

export interface AnthropicPromptCachingSettings {
    ttl: "5m" | "1h";
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

function normalizeAnthropicPromptCachingTtl(
    value: "5m" | "1h" | undefined
): "5m" | "1h" {
    return value === "5m" || value === "1h"
        ? value
        : DEFAULT_ANTHROPIC_PROMPT_CACHING_TTL;
}

export function getContextManagementSettings(): ContextManagementSettings {
    const raw = configService.getContextManagementConfig();

    const rawStrategies = raw?.strategies;
    const rawAnthropicPromptCaching = raw?.anthropicPromptCaching;
    const anthropicPromptCaching =
        rawStrategies?.anthropicPromptCaching
        ?? rawStrategies?.systemPromptCaching
        ?? true;

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
