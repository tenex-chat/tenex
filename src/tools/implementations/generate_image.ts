/**
 * Image Generation Tool
 *
 * Generates images using AI image generation models (DALL-E 3, etc.)
 * Uses the ImageGenerationService which wraps AI SDK v6's generateImage.
 */

import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { ImageGenerationService, IMAGE_SIZES } from "@/services/image";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const generateImageSchema = z.object({
    prompt: z
        .string()
        .min(1)
        .max(4000)
        .describe(
            "A detailed description of the image to generate. Be specific about subjects, style, " +
            "composition, colors, lighting, and mood. Longer, more detailed prompts often produce better results."
        ),
    size: z
        .enum(["1024x1024", "1024x1792", "1792x1024", "256x256", "512x512"])
        .optional()
        .describe(
            "Image dimensions. DALL-E 3 supports: 1024x1024 (square), 1024x1792 (portrait), 1792x1024 (landscape). " +
            "DALL-E 2 supports: 256x256, 512x512, 1024x1024. Default: 1024x1024"
        ),
    quality: z
        .enum(["standard", "hd"])
        .optional()
        .describe(
            "Image quality (DALL-E 3 only). 'hd' creates more detailed images but costs more (~$0.08 vs $0.04). " +
            "Default: standard"
        ),
    style: z
        .enum(["natural", "vivid"])
        .optional()
        .describe(
            "Image style (DALL-E 3 only). 'vivid' produces hyper-real, dramatic images. " +
            "'natural' produces more realistic, less stylized images. Default: vivid"
        ),
});

type GenerateImageInput = z.infer<typeof generateImageSchema>;

interface GenerateImageOutput {
    success: boolean;
    /** Base64-encoded image data */
    base64: string;
    /** MIME type of the image */
    mimeType: string;
    /** The prompt that was used (may differ from input if revised by the model) */
    prompt: string;
    /** Image dimensions */
    size: string;
    /** Estimated cost of generation */
    estimatedCost: string;
    /** Note about using the image */
    note: string;
}

/**
 * Estimate cost based on model and size
 */
function estimateCost(model: string, size: string, quality?: string): string {
    if (model === "dall-e-3") {
        const isHD = quality === "hd";
        if (size === "1024x1024") {
            return isHD ? "$0.080" : "$0.040";
        }
        // Other sizes (1024x1792, 1792x1024) are more expensive
        return isHD ? "$0.120" : "$0.080";
    }
    // DALL-E 2
    if (size === "256x256") return "$0.016";
    if (size === "512x512") return "$0.018";
    return "$0.020"; // 1024x1024
}

async function executeGenerateImage(
    input: GenerateImageInput
): Promise<GenerateImageOutput> {
    const { prompt, size, quality, style } = input;

    logger.info(`Generating image`, {
        promptPreview: prompt.slice(0, 100) + (prompt.length > 100 ? "..." : ""),
        size,
        quality,
        style,
    });

    // Create the service (will load config and validate API key)
    const service = await ImageGenerationService.create();

    // Load config to get model info for cost estimation
    const imageConfig = await ImageGenerationService.loadConfiguration();
    const effectiveSize = size || imageConfig.defaultSize || "1024x1024";
    const effectiveQuality = quality || imageConfig.defaultQuality || "standard";

    // Validate size is supported by the model
    const supportedSizes = IMAGE_SIZES[imageConfig.model] || IMAGE_SIZES["dall-e-3"];
    if (!supportedSizes.includes(effectiveSize)) {
        throw new Error(
            `Size "${effectiveSize}" is not supported by ${imageConfig.model}. ` +
            `Supported sizes: ${supportedSizes.join(", ")}`
        );
    }

    // Generate the image
    const result = await service.generateImage(prompt, {
        size: effectiveSize,
        quality: effectiveQuality,
        style: style || imageConfig.defaultStyle,
    });

    const estimatedCost = estimateCost(imageConfig.model, effectiveSize, effectiveQuality);

    return {
        success: true,
        base64: result.base64,
        mimeType: result.mimeType,
        prompt: result.revisedPrompt || prompt,
        size: effectiveSize,
        estimatedCost,
        note: "The image is returned as base64. To save it permanently, use the upload_blob tool to upload it to Blossom storage.",
    };
}

export function createGenerateImageTool(_context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Generate an image from a text description using AI (DALL-E 3 by default). " +
            "Returns the image as base64 data. For best results, provide detailed prompts describing " +
            "the subject, style, composition, colors, lighting, and mood. " +
            "IMPORTANT: Image generation costs money (~$0.04-$0.12 per image). " +
            "Use sparingly and only when the user explicitly requests image generation.",

        inputSchema: generateImageSchema,

        execute: async (input: GenerateImageInput) => {
            try {
                return await executeGenerateImage(input);
            } catch (error) {
                const errorMsg = formatAnyError(error);
                logger.error("Image generation failed", { error, prompt: input.prompt?.slice(0, 100) });

                // Handle common errors with user-friendly messages
                if (errorMsg.includes("content_policy_violation") || errorMsg.includes("safety")) {
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

                throw new Error(`Image generation failed: ${errorMsg}`, { cause: error });
            }
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ prompt, size, quality }: GenerateImageInput) => {
            const sizeStr = size ? ` (${size})` : "";
            const qualityStr = quality === "hd" ? " HD" : "";
            const promptPreview = prompt.length > 60 ? prompt.slice(0, 60) + "..." : prompt;
            return `Generating${qualityStr} image${sizeStr}: "${promptPreview}"`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
