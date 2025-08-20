/**
 * Simplified tool executor
 */

import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import type { Tool, ToolError, Validated } from "./core";
import type { ExecutionContext } from "./types";

/**
 * Metadata that tools can provide for better UI/logging
 */
export interface ToolExecutionMetadata {
  /** Human-readable message describing what the tool is doing */
  displayMessage?: string;
  /** The actual arguments that were executed (for tools that skip tool_start) */
  executedArgs?: Record<string, unknown>;
  /** Any other metadata the tool wants to provide */
  [key: string]: unknown;
}

/**
 * Simple, unified tool execution result
 */
export interface ToolExecutionResult<T = unknown> {
  success: boolean;
  output?: T;
  error?: ToolError;
  duration: number;
  /** The name of the tool that was executed */
  toolName: string;
  /** The arguments that were passed to the tool */
  toolArgs: Record<string, unknown>;
  /** Optional metadata for UI/logging purposes */
  metadata?: ToolExecutionMetadata;
}

/**
 * Simple tool executor
 */
export class ToolExecutor {
  constructor(private readonly context: ExecutionContext) {}

  /**
   * Execute a tool with the given input
   */
  async execute<I, O>(tool: Tool<I, O>, input: unknown): Promise<ToolExecutionResult<O>> {
    const startTime = Date.now();

    try {
      // Skip validation for generate_inventory tool
      let validatedInput: Validated<I>;
      if (tool.name === "generate_inventory") {
        // Pass through any input for generate_inventory
        validatedInput = input as Validated<I>;
      } else {
        // Validate input for other tools
        const validationResult = tool.parameters.validate(input);
        if (!validationResult.ok) {
          logger.warn(`Tool validation failed for ${tool.name}`, {
            tool: tool.name,
            input,
            error: validationResult.error,
          });
          return {
            success: false,
            error: validationResult.error,
            duration: Date.now() - startTime,
            toolName: tool.name,
            toolArgs: input as Record<string, unknown>,
          };
        }
        validatedInput = validationResult.value;
      }

      // Execute the tool
      const result = await tool.execute(validatedInput, this.context);

      if (result.ok) {
        return {
          success: true,
          output: result.value,
          duration: Date.now() - startTime,
          toolName: tool.name,
          toolArgs: input as Record<string, unknown>,
          metadata: result.metadata, // Pass through metadata if present
        };
      }
      return {
        success: false,
        error: result.error,
        duration: Date.now() - startTime,
        toolName: tool.name,
        toolArgs: input as Record<string, unknown>,
      };
    } catch (error) {
      logger.error("Tool execution failed", {
        tool: tool.name,
        error: formatAnyError(error),
      });

      return {
        success: false,
        error: {
          kind: "system",
          message: formatAnyError(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        duration: Date.now() - startTime,
        toolName: tool.name,
        toolArgs: input as Record<string, unknown>,
      };
    }
  }
}

/**
 * Create a tool executor for a given context
 */
export function createToolExecutor(context: ExecutionContext): ToolExecutor {
  return new ToolExecutor(context);
}
