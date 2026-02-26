import * as path from "node:path";
import { fileExists, readJsonFile, writeJsonFile, ensureDirectory } from "@/lib/fs";
import { config } from "@/services/ConfigService";
import { resolveApiKey } from "@/services/config/types";
import { logger } from "@/utils/logger";

/**
 * Configuration for image generation using OpenRouter
 */
export interface ImageConfig {
    provider: "openrouter"; // Only OpenRouter is supported
    model: string; // Model ID (e.g., "black-forest-labs/flux.2-pro")
    defaultAspectRatio?: string; // Default aspect ratio (e.g., "16:9", "1:1", "9:16")
    defaultImageSize?: string; // Default image size (e.g., "1K", "2K", "4K")
}

/**
 * Options for image generation
 */
export interface ImageGenerationOptions {
    aspectRatio?: string;
    imageSize?: string;
    model?: string; // Override the default model
}

/**
 * Result of image generation
 */
export interface ImageResult {
    base64: string;
    mimeType: string;
    model: string;
}

export interface ImageConfigOptions {
    metadataPath?: string;
    projectPath?: string;
    scope?: "auto" | "project" | "global";
}

/**
 * Available OpenRouter image-capable models
 */
export const OPENROUTER_IMAGE_MODELS: Array<{
    name: string;
    value: string;
    description: string;
}> = [
    {
        name: "FLUX.2 Pro",
        value: "black-forest-labs/flux.2-pro",
        description: "High quality text-to-image",
    },
    {
        name: "FLUX.2 Max",
        value: "black-forest-labs/flux.2-max",
        description: "Top-tier quality",
    },
    {
        name: "FLUX.2 Klein",
        value: "black-forest-labs/flux.2-klein-4b",
        description: "Fast, cost-effective",
    },
    {
        name: "Gemini 2.5 Flash Image",
        value: "google/gemini-2.5-flash-image",
        description: "Multimodal with contextual understanding",
    },
];

/**
 * Valid aspect ratios for OpenRouter image generation
 */
export const ASPECT_RATIOS = [
    "1:1",
    "16:9",
    "9:16",
    "4:3",
    "3:4",
    "3:2",
    "2:3",
] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/**
 * Valid image sizes for OpenRouter image generation
 */
export const IMAGE_SIZES = ["1K", "2K", "4K"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

const IMAGE_CONFIG_FILE = "image.json";
const DEFAULT_CONFIG: ImageConfig = {
    provider: "openrouter",
    model: "black-forest-labs/flux.2-pro",
    defaultAspectRatio: "1:1",
    defaultImageSize: "2K",
};

/**
 * Service for AI image generation using OpenRouter via AI SDK
 *
 * OpenRouter uses the multimodal chat pattern - images are generated
 * via generateText and returned as file parts in the response.
 */
export class ImageGenerationService {
    private imageConfig: ImageConfig;
    private apiKey: string;

    private constructor(imageConfig: ImageConfig, apiKey: string) {
        this.imageConfig = imageConfig;
        this.apiKey = apiKey;
    }

    /**
     * Create an ImageGenerationService with configuration
     */
    static async create(
        customConfig?: ImageConfig,
        options?: ImageConfigOptions
    ): Promise<ImageGenerationService> {
        const imageConfig = customConfig || (await ImageGenerationService.loadConfiguration(options));

        // Load API key from providers.json - OpenRouter only
        const apiKey = await ImageGenerationService.loadProviderApiKey("openrouter");
        if (!apiKey) {
            throw new Error(
                "OpenRouter API key required for image generation. Configure with 'tenex setup providers'."
            );
        }

        logger.debug(`Creating image generation service: openrouter/${imageConfig.model}`);
        return new ImageGenerationService(imageConfig, apiKey);
    }

    /**
     * Generate an image from a text prompt using OpenRouter's multimodal chat pattern
     */
    async generateImage(
        prompt: string,
        options: ImageGenerationOptions = {}
    ): Promise<ImageResult> {
        const modelId = options.model || this.imageConfig.model;
        const aspectRatio = options.aspectRatio || this.imageConfig.defaultAspectRatio || "1:1";
        const imageSize = options.imageSize || this.imageConfig.defaultImageSize || "2K";

        logger.info(`Generating image with openrouter/${modelId}`, {
            prompt: prompt.slice(0, 100) + (prompt.length > 100 ? "..." : ""),
            aspectRatio,
            imageSize,
        });

        // Dynamic import of dependencies
        const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
        const { generateText } = await import("ai");

        const openrouter = createOpenRouter({
            apiKey: this.apiKey,
            headers: {
                "X-Title": "TENEX",
                "HTTP-Referer": "https://tenex.chat/",
            },
        });

        try {
            const result = await generateText({
                model: openrouter.chat(modelId),
                prompt,
                providerOptions: {
                    openrouter: {
                        image_config: {
                            aspect_ratio: aspectRatio,
                            image_size: imageSize,
                        },
                    },
                },
            });

            // Extract image from response using the multimodal chat pattern
            // OpenRouter returns images as file parts in the response content
            const step = result.steps[0];
            if (!step) {
                throw new Error("No response step received from model");
            }

            // Guard against missing response/messages
            if (!step.response) {
                throw new Error("No response object in step - unexpected API response format");
            }
            const message = step.response.messages?.[0];
            if (!message) {
                throw new Error("No message in response - model may have returned an empty response");
            }

            // Find the file part containing the image
            // Content can be string or array of parts
            const content = message.content;
            if (typeof content === "string") {
                throw new Error("Model returned text instead of an image. Try a different image-capable model.");
            }

            // Type for OpenRouter response content parts (not fully covered by AI SDK types)
            type ContentPart = { type: string; mediaType?: string; data?: string; text?: string };
            const contentParts = content as ContentPart[];

            const imagePart = contentParts.find(
                (part) => part.type === "file" && part.mediaType?.startsWith("image/")
            );

            if (!imagePart) {
                // Check if we got text response instead
                const textPart = contentParts.find((part) => part.type === "text");
                if (textPart) {
                    throw new Error(
                        `Model returned text instead of image: "${textPart.text?.slice(0, 100) || 'unknown'}". ` +
                        "This model may not support image generation."
                    );
                }
                throw new Error("No image found in model response");
            }

            if (!imagePart.data) {
                throw new Error("Image part found but contains no data");
            }

            logger.info(`Image generated successfully`, {
                model: modelId,
                mediaType: imagePart.mediaType,
                hasData: !!imagePart.data,
            });

            return {
                base64: imagePart.data,
                mimeType: imagePart.mediaType || "image/png",
                model: modelId,
            };
        } catch (error) {
            // Handle common API errors with cause preservation
            if (error instanceof Error) {
                const errorMessage = error.message.toLowerCase();

                if (errorMessage.includes("content_policy") || errorMessage.includes("safety")) {
                    throw new Error(
                        "Image generation blocked: The prompt was rejected due to content policy. " +
                        "Please modify your prompt to comply with content guidelines.",
                        { cause: error }
                    );
                }

                if (errorMessage.includes("rate_limit") || errorMessage.includes("429")) {
                    throw new Error(
                        "Rate limit exceeded: Too many image generation requests. " +
                        "Please wait a moment before trying again.",
                        { cause: error }
                    );
                }

                if (errorMessage.includes("billing") || errorMessage.includes("quota") || errorMessage.includes("insufficient")) {
                    throw new Error(
                        "Billing issue: Your OpenRouter account may have exceeded its quota or " +
                        "have insufficient credits. Please check your OpenRouter account.",
                        { cause: error }
                    );
                }

                if (errorMessage.includes("model") && errorMessage.includes("not found")) {
                    throw new Error(
                        `Model "${modelId}" not found. Run 'tenex setup image' to select a valid model.`,
                        { cause: error }
                    );
                }
            }

            // Re-throw other errors
            throw error;
        }
    }

    /**
     * Load image configuration
     */
    static async loadConfiguration(options?: ImageConfigOptions): Promise<ImageConfig> {
        try {
            const basePaths = ImageGenerationService.resolveConfigBases(options);

            for (const basePath of basePaths) {
                const configPath = path.join(basePath, IMAGE_CONFIG_FILE);
                if (!(await fileExists(configPath))) continue;

                const rawConfig = await readJsonFile<ImageConfig>(configPath);
                logger.debug(`Loaded image config from ${configPath}`);
                return { ...DEFAULT_CONFIG, ...rawConfig };
            }

            logger.debug("No image configuration found, using defaults");
            return DEFAULT_CONFIG;
        } catch (error) {
            logger.warn("Failed to load image configuration, using defaults", { error });
            return DEFAULT_CONFIG;
        }
    }

    /**
     * Save image configuration
     */
    static async saveConfiguration(
        imageConfig: ImageConfig,
        scope: "global" | "project" = "global",
        options?: ImageConfigOptions
    ): Promise<void> {
        const basePath =
            scope === "global"
                ? config.getGlobalPath()
                : ImageGenerationService.resolveProjectBase(options) ||
                  config.getProjectPath(process.cwd());

        const configPath = path.join(basePath, IMAGE_CONFIG_FILE);

        // Don't save API key to file - it's stored in providers.json
        const configToSave: ImageConfig = {
            provider: "openrouter",
            model: imageConfig.model,
            defaultAspectRatio: imageConfig.defaultAspectRatio,
            defaultImageSize: imageConfig.defaultImageSize,
        };

        await ensureDirectory(basePath);
        await writeJsonFile(configPath, configToSave);

        logger.info(
            `Image configuration saved to ${scope} config: openrouter/${imageConfig.model}`
        );
    }

    /**
     * Load provider API key from providers.json
     */
    private static async loadProviderApiKey(providerId: string): Promise<string | undefined> {
        try {
            const globalPath = config.getGlobalPath();
            const providersConfig = await config.loadTenexProviders(globalPath);
            return resolveApiKey(providersConfig.providers[providerId]?.apiKey);
        } catch (error) {
            logger.debug(`Failed to load API key for ${providerId}`, { error });
            return undefined;
        }
    }

    /**
     * Check if OpenRouter is configured with API key
     */
    static async isConfigured(): Promise<boolean> {
        const apiKey = await ImageGenerationService.loadProviderApiKey("openrouter");
        return !!apiKey;
    }

    /**
     * Get the current configuration (for display purposes)
     */
    getConfig(): ImageConfig {
        return { ...this.imageConfig };
    }

    private static resolveConfigBases(options?: ImageConfigOptions): string[] {
        const scope = options?.scope ?? "auto";
        const bases: string[] = [];

        if (scope !== "global") {
            const projectBase = ImageGenerationService.resolveProjectBase(options);
            if (projectBase) {
                bases.push(projectBase);
            } else if (!options) {
                bases.push(config.getProjectPath(process.cwd()));
            }
        }

        bases.push(config.getGlobalPath());
        return bases;
    }

    private static resolveProjectBase(options?: ImageConfigOptions): string | undefined {
        if (options?.metadataPath) {
            return options.metadataPath;
        }
        if (options?.projectPath) {
            return config.getProjectPath(options.projectPath);
        }
        return undefined;
    }
}
