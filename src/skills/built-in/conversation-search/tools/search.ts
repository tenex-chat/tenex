import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { createConversationGetTool } from "@/tools/implementations/conversation_get";
import { createConversationListTool } from "@/tools/implementations/conversation_list";
import { createConversationSearchTool } from "@/tools/implementations/conversation_search";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    return {
        conversation_get: createConversationGetTool(context),
        conversation_list: createConversationListTool(context),
        conversation_search: createConversationSearchTool(context),
    };
}
