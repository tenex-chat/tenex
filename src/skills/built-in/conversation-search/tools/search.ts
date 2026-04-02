import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { createConversationSearchTool } from "@/tools/implementations/conversation_search";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    return {
        conversation_search: createConversationSearchTool(context),
    };
}
