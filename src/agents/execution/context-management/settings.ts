import { config as configService } from "@/services/ConfigService";

export const DEFAULT_WORKING_TOKEN_BUDGET = 40000;
export const DEFAULT_WARNING_THRESHOLD_PERCENT = 70;
export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 90;
export const DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT = 70;

export interface ContextManagementStrategyToggles {
    systemPromptCaching: boolean;
    scratchpad: boolean;
    toolResultDecay: boolean;
    compaction: boolean;
    contextUtilizationReminder: boolean;
    contextWindowStatus: boolean;
}

export interface ContextManagementSettings {
    enabled: boolean;
    tokenBudget: number;
    forceScratchpadThresholdPercent: number;
    utilizationWarningThresholdPercent: number;
    compactionThresholdPercent: number;
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

export function getContextManagementSettings(): ContextManagementSettings {
    const raw = configService.getContextManagementConfig();

    const rawStrategies = raw?.strategies;

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
        strategies: {
            systemPromptCaching: rawStrategies?.systemPromptCaching !== false,
            scratchpad: rawStrategies?.scratchpad !== false,
            toolResultDecay: rawStrategies?.toolResultDecay !== false,
            compaction: rawStrategies?.compaction !== false,
            contextUtilizationReminder: rawStrategies?.contextUtilizationReminder !== false,
            contextWindowStatus: rawStrategies?.contextWindowStatus !== false,
        },
    };
}
