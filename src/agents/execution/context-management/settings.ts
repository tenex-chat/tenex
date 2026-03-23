import { config as configService } from "@/services/ConfigService";

export const DEFAULT_WORKING_TOKEN_BUDGET = 40000;
export const DEFAULT_WARNING_THRESHOLD_PERCENT = 70;
export const DEFAULT_SUMMARIZATION_THRESHOLD_PERCENT = 90;
export const DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT = 70;

export interface ContextManagementSettings {
    tokenBudget: number;
    scratchpadEnabled: boolean;
    forceScratchpadEnabled: boolean;
    forceScratchpadThresholdPercent: number;
    utilizationWarningEnabled: boolean;
    utilizationWarningThresholdPercent: number;
    summarizationFallbackEnabled: boolean;
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
