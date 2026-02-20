import * as fileSystem from "@/lib/fs";
import { PROVIDER_IDS } from "@/llm/providers/provider-ids";
import {
    ImageGenerationService,
    IMAGE_CAPABLE_PROVIDERS,
    IMAGE_MODELS,
    IMAGE_SIZES,
    type ImageConfig,
} from "@/services/image";
import { config as configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { Command } from "commander";
import inquirer from "inquirer";

/**
 * Display names for providers
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
    [PROVIDER_IDS.OPENAI]: "OpenAI (DALL-E)",
};

/**
 * Command for configuring image generation
 */
export const imageCommand = new Command("image")
    .description(
        "Configure image generation model (global by default, --project for current project)"
    )
    .option("--project", "Use project-specific configuration instead of global")
    .action(async (options) => {
        try {
            const scope: "global" | "project" = options.project ? "project" : "global";
            const projectPath = process.cwd();
            const baseDir =
                scope === "project"
                    ? configService.getProjectPath(projectPath)
                    : configService.getGlobalPath();

            if (scope === "project") {
                // Check if we're in a TENEX project
                if (!(await fileSystem.directoryExists(baseDir))) {
                    logger.error(
                        "No .tenex directory found. Make sure you're in a TENEX project directory."
                    );
                    process.exitCode = 1;
                    return;
                }
            } else {
                // Ensure global config directory exists
                await fileSystem.ensureDirectory(baseDir);
            }

            // Load existing configuration
            const existing = await ImageGenerationService.loadConfiguration({
                scope,
                projectPath: scope === "project" ? projectPath : undefined,
            });

            // Load configured providers from providers.json
            const providersConfig = await configService.loadTenexProviders(configService.getGlobalPath());
            if (Object.keys(providersConfig.providers).length === 0) {
                logger.error(
                    "No providers configured. Run `tenex setup providers` before configuring image generation."
                );
                process.exitCode = 1;
                return;
            }
            const configuredProviders = Object.keys(providersConfig.providers);

            // Build provider choices from configured image-capable providers
            const providerChoices: Array<{ name: string; value: string }> = [];

            for (const providerId of IMAGE_CAPABLE_PROVIDERS) {
                if (configuredProviders.includes(providerId)) {
                    const displayName = PROVIDER_DISPLAY_NAMES[providerId] || providerId;
                    providerChoices.push({
                        name: `${displayName} (configured)`,
                        value: providerId,
                    });
                }
            }

            if (providerChoices.length === 0) {
                logger.error(
                    "No image-capable providers configured. Run `tenex setup providers` and add OpenAI credentials."
                );
                logger.info(
                    "Currently supported providers for image generation: OpenAI (DALL-E 2, DALL-E 3)"
                );
                process.exitCode = 1;
                return;
            }

            // Prompt for provider selection
            const { provider } = await inquirer.prompt([
                {
                    type: "select",
                    name: "provider",
                    message: "Select image generation provider:",
                    choices: providerChoices,
                    default: existing?.provider || providerChoices[0]?.value,
                },
            ]);

            // Get available models for the selected provider
            const modelChoices = IMAGE_MODELS[provider] || [];
            if (modelChoices.length === 0) {
                logger.error(`No models available for provider: ${provider}`);
                process.exitCode = 1;
                return;
            }

            // Prompt for model selection
            const { model } = await inquirer.prompt([
                {
                    type: "select",
                    name: "model",
                    message: "Select image model:",
                    choices: modelChoices.map((m) => ({
                        name: `${m.name} - ${m.cost}`,
                        value: m.value,
                    })),
                    default: existing?.model || modelChoices[0]?.value,
                },
            ]);

            // Get available sizes for the selected model
            const sizeChoices = IMAGE_SIZES[model] || IMAGE_SIZES["dall-e-3"];

            // Prompt for default size
            const { defaultSize } = await inquirer.prompt([
                {
                    type: "select",
                    name: "defaultSize",
                    message: "Select default image size:",
                    choices: sizeChoices.map((size) => {
                        let description = "";
                        if (size === "1024x1024") description = " (square)";
                        else if (size === "1024x1792") description = " (portrait)";
                        else if (size === "1792x1024") description = " (landscape)";
                        return { name: `${size}${description}`, value: size };
                    }),
                    default: existing?.defaultSize || "1024x1024",
                },
            ]);

            // For DALL-E 3, prompt for quality and style
            let defaultQuality: "standard" | "hd" = "standard";
            let defaultStyle: "natural" | "vivid" = "vivid";

            if (model === "dall-e-3") {
                const qualityAnswer = await inquirer.prompt([
                    {
                        type: "select",
                        name: "quality",
                        message: "Select default quality:",
                        choices: [
                            { name: "Standard ($0.04-$0.08/image)", value: "standard" },
                            { name: "HD - Higher detail ($0.08-$0.12/image)", value: "hd" },
                        ],
                        default: existing?.defaultQuality || "standard",
                    },
                ]);
                defaultQuality = qualityAnswer.quality;

                const styleAnswer = await inquirer.prompt([
                    {
                        type: "select",
                        name: "style",
                        message: "Select default style:",
                        choices: [
                            { name: "Vivid (hyper-real, dramatic)", value: "vivid" },
                            { name: "Natural (realistic, subtle)", value: "natural" },
                        ],
                        default: existing?.defaultStyle || "vivid",
                    },
                ]);
                defaultStyle = styleAnswer.style;
            }

            // Save configuration
            const imageConfig: ImageConfig = {
                provider,
                model,
                defaultSize,
                defaultQuality,
                defaultStyle,
            };

            await ImageGenerationService.saveConfiguration(imageConfig, scope, {
                projectPath: scope === "project" ? projectPath : undefined,
            });

            // Calculate approximate cost for the configuration
            let costNote = "";
            if (model === "dall-e-3") {
                const baseCost = defaultQuality === "hd" ? "$0.08-$0.12" : "$0.04-$0.08";
                costNote = `\n   Estimated cost: ${baseCost} per image`;
            } else if (model === "dall-e-2") {
                costNote = "\n   Estimated cost: $0.016-$0.020 per image";
            }

            logger.info(
                `✅ Image generation configured for ${scope}\n` +
                    `   Provider: ${provider}\n` +
                    `   Model: ${model}\n` +
                    `   Default size: ${defaultSize}\n` +
                    (model === "dall-e-3"
                        ? `   Default quality: ${defaultQuality}\n` +
                          `   Default style: ${defaultStyle}`
                        : "") +
                    costNote +
                    "\n\nAgents can now use the generate_image tool to create images."
            );
        } catch (error: unknown) {
            // Handle SIGINT (Ctrl+C) gracefully
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                return;
            }

            logger.error(`Failed to configure image generation: ${error}`);
            process.exitCode = 1;
        }
    });
