/**
 * Image Generation Tool
 *
 * Generates images using OpenRouter's image-capable models via the multimodal chat pattern.
 * Uses generateText with providerOptions.openrouter.image_config for aspect ratio and size.
 */

import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import {
    ImageGenerationService,
    OPENROUTER_IMAGE_MODELS,
    ASPECT_RATIOS,
    IMAGE_SIZES,
} from "@/services/image/ImageGenerationService";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

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
    /** Base64-encoded image data */
    base64: string;
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
    /** Note about using the image */
    note: string;
}

async function executeGenerateImage(
    input: GenerateImageInput
): Promise<GenerateImageOutput> {
    const { prompt, aspect_ratio, image_size, model } = input;

    logger.info(`Generating image`, {
        promptPreview: prompt.slice(0, 100) + (prompt.length > 100 ? "..." : ""),
        aspectRatio: aspect_ratio,
        imageSize: image_size,
        model,
    });

    // Create the service (will load config and validate API key)
    const service = await ImageGenerationService.create();

    // Get effective config from the service (avoids loading config twice)
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

    return {
        success: true,
        base64: result.base64,
        mimeType: result.mimeType,
        prompt,
        model: result.model,
        aspectRatio: effectiveAspectRatio,
        imageSize: effectiveImageSize,
        note: "The image is returned as base64. To save it permanently, use the upload_blob tool to upload it to Blossom storage.",
    };
}

export function createGenerateImageTool(_context: ToolExecutionContext): AISdkTool {
    const modelList = OPENROUTER_IMAGE_MODELS.map(
        (m) => `${m.name} (${m.value})`
    ).join(", ");

    const toolInstance = tool({
        description:
            `Generate an image from a text description using OpenRouter's image-capable models. ` +
            `Returns the image as base64 data. For best results, provide detailed prompts describing ` +
            `the subject, style, composition, colors, lighting, and mood. ` +
            `Available models: ${modelList}. ` +
            `IMPORTANT: Image generation costs money. Use sparingly and only when the user explicitly requests image generation.`,

        inputSchema: generateImageSchema,

        execute: async (input: GenerateImageInput) => {
            try {
                return await executeGenerateImage(input);
            } catch (error) {
                const errorMsg = formatAnyError(error);
                logger.error("Image generation failed", { error, prompt: input.prompt?.slice(0, 100) });

                // Handle common errors with user-friendly messages
                if (errorMsg.includes("content_policy") || errorMsg.includes("safety")) {
                    throw new Error(
                        "Image generation was blocked due to content policy. " +
                        "Please revise your prompt to avoid potentially inappropriate content.",
                        { cause: error }
                    );
                }

                if (errorMsg.includes("rate_limit") || errorMsg.includes("quota")) {
                    throw new Error(
                        "Image generation rate limit reached. Please wait a moment and try again.",
                        { cause: error }
                    );
                }

                if (errorMsg.includes("API key") || errorMsg.includes("authentication") || errorMsg.includes("apiKey")) {
                    throw new Error(
                        "Image generation is not configured. Run 'tenex setup image' to configure it.",
                        { cause: error }
                    );
                }

                if (errorMsg.includes("OpenRouter API key required")) {
                    throw new Error(
                        "OpenRouter API key not configured. Run 'tenex setup providers' and add your OpenRouter API key.",
                        { cause: error }
                    );
                }

                throw new Error(`Image generation failed: ${errorMsg}`, { cause: error });
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
