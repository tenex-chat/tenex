/**
 * Codex Model Discovery Utilities
 *
 * Provides functions to discover available Codex models and their capabilities,
 * including supported reasoning effort levels.
 */

import { listModels } from "ai-sdk-provider-codex-app-server";
import type { ModelInfo } from "ai-sdk-provider-codex-app-server";

export interface CodexModelOption {
    id: string;
    displayName: string;
    description: string;
    supportedReasoningEfforts: string[];
    defaultReasoningEffort: string;
    isDefault: boolean;
}

/**
 * List available Codex models with their reasoning effort options
 */
export async function listCodexModels(): Promise<CodexModelOption[]> {
    const { models } = await listModels();

    return models.map((model: ModelInfo) => ({
        id: model.id,
        displayName: model.displayName,
        description: model.description,
        supportedReasoningEfforts: model.supportedReasoningEfforts.map(
            (e) => e.reasoningEffort
        ),
        defaultReasoningEffort: model.defaultReasoningEffort,
        isDefault: model.isDefault,
    }));
}

/**
 * Get the default Codex model
 */
export async function getDefaultCodexModel(): Promise<CodexModelOption | undefined> {
    const models = await listCodexModels();
    return models.find((m) => m.isDefault);
}

/**
 * Format model info for display
 */
export function formatCodexModel(model: CodexModelOption): string {
    const efforts = model.supportedReasoningEfforts.join(", ");
    const defaultMark = model.isDefault ? " (default)" : "";
    return `${model.id}${defaultMark}\n  ${model.description}\n  Reasoning: ${efforts} (default: ${model.defaultReasoningEffort})`;
}
