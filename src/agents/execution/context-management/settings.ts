import { config as configService } from "@/services/ConfigService";

export const DEFAULT_WORKING_TOKEN_BUDGET = 40000;
export const DEFAULT_WARNING_THRESHOLD_PERCENT = 70;
export const DEFAULT_SUMMARIZATION_THRESHOLD_PERCENT = 90;
export const DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT = 70;

export interface ContextManagementSettings {
    enabled: boolean;
    tokenBudget: number;
    forceScratchpadThresholdPercent: number;
    utilizationWarningThresholdPercent: number;
    summarizationFallbackThresholdPercent: number;
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
        summarizationFallbackThresholdPercent: normalizePercent(
            raw?.summarizationFallbackThresholdPercent,
            DEFAULT_SUMMARIZATION_THRESHOLD_PERCENT
        ),
    };
}
