import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { createNostrPublishAsUserTool } from "@/tools/implementations/nostr_publish_as_user";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    return {
        nostr_publish_as_user: createNostrPublishAsUserTool(context),
    };
}
