/**
 * Image Generation Tool
 *
 * Generates images using OpenRouter's image-capable models via the multimodal chat pattern.
 * Uses generateText with providerOptions.openrouter.image_config for aspect ratio and size.
 *
 * The generated image is automatically uploaded to Blossom storage and a URL is returned.
 * This avoids returning large base64 payloads that would exceed LLM context limits.
 */

import * as crypto from "node:crypto";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import {
    ImageGenerationService,
    OPENROUTER_IMAGE_MODELS,
    ASPECT_RATIOS,
    IMAGE_SIZES,
} from "@/services/image/ImageGenerationService";
import { config } from "@/services/ConfigService";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
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

const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Get Blossom server configuration from global config
 */
async function getBlossomConfig(): Promise<{ serverUrl: string }> {
    try {
        const tenexConfig = await config.loadTenexConfig(config.getGlobalPath());
        return {
            serverUrl: tenexConfig.blossomServerUrl || "https://blossom.primal.net",
        };
    } catch {
        return {
            serverUrl: "https://blossom.primal.net",
        };
    }
}

/**
 * Calculate SHA256 hash of data
 */
function calculateSHA256(data: Buffer): string {
    return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Get file extension from MIME type
 */
function getExtensionFromMimeType(mimeType: string): string {
    const extensions: Record<string, string> = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
    };
    return extensions[mimeType] || ".png";
}

/**
 * Create Blossom authorization event (kind 24242)
 */
async function createAuthEvent(
    sha256Hash: string,
    description: string,
    context: ToolExecutionContext
): Promise<NDKEvent> {
    const event = new NDKEvent();
    event.kind = 24242;
    event.content = description;
    event.created_at = Math.floor(Date.now() / 1000);
    event.tags = [
        ["t", "upload"],
        ["x", sha256Hash],
        ["expiration", String(Math.floor(Date.now() / 1000) + 3600)], // 1 hour expiration
    ];

    await context.agent.sign(event);
    return event;
}

interface BlossomUploadResult {
    url: string;
    sha256: string;
    size: number;
    type?: string;
}

/**
 * Upload image data to Blossom server
 */
async function uploadToBlossomServer(
    serverUrl: string,
    data: Buffer,
    mimeType: string,
    authEvent: NDKEvent
): Promise<BlossomUploadResult> {
    const authHeader = `Nostr ${Buffer.from(JSON.stringify(authEvent.rawEvent())).toString("base64")}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

    try {
        const response = await fetch(`${serverUrl}/upload`, {
            method: "PUT",
            headers: {
                Authorization: authHeader,
                "Content-Type": mimeType,
                "Content-Length": String(data.length),
            },
            body: data,
            signal: controller.signal,
        });

        if (!response.ok) {
            let errorMessage = `Upload failed with status ${response.status}`;
            try {
                const errorData = (await response.json()) as { message?: string };
                if (errorData.message) {
                    errorMessage = `Upload failed: ${errorData.message}`;
                }
            } catch {
                // If parsing JSON fails, use the default error message
            }
            throw new Error(errorMessage);
        }

        const result = (await response.json()) as BlossomUploadResult;

        // Add extension to URL if not present
        if (result.url && !result.url.match(/\.\w+$/)) {
            const ext = getExtensionFromMimeType(mimeType);
            result.url = result.url + ext;
        }

        return result;
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Upload timed out after ${UPLOAD_TIMEOUT_MS}ms`, { cause: error });
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

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

    // Convert base64 to Buffer for upload
    const imageData = Buffer.from(result.base64, "base64");
    const sha256Hash = calculateSHA256(imageData);

    logger.info(`Image generated, uploading to Blossom`, {
        size: imageData.length,
        mimeType: result.mimeType,
        sha256: sha256Hash.slice(0, 12) + "...",
    });

    // Get Blossom server config and upload
    const blossomConfig = await getBlossomConfig();
    const authEvent = await createAuthEvent(
        sha256Hash,
        `Generated image: ${prompt.slice(0, 100)}`,
        context
    );

    const uploadResult = await uploadToBlossomServer(
        blossomConfig.serverUrl,
        imageData,
        result.mimeType,
        authEvent
    );

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
