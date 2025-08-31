// ToolExecutionResult removed - using AI SDK tools only

/**
 * Format a tool result as a string for inclusion in the conversation
 */
export function formatToolResultAsString(result: any): string {
  const toolInfo = result.toolName ? `[${result.toolName}]` : "[Unknown Tool]";
  const argsInfo = result.toolArgs && Object.keys(result.toolArgs).length > 0
    ? ` with args: ${JSON.stringify(result.toolArgs)}`
    : "";
  
  if (result.success) {
    // Format the output as a string
    const output = result.output;
    if (typeof output === "string") {
      return `Tool ${toolInfo}${argsInfo} completed successfully:\n${output}`;
    }
    if (output !== undefined && output !== null) {
      return `Tool ${toolInfo}${argsInfo} completed successfully:\n${JSON.stringify(output, null, 2)}`;
    }
    return `Tool ${toolInfo}${argsInfo} completed successfully`;
  }
  return `Tool ${toolInfo}${argsInfo} failed with error: ${result.error?.message || "Unknown error"}`;
}