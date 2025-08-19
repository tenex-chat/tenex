import { formatAnyError } from "@/utils/error-formatter";
import { getToolLogger } from "@/tools/toolLogger";
import type {
    Tool,
    ExecutionContext,
    ToolExecutor,
    ToolError,
    ToolExecutionResult,
} from "@/tools/types";
import { createToolExecutor } from "@/tools/types";
import { logger } from "@/utils/logger";
import {
    Plugin,
    type PluginExecutionContext,
    type PluginParameter as MultiLLMPluginParameter,
} from "multi-llm-ts";
import { serializeToolResult } from "./ToolResult";

/**
 * Adapter that converts TENEX Tool to multi-llm-ts Plugin
 * Handles all tool types with unified interface
 */
export class ToolPlugin extends Plugin {
    private readonly executor: ToolExecutor;

    constructor(
        private readonly tool: Tool,
        private readonly tenexContext: ExecutionContext
    ) {
        super();
        this.executor = createToolExecutor(tenexContext);
    }

    serializeInTools(): boolean {
        return true;
    }

    isEnabled(): boolean {
        return true;
    }

    getName(): string {
        return this.tool.name;
    }

    getDescription(): string {
        return this.tool.description;
    }

    getRunningDescription(tool: string, args: Record<string, unknown>): string {
        // For the continue tool specifically, provide a concise description
        if (this.tool.name === "continue") {
            const phase = (args.phase as string) || "next phase";
            const agents = (args.agents as string[])?.join(", ") || "specified agents";
            return `Routing conversation to ${phase} with ${agents}`;
        }

        // For other tools, provide a generic running description
        return `Executing ${tool} tool`;
    }

    getParameters(): MultiLLMPluginParameter[] {
        // Extract parameter info from schema shape
        const shape = this.tool.parameters.shape;

        if (shape.type === "object" && shape.properties) {
            return Object.entries(shape.properties).map(([name, prop]) => {
                const param: MultiLLMPluginParameter = {
                    name,
                    type: this.mapSchemaTypeToPluginType(prop.type),
                    description: prop.description,
                    required: shape.required?.includes(name) ?? false,
                };

                // Add enum values if present
                if (prop.type === "string" && prop.enum) {
                    param.enum = [...prop.enum];
                }

                return param;
            });
        }

        return [];
    }

    private mapSchemaTypeToPluginType(
        schemaType: string
    ): "string" | "number" | "boolean" | "array" | "object" {
        switch (schemaType) {
            case "string":
                return "string";
            case "number":
                return "number";
            case "boolean":
                return "boolean";
            case "array":
                return "array";
            case "object":
                return "object";
            default:
                return "string";
        }
    }

    /**
     * Check if a tool should skip publishing tool use events
     * Some tools handle their own event publishing or shouldn't show indicators
     */
    private shouldSkipToolUseEvent(toolName: string): boolean {
        const skipTools = [
            'claude_code',  // Handles its own event publishing
            // Add other tools here that shouldn't publish tool use events
        ];
        return skipTools.includes(toolName.toLowerCase());
    }

    /**
     * Get human-readable description for a tool
     * This should match the descriptions in ToolStreamHandler
     */
    private getToolDescription(toolName: string, args: Record<string, unknown>): string {
        switch (toolName) {
            // Core tool operations
            case "read_path":
                return `📖 Reading ${args.path || "file"}`;
            case "write_context_file":
                return `✏️ Writing context to ${args.filePath || "file"}`;
            case "shell":
                return `🖥️ Executing shell command: ${(args.command as string || "").substring(0, 50)}${(args.command as string || "").length > 50 ? "..." : ""}`;
            case "analyze":
                return `🔬 Analyzing code with prompt: "${(args.prompt as string || "").substring(0, 50)}..."`;
            case "generate_inventory":
                return `📃 Generating inventory`;
            case "lesson_learn":
                return `🎓 Learning lesson: ${args.title || "new lesson"}`;
            case "lesson_get":
                return `📖 Getting lesson: ${args.id || "lesson"}`;
            case "agents_discover":
                return `🔍 Discovering available agents`;
            case "agents_hire":
                return `🤖 Hiring agent: ${args.agentId || "agent"}`;
            case "discover_capabilities":
                return `🔌 Discovering MCP capabilities`;
            case "delegate":
                return `🔄 Delegating task: ${args.description || args.title || "task"}`;
            case "delegate_phase":
                return `📋 Switching to ${args.phase || "new"} phase and delegating`;
            case "nostr_projects":
                return `📡 Managing Nostr projects`;
            case "complete":
                return `✅ Completing task and returning control`;
            default:
                // For MCP tools or unknown tools
                if (toolName.startsWith("mcp__")) {
                    const parts = toolName.split("__");
                    const provider = parts[1] || "mcp";
                    const action = parts[2] || "action";
                    return `🔌 Using ${provider} to ${action.replace(/_/g, " ")}`;
                }
                return `🛠️ Using ${toolName}`;
        }
    }

    async execute(
        _context: PluginExecutionContext,
        parameters: Record<string, unknown>
    ): Promise<unknown> {
        const startTime = Date.now();

        try {
            // Normalize parameters to handle edge cases from LLMs
            let normalizedParameters = parameters;
            
            // Some LLMs send empty strings "" for tools with no required parameters
            // Convert these to empty objects for proper validation
            if (typeof parameters === "string" && parameters === "") {
                normalizedParameters = {};
                logger.debug(`Normalized empty string to empty object for tool: ${this.tool.name}`);
            }
            // Also handle null/undefined edge cases
            else if (parameters === null || parameters === undefined) {
                normalizedParameters = {};
                logger.debug(`Normalized null/undefined to empty object for tool: ${this.tool.name}`);
            }
            
            logger.debug(`Executing tool: ${this.tool.name}`, {
                tool: this.tool.name,
                parameters: normalizedParameters,
                parameterKeys: typeof normalizedParameters === 'object' && normalizedParameters !== null 
                    ? Object.keys(normalizedParameters) 
                    : [],
                agentId: this.tenexContext.agent.pubkey,
                conversationId: this.tenexContext.conversationId,
                phase: this.tenexContext.phase,
            });

            // Note: Stream handling is now done by AgentStreamer at a higher level
            // Tools no longer need to manage streaming directly

            // Execute the tool using the type-safe executor
            const result = await this.executor.execute(this.tool, normalizedParameters);
            const endTime = Date.now();

            // Serialize the typed result for transport through LLM layer
            const serializedResult = serializeToolResult(result);

            // Create a human-readable output message
            let outputMessage = "";
            if (result.success && result.output !== undefined) {
                const output = result.output;

                // Check if it's a control flow result
                if (typeof output === "object" && output !== null && "type" in output) {
                    // Check if it's a termination result
                    if (
                        output.type === "complete" &&
                        "completion" in output &&
                        typeof output.completion === "object" &&
                        output.completion !== null &&
                        "response" in output.completion &&
                        typeof output.completion.response === "string"
                    ) {
                        outputMessage = output.completion.response;
                    }
                }
                // Regular tool output
                else {
                    outputMessage = String(result.output);
                }
            } else {
                outputMessage = "";
            }

            // Extract error message if present
            const errorMessage = result.error ? this.formatError(result.error) : undefined;

            // Return both serialized result and human-readable output
            const processedResult = {
                success: result.success,
                output: outputMessage,
                error: errorMessage,
                duration: result.duration,
                // Include the full typed result for ReasonActLoop
                __typedResult: serializedResult,
            };

            // Log the successful tool execution
            const toolLogger = getToolLogger();
            if (toolLogger) {
                await toolLogger.logToolCall(
                    this.tool.name,
                    parameters,
                    this.tenexContext,
                    result, // Pass the original typed result
                    {
                        startTime,
                        endTime,
                    }
                );
            }

            logger.debug(`Tool execution completed: ${this.tool.name}`, {
                tool: this.tool.name,
                success: result.success,
                duration: result.duration,
                hasOutput: !!result.output,
                hasError: !!result.error,
            });

            return processedResult;
        } catch (error) {
            const endTime = Date.now();
            const duration = endTime - startTime;

            // Create an error result for logging
            const errorResult: ToolExecutionResult = {
                success: false,
                output: undefined,
                error: {
                    kind: "execution",
                    tool: this.tool.name,
                    message: formatAnyError(error),
                },
                duration,
            };

            // Log the failed tool execution
            const toolLogger = getToolLogger();
            if (toolLogger) {
                await toolLogger.logToolCall(
                    this.tool.name,
                    parameters,
                    this.tenexContext,
                    errorResult,
                    {
                        startTime,
                        endTime,
                    }
                );
            }

            logger.error(`Tool execution failed: ${this.tool.name}`, {
                tool: this.tool.name,
                error: formatAnyError(error),
                duration,
                parameters,
            });

            const errorMessage = formatAnyError(error);
            return {
                success: false,
                output: "",
                error: errorMessage,
                duration,
                __typedResult: serializeToolResult(errorResult),
            };
        }
    }

    private formatError(error: ToolError): string {
        switch (error.kind) {
            case "validation":
                // If the field is empty and message is just "Required", make it clearer
                if (error.field === "" && error.message === "Required") {
                    return `Validation error: Missing required parameter`;
                }
                return `Validation error in ${error.field}: ${error.message}`;
            case "execution":
                return `Execution error: ${error.message}`;
            case "system":
                return `System error: ${error.message}`;
            default:
                return `Unknown error: No details available`;
        }
    }
}
