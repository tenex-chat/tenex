import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { createRAGSearchTool } from "@/tools/implementations/rag_search";
import { createRAGAddDocumentsTool } from "@/tools/implementations/rag_add_documents";
import { createRAGCollectionCreateTool } from "@/tools/implementations/rag_collection_create";
import { createRAGCollectionDeleteTool } from "@/tools/implementations/rag_collection_delete";
import { createRAGCollectionListTool } from "@/tools/implementations/rag_collection_list";

export function createTools(context: ToolExecutionContext): Record<string, AISdkTool> {
    return {
        rag_search: createRAGSearchTool(context),
        rag_add_documents: createRAGAddDocumentsTool(context),
        rag_collection_create: createRAGCollectionCreateTool(context),
        rag_collection_delete: createRAGCollectionDeleteTool(context),
        rag_collection_list: createRAGCollectionListTool(context),
    };
}
