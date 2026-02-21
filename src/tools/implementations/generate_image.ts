/**
 * Image Generation Tool
 *
 * Generates images using OpenRouter's image-capable models via the multimodal chat pattern.
 * Uses generateText with providerOptions.openrouter.image_config for aspect ratio and size.
 *
 * The generated image is automatically uploaded to Blossom storage and a URL is returned.
 * This avoids returning large base64 payloads that would exceed LLM context limits.
 */

import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import {
    ImageGenerationService,
    OPENROUTER_IMAGE_MODELS,
    ASPECT_RATIOS,
    IMAGE_SIZES,
} from "@/services/image/ImageGenerationService";
import { BlossomService } from "@/nostr/BlossomService";
import { config } from "@/services/ConfigService";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const DEFAULT_BLOSSOM_SERVER = "https://blossom.primal.net";

/**
 * Load Blossom server URL from config.
 * Falls back to default if config is unavailable.
 */
async function loadBlossomServerUrl(): Promise<string> {
    try {
        const tenexConfig = await config.loadTenexConfig(config.getGlobalPath());
        return tenexConfig.blossomServerUrl || DEFAULT_BLOSSOM_SERVER;
    } catch (error) {
        logger.warn("[generate_image] Failed to load Blossom config, using default", {
            error: error instanceof Error ? error.message : String(error),
        });
        return DEFAULT_BLOSSOM_SERVER;
    }
}

// Build valid model IDs from the available models
const validModelIds = OPENROUTER_IMAGE_MODELS.map((m) => m.value) as [string, ...string[]];

const generateImageSchema = z.object({
    prompt: z
        .string()
        .min(1)
        .max(4000)
        .describe(
            "A detailed description of the image to generate. Be specific about subjects, style, " +
            "composition, colors, lighting, and mood. Longer, more detailed prompts often produce better results."
        ),
    aspect_ratio: z
        .enum(ASPECT_RATIOS)
        .optional()
        .describe(
            "Aspect ratio for the image. Options: 1:1 (square), 16:9 (landscape), 9:16 (portrait), " +
            "4:3, 3:4, 3:2, 2:3. Default: 1:1"
        ),
    image_size: z
        .enum(IMAGE_SIZES)
        .optional()
        .describe(
            "Image resolution. Options: 1K, 2K, 4K. Higher resolution costs more. Default: 2K"
        ),
    model: z
        .enum(validModelIds)
        .optional()
        .describe(
            "Override the default model. Options: " +
            OPENROUTER_IMAGE_MODELS.map((m) => `${m.value} (${m.description})`).join(", ")
        ),
});

type GenerateImageInput = z.infer<typeof generateImageSchema>;

interface GenerateImageOutput {
    success: boolean;
    /** URL of the uploaded image on Blossom */
    url: string;
    /** SHA256 hash of the image */
    sha256: string;
    /** Size of the image in bytes */
    size: number;
    /** MIME type of the image */
    mimeType: string;
    /** The prompt that was used */
    prompt: string;
    /** Model used for generation */
    model: string;
    /** Aspect ratio used */
    aspectRatio: string;
    /** Image size used */
    imageSize: string;
}

/**
 * Generate an image and upload it to Blossom.
 *
 * This function orchestrates the high-level workflow:
 * 1. Create ImageGenerationService and generate the image
 * 2. Delegate upload to BlossomService
 * 3. Return the result with URL and metadata
 */
async function executeGenerateImage(
    input: GenerateImageInput,
    context: ToolExecutionContext
): Promise<GenerateImageOutput> {
    const { prompt, aspect_ratio, image_size, model } = input;

    logger.info(`Generating image`, {
        promptPreview: prompt.slice(0, 100) + (prompt.length > 100 ? "..." : ""),
        aspectRatio: aspect_ratio,
        imageSize: image_size,
        model,
    });

    // Create the image generation service
    const service = await ImageGenerationService.create();
    const effectiveConfig = service.getConfig();
    const effectiveAspectRatio = aspect_ratio || effectiveConfig.defaultAspectRatio || "1:1";
    const effectiveImageSize = image_size || effectiveConfig.defaultImageSize || "2K";
    const effectiveModel = model || effectiveConfig.model;

    // Generate the image
    const result = await service.generateImage(prompt, {
        aspectRatio: effectiveAspectRatio,
        imageSize: effectiveImageSize,
        model: effectiveModel,
    });

    // Convert base64 to Buffer for upload
    const imageData = Buffer.from(result.base64, "base64");

    logger.info(`Image generated, uploading to Blossom`, {
        size: imageData.length,
        mimeType: result.mimeType,
    });

    // Upload to Blossom using the service (delegates NDK usage to nostr layer)
    // Layer 3 (tools) loads config and passes serverUrl to Layer 2 (nostr)
    const blossomServerUrl = await loadBlossomServerUrl();
    const blossomService = new BlossomService(context.agent);
    const uploadResult = await blossomService.upload(imageData, result.mimeType, {
        serverUrl: blossomServerUrl,
        description: `Generated image: ${prompt.slice(0, 100)}`,
    });

    logger.info(`Image uploaded to Blossom`, {
        url: uploadResult.url,
        sha256: uploadResult.sha256,
        size: uploadResult.size,
    });

    return {
        success: true,
        url: uploadResult.url,
        sha256: uploadResult.sha256,
        size: uploadResult.size,
        mimeType: result.mimeType,
        prompt,
        model: result.model,
        aspectRatio: effectiveAspectRatio,
        imageSize: effectiveImageSize,
    };
}

/**
 * Map error messages to user-friendly error responses.
 *
 * Error conditions are ordered from most specific to least specific
 * to ensure proper matching.
 */
function mapErrorToUserMessage(errorMsg: string, originalError: unknown): Error {
    // Most specific first: OpenRouter API key not configured
    if (errorMsg.includes("OpenRouter API key required")) {
        return new Error(
            "OpenRouter API key not configured. Run 'tenex setup providers' and add your OpenRouter API key.",
            { cause: originalError }
        );
    }

    // Generic API key / authentication issues
    if (errorMsg.includes("API key") || errorMsg.includes("authentication") || errorMsg.includes("apiKey")) {
        return new Error(
            "Image generation is not configured. Run 'tenex setup image' to configure it.",
            { cause: originalError }
        );
    }

    // Content policy violations
    if (errorMsg.includes("content_policy") || errorMsg.includes("safety")) {
        return new Error(
            "Image generation was blocked due to content policy. " +
            "Please revise your prompt to avoid potentially inappropriate content.",
            { cause: originalError }
        );
    }

    // Rate limiting
    if (errorMsg.includes("rate_limit") || errorMsg.includes("quota")) {
        return new Error(
            "Image generation rate limit reached. Please wait a moment and try again.",
            { cause: originalError }
        );
    }

    // Generic fallback
    return new Error(`Image generation failed: ${errorMsg}`, { cause: originalError });
}

export function createGenerateImageTool(context: ToolExecutionContext): AISdkTool {
    const modelList = OPENROUTER_IMAGE_MODELS.map(
        (m) => `${m.name} (${m.value})`
    ).join(", ");

    const toolInstance = tool({
        description:
            `Generate an image from a text description using OpenRouter's image-capable models. ` +
            `The image is automatically uploaded to Blossom storage and a URL is returned. ` +
            `For best results, provide detailed prompts describing ` +
            `the subject, style, composition, colors, lighting, and mood. ` +
            `Available models: ${modelList}. ` +
            `IMPORTANT: Image generation costs money. Use sparingly and only when the user explicitly requests image generation.`,

        inputSchema: generateImageSchema,

        execute: async (input: GenerateImageInput) => {
            try {
                return await executeGenerateImage(input, context);
            } catch (error) {
                const errorMsg = formatAnyError(error);
                logger.error("Image generation failed", { error, prompt: input.prompt?.slice(0, 100) });
                throw mapErrorToUserMessage(errorMsg, error);
            }
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ prompt, aspect_ratio, image_size, model }: GenerateImageInput) => {
            const parts: string[] = [];
            if (aspect_ratio) parts.push(aspect_ratio);
            if (image_size) parts.push(image_size);
            if (model) {
                const modelInfo = OPENROUTER_IMAGE_MODELS.find((m) => m.value === model);
                parts.push(modelInfo?.name || model);
            }
            const optionsStr = parts.length > 0 ? ` (${parts.join(", ")})` : "";
            const promptPreview = prompt.length > 60 ? prompt.slice(0, 60) + "..." : prompt;
            return `Generating image${optionsStr}: "${promptPreview}"`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
