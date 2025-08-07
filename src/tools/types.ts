/**
 * Simplified tool system for TENEX
 */

import { z } from "zod";
import type { ParameterSchema, Validated, ToolError, Result, Tool } from "./core";
import { createZodSchema } from "./zod-schema";
import type { ExecutionContext } from "@/agents/execution/types";

// Re-export core types
export * from "./core";
export * from "./executor";
export * from "./zod-schema";

// Re-export unified ExecutionContext from agents
export type { ExecutionContext } from "@/agents/execution/types";

/**
 * Helper function to create a tool's parameters object directly from a Zod schema
 */
export function defineToolParameters<T>(schema: z.ZodType<T>): ParameterSchema<T> {
    return createZodSchema(schema);
}

/**
 * Helper function to create a complete tool definition with less boilerplate
 */
export function createToolDefinition<Input, Output>(config: {
    name: string;
    description: string;
    schema: z.ZodType<Input>;
    promptFragment?: string;
    execute: (
        input: Validated<Input>,
        context: ExecutionContext
    ) => Promise<Result<ToolError, Output>>;
}): Tool<Input, Output> {
    return {
        name: config.name,
        description: config.description,
        parameters: defineToolParameters(config.schema),
        promptFragment: config.promptFragment,
        execute: config.execute,
    };
}
