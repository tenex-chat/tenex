import type { AISdkTool, ToolExecutionContext, ConversationToolContext } from "@/tools/types";
import { createMcpListResourcesTool } from "@/tools/implementations/mcp_list_resources";
import { createMcpResourceReadTool } from "@/tools/implementations/mcp_resource_read";
import { createMcpSubscribeTool } from "@/tools/implementations/mcp_subscribe";
import { createMcpSubscriptionStopTool } from "@/tools/implementations/mcp_subscription_stop";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    return {
        mcp_list_resources: createMcpListResourcesTool(context),
        mcp_resource_read: createMcpResourceReadTool(context),
        mcp_subscribe: createMcpSubscribeTool(context as ConversationToolContext) as AISdkTool,
        mcp_subscription_stop: createMcpSubscriptionStopTool(context),
    };
}
