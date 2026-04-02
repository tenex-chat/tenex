import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { createRAGSearchTool } from "@/tools/implementations/rag_search";
import { createRAGAddDocumentsTool } from "@/tools/implementations/rag_add_documents";
import { createRAGCollectionCreateTool } from "@/tools/implementations/rag_collection_create";
import { createRAGCollectionDeleteTool } from "@/tools/implementations/rag_collection_delete";
import { createRAGCollectionListTool } from "@/tools/implementations/rag_collection_list";
import { createRAGSubscriptionCreateTool } from "@/tools/implementations/rag_subscription_create";
import { createRAGSubscriptionDeleteTool } from "@/tools/implementations/rag_subscription_delete";
import { createRAGSubscriptionGetTool } from "@/tools/implementations/rag_subscription_get";
import { createRAGSubscriptionListTool } from "@/tools/implementations/rag_subscription_list";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    return {
        rag_search: createRAGSearchTool(context),
        rag_add_documents: createRAGAddDocumentsTool(context),
        rag_collection_create: createRAGCollectionCreateTool(context),
        rag_collection_delete: createRAGCollectionDeleteTool(context),
        rag_collection_list: createRAGCollectionListTool(context),
        rag_subscription_create: createRAGSubscriptionCreateTool(context),
        rag_subscription_delete: createRAGSubscriptionDeleteTool(context),
        rag_subscription_get: createRAGSubscriptionGetTool(context),
        rag_subscription_list: createRAGSubscriptionListTool(context),
    };
}
