/**
 * Helper to attach Claude Code's built-in tools to a language model.
 * This ensures the AI SDK is aware of built-in tools and doesn't mark them as invalid.
 */

import type { LanguageModelV2FunctionTool } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { getClaudeCodeBuiltInTools } from "./ClaudeCodeBuiltInTools";

/**
 * Extended LanguageModel interface with built-in tools property.
 * Claude Code's built-in tools are attached to prevent "invalid tool call" errors.
 */
export interface LanguageModelWithTools extends LanguageModel {
    tools: Record<string, LanguageModelV2FunctionTool>;
}

/**
 * Type guard to check if a model has tools attached.
 */
export function hasTools(model: LanguageModel): model is LanguageModelWithTools {
    return "tools" in model && typeof model.tools === "object" && model.tools !== null;
}

/**
 * Ensures a language model has Claude Code's built-in tools attached.
 * If the model already has tools, it's returned as-is.
 * Otherwise, built-in tools are added to prevent "invalid tool call" errors.
 *
 * @param model - The language model to enhance
 * @returns The model with built-in tools attached
 */
export function ensureBuiltInTools(model: LanguageModel): LanguageModelWithTools {
    // Check if model already has tools property using type guard
    if (hasTools(model)) {
        return model;
    }

    // Get built-in tools and convert to record indexed by name
    const builtInTools = getClaudeCodeBuiltInTools();
    const toolsMap = builtInTools.reduce(
        (acc, tool) => {
            acc[tool.name] = tool;
            return acc;
        },
        {} as Record<string, LanguageModelV2FunctionTool>
    );

    // Attach tools to model and return with proper type
    const modelWithTools = Object.assign(model, { tools: toolsMap });
    return modelWithTools as LanguageModelWithTools;
}
