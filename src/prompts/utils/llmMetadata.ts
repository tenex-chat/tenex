import { openRouterPricing } from "@/llm/pricing";
import type { CompletionResponse } from "@/llm/types";
import type { LLMMetadata } from "@/nostr/types";
import type { Message } from "multi-llm-ts";

interface ResponseWithUsage {
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens?: number;
    };
    experimental_providerMetadata?: {
        openrouter?: { usage?: { total_cost?: number } };
    };
    model?: string;
}

export async function buildLLMMetadata(
    response: CompletionResponse,
    messages: Message[]
): Promise<LLMMetadata | undefined> {
    if (!response.usage) {
        return undefined;
    }

    // Convert CompletionResponse to ResponseWithUsage format
    const responseWithUsage: ResponseWithUsage = {
        usage: {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.prompt_tokens + response.usage.completion_tokens,
        },
        model:
            "model" in response && typeof response.model === "string" ? response.model : undefined,
        experimental_providerMetadata:
            "experimental_providerMetadata" in response
                ? (response.experimental_providerMetadata as ResponseWithUsage["experimental_providerMetadata"])
                : undefined,
    };

    const model = responseWithUsage.model || "unknown";
    const cost = await calculateCost(responseWithUsage, model);

    const systemPrompt = messages.find((m) => m.role === "system")?.content;
    const userPrompt = messages.find((m) => m.role === "user")?.content;

    return {
        model,
        cost,
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.prompt_tokens + response.usage.completion_tokens,
        systemPrompt,
        userPrompt,
        rawResponse: response.content,
    };
}

export async function calculateCost(response: ResponseWithUsage, model: string): Promise<number> {
    // Check if OpenRouter already calculated the cost
    const openRouterCost = response.experimental_providerMetadata?.openrouter?.usage?.total_cost;
    if (openRouterCost !== undefined) {
        return openRouterCost;
    }

    // Calculate cost based on model pricing
    const modelId = await openRouterPricing.findModelId(model);
    if (modelId && response.usage) {
        return await openRouterPricing.calculateCost(
            modelId,
            response.usage.promptTokens,
            response.usage.completionTokens
        );
    }

    // Fallback: rough estimate based on typical pricing
    if (response.usage) {
        const { promptTokens, completionTokens } = response.usage;
        return ((promptTokens + completionTokens) / 1_000_000) * 1.0;
    }

    return 0;
}
