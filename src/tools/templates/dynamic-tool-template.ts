import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/registry";
import { tool } from "ai";
import { z } from "zod";

/**
 * Dynamic Tool Template
 *
 * This template provides the structure for dynamically created tools.
 *
 * File naming convention: agent_{agentId}_{toolName}.ts
 *
 * The default export MUST be a factory function that:
 * 1. Takes an ExecutionContext as parameter
 * 2. Returns an AISdkTool (CoreTool with optional getHumanReadableContent)
 *
 * Example usage:
 * ```typescript
 * const createMyTool: DynamicToolFactory = (context) => {
 *   return tool({
 *     description: 'My custom tool description',
 *     inputSchema: z.object({
 *       param1: z.string().describe('First parameter'),
 *       param2: z.number().nullable().describe('Optional second parameter')
 *     }),
 *     execute: async (input) => {
 *       // Tool implementation here
 *       return `Result: ${input.param1}`;
 *     }
 *   });
 * };
 *
 * export default createMyTool;
 * ```
 */

// Define the input schema for your tool using Zod
const toolSchema = z.object({
    // TODO: Define your input parameters here
    exampleParam: z.string().describe("An example parameter"),
    optionalParam: z.number().nullable().describe("An optional numeric parameter"),
});

// Type for the tool input (inferred from schema)
type ToolInput = z.infer<typeof toolSchema>;

/**
 * Factory function to create the dynamic tool
 * This function MUST be the default export
 */
const createDynamicTool = (context: ExecutionContext): AISdkTool => {
    // Create the tool using the AI SDK's tool function
    const aiTool = tool({
        // Tool description - this is shown to the LLM
        description: "TODO: Add a clear description of what this tool does",

        // Input schema for validation
        inputSchema: toolSchema,

        // Execute function - the main tool logic
        execute: async (input: ToolInput) => {
            // Access context properties if needed
            const { agent, conversationId, agentPublisher } = context;

            // TODO: Implement your tool logic here
            // You can:
            // - Access the file system
            // - Make API calls
            // - Execute commands
            // - Interact with other services
            // - Publish status updates via agentPublisher

            // Example: Log the execution
            console.log(`[${agent.name}] Executing dynamic tool with params:`, input);

            // Example: Publish a status update
            if (agentPublisher && context.triggeringEvent) {
                try {
                    const conversation = context.getConversation();
                    if (conversation?.history?.[0]) {
                        await agentPublisher.conversation(
                            { content: `⚡ Processing: ${input.exampleParam}` },
                            {
                                triggeringEvent: context.triggeringEvent,
                                rootEvent: conversation.history[0],
                                conversationId,
                            }
                        );
                    }
                } catch (error) {
                    console.warn("Failed to publish status:", error);
                }
            }

            // Return your result
            // This can be a string, object, or any serializable data
            return {
                success: true,
                message: `Processed: ${input.exampleParam}`,
                timestamp: new Date().toISOString(),
            };
        },
    });

    // Optionally add human-readable content generation
    // This is used for displaying tool calls in a user-friendly way
    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: (input: ToolInput) => {
            return `Processing: ${input.exampleParam}${input.optionalParam ? ` with value ${input.optionalParam}` : ""}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool;
};

// IMPORTANT: The default export MUST be the factory function
export default createDynamicTool;
