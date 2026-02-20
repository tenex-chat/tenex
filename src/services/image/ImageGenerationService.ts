import * as path from "node:path";
import { fileExists, readJsonFile, writeJsonFile, ensureDirectory } from "@/lib/fs";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";

/**
 * Configuration for image generation
 */
export interface ImageConfig {
    provider: string; // Provider ID (e.g., "openai")
    model: string; // Model ID (e.g., "dall-e-3")
    defaultSize?: string; // Default image size (e.g., "1024x1024")
    defaultQuality?: "standard" | "hd"; // Default quality (DALL-E 3 only)
    defaultStyle?: "natural" | "vivid"; // Default style (DALL-E 3 only)
}

/**
 * Options for image generation
 */
export interface ImageGenerationOptions {
    size?: string;
    quality?: "standard" | "hd";
    style?: "natural" | "vivid";
    n?: number; // Number of images (DALL-E 2 only, DALL-E 3 always generates 1)
}

/**
 * Result of image generation
 */
export interface ImageResult {
    base64: string;
    url?: string;
    mimeType: string;
    revisedPrompt?: string;
}

export interface ImageConfigOptions {
    metadataPath?: string;
    projectPath?: string;
    scope?: "auto" | "project" | "global";
}

/**
 * Image generation provider IDs that support image generation
 */
export const IMAGE_CAPABLE_PROVIDERS = ["openai"] as const;
export type ImageCapableProvider = (typeof IMAGE_CAPABLE_PROVIDERS)[number];

/**
 * Available image models by provider
 */
export const IMAGE_MODELS: Record<string, Array<{ name: string; value: string; cost: string }>> = {
    openai: [
        { name: "DALL-E 3 (HD, best quality)", value: "dall-e-3", cost: "$0.040-$0.120/image" },
        { name: "DALL-E 2 (faster, lower cost)", value: "dall-e-2", cost: "$0.016-$0.020/image" },
    ],
};

/**
 * Available sizes by model
 */
export const IMAGE_SIZES: Record<string, string[]> = {
    "dall-e-3": ["1024x1024", "1024x1792", "1792x1024"],
    "dall-e-2": ["256x256", "512x512", "1024x1024"],
};

const IMAGE_CONFIG_FILE = "image.json";
const DEFAULT_CONFIG: ImageConfig = {
    provider: "openai",
    model: "dall-e-3",
    defaultSize: "1024x1024",
    defaultQuality: "standard",
    defaultStyle: "vivid",
};

/**
 * Service for AI image generation using AI SDK v6
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

        // Load API key from providers.json
        const apiKey = await ImageGenerationService.loadProviderApiKey(imageConfig.provider);
        if (!apiKey) {
            throw new Error(
                `API key required for ${imageConfig.provider}. Configure with 'tenex setup providers'.`
            );
        }

        logger.debug(`Creating image generation service: ${imageConfig.provider}/${imageConfig.model}`);
        return new ImageGenerationService(imageConfig, apiKey);
    }

    /**
     * Generate an image from a text prompt
     */
    async generateImage(
        prompt: string,
        options: ImageGenerationOptions = {}
    ): Promise<ImageResult> {
        const { provider, model, defaultSize, defaultQuality, defaultStyle } = this.imageConfig;

        if (provider !== "openai") {
            throw new Error(`Image provider "${provider}" is not yet supported. Currently only OpenAI is supported.`);
        }

        // Dynamic import of AI SDK OpenAI provider
        const { createOpenAI } = await import("@ai-sdk/openai");

        const openai = createOpenAI({
            apiKey: this.apiKey,
        });

        const size = options.size || defaultSize || "1024x1024";
        const quality = options.quality || defaultQuality || "standard";
        const style = options.style || defaultStyle || "vivid";

        logger.info(`Generating image with ${provider}/${model}`, {
            prompt: prompt.slice(0, 100) + (prompt.length > 100 ? "..." : ""),
            size,
            quality,
            style,
        });

        // Use experimental_generateImage from AI SDK
        const { experimental_generateImage, NoImageGeneratedError } = await import("ai");

        try {
            const result = await experimental_generateImage({
                model: openai.image(model),
                prompt,
                size: size as "1024x1024" | "1024x1792" | "1792x1024" | "256x256" | "512x512",
                ...(model === "dall-e-3" ? { 
                    providerOptions: {
                        openai: {
                            quality,
                            style,
                        }
                    }
                } : {}),
            });

            // Get the first image from the result
            const image = result.images[0];
            if (!image) {
                throw new Error("No image was generated");
            }

            logger.info(`Image generated successfully`, {
                hasBase64: !!image.base64,
                mediaType: image.mediaType,
            });

            return {
                base64: image.base64,
                url: undefined, // AI SDK v6 returns base64, not URL
                mimeType: image.mediaType || "image/png",
                revisedPrompt: undefined, // Not available in AI SDK response
            };
        } catch (error) {
            // Handle AI SDK specific errors
            if (NoImageGeneratedError.isInstance(error)) {
                logger.error("AI SDK failed to generate image", {
                    cause: error.cause,
                    responses: error.responses,
                });
                throw new Error(
                    `Image generation failed: The AI model could not generate an image. ${error.message}`
                );
            }

            // Handle OpenAI API errors (content policy, rate limits, etc.)
            if (error instanceof Error) {
                const errorMessage = error.message.toLowerCase();
                
                if (errorMessage.includes("content_policy_violation") || 
                    errorMessage.includes("safety system")) {
                    throw new Error(
                        "Image generation blocked: The prompt was rejected due to content policy. " +
                        "Please modify your prompt to comply with OpenAI's content guidelines."
                    );
                }
                
                if (errorMessage.includes("rate_limit") || errorMessage.includes("429")) {
                    throw new Error(
                        "Rate limit exceeded: Too many image generation requests. " +
                        "Please wait a moment before trying again."
                    );
                }
                
                if (errorMessage.includes("billing") || errorMessage.includes("quota")) {
                    throw new Error(
                        "Billing issue: Your OpenAI account may have exceeded its quota or " +
                        "have billing issues. Please check your OpenAI account."
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
            provider: imageConfig.provider,
            model: imageConfig.model,
            defaultSize: imageConfig.defaultSize,
            defaultQuality: imageConfig.defaultQuality,
            defaultStyle: imageConfig.defaultStyle,
        };

        await ensureDirectory(basePath);
        await writeJsonFile(configPath, configToSave);

        logger.info(
            `Image configuration saved to ${scope} config: ${imageConfig.provider}/${imageConfig.model}`
        );
    }

    /**
     * Load provider API key from providers.json
     */
    private static async loadProviderApiKey(providerId: string): Promise<string | undefined> {
        try {
            const globalPath = config.getGlobalPath();
            const providersConfig = await config.loadTenexProviders(globalPath);
            return providersConfig.providers[providerId]?.apiKey;
        } catch (error) {
            logger.debug(`Failed to load API key for ${providerId}`, { error });
            return undefined;
        }
    }

    /**
     * Check if a provider is configured with API key
     */
    static async isProviderConfigured(providerId: string): Promise<boolean> {
        const apiKey = await ImageGenerationService.loadProviderApiKey(providerId);
        return !!apiKey;
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
