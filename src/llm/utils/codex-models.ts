/**
 * Codex Model Discovery Utilities
 *
 * Provides functions to discover available Codex models and their capabilities,
 * including supported reasoning effort levels.
 */

import { listModels } from "ai-sdk-provider-codex-cli";

interface CodexListModelInfo {
    id: string;
    name?: string | null;
    description?: string | null;
    isDefault?: boolean | null;
}

export interface CodexModelOption {
    id: string;
    displayName: string;
    description: string;
    isDefault: boolean;
}

/**
 * List available Codex models with their reasoning effort options
 */
export async function listCodexModels(): Promise<CodexModelOption[]> {
    const { models } = await listModels();

    return models.map((model: CodexListModelInfo) => ({
        id: model.id,
        displayName: model.name ?? model.id,
        description: model.description ?? "",
        isDefault: model.isDefault === true,
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
    const defaultMark = model.isDefault ? " (default)" : "";
    return `${model.id}${defaultMark}\n  ${model.description}`;
}
