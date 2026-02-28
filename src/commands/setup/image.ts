import * as fileSystem from "@/lib/fs";
import {
    ImageGenerationService,
    OPENROUTER_IMAGE_MODELS,
    ASPECT_RATIOS,
    IMAGE_SIZES,
    type ImageConfig,
} from "@/services/image/ImageGenerationService";
import { config as configService } from "@/services/ConfigService";
import { amber, inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

/**
 * Command for configuring image generation with OpenRouter
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
                    console.log(chalk.red("❌ No .tenex directory found. Make sure you're in a TENEX project directory."));
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

            // Check if OpenRouter is configured
            const providersConfig = await configService.loadTenexProviders(configService.getGlobalPath());
            if (!providersConfig.providers.openrouter?.apiKey) {
                console.log(chalk.red("❌ OpenRouter is not configured. Run `tenex setup providers` and add your OpenRouter API key first."));
                console.log(amber("→") + chalk.bold(" Image generation requires OpenRouter. Get an API key at: https://openrouter.ai/keys"));
                process.exitCode = 1;
                return;
            }

            console.log(chalk.green("✓") + chalk.bold(" OpenRouter API key found") + "\n");

            // Build model choices
            const modelChoices = OPENROUTER_IMAGE_MODELS.map((m) => ({
                name: `${m.name} - ${m.description}`,
                value: m.value,
            }));

            // Add custom model option
            modelChoices.push({
                name: "Custom model (enter OpenRouter model ID)",
                value: "custom",
            });

            // Prompt for model selection
            const { model: selectedModel } = await inquirer.prompt([
                {
                    type: "select",
                    name: "model",
                    message: "Select default image generation model:",
                    choices: modelChoices,
                    default: existing?.model || OPENROUTER_IMAGE_MODELS[0]?.value,
                    theme: inquirerTheme,
                },
            ]);

            let model = selectedModel;
            if (selectedModel === "custom") {
                const customAnswer = await inquirer.prompt([
                    {
                        type: "input",
                        name: "customModel",
                        message: "Enter OpenRouter model ID (e.g., black-forest-labs/flux.2-pro):",
                        theme: inquirerTheme,
                        validate: (input: string) =>
                            input.trim().length > 0 || "Model ID cannot be empty",
                    },
                ]);
                model = customAnswer.customModel;
            }

            // Prompt for default aspect ratio
            const aspectRatioChoices = ASPECT_RATIOS.map((ratio) => {
                let description = "";
                if (ratio === "1:1") description = " (square)";
                else if (ratio === "16:9") description = " (widescreen landscape)";
                else if (ratio === "9:16") description = " (portrait/mobile)";
                else if (ratio === "4:3") description = " (classic)";
                else if (ratio === "3:4") description = " (portrait classic)";
                else if (ratio === "3:2") description = " (photo landscape)";
                else if (ratio === "2:3") description = " (photo portrait)";
                return { name: `${ratio}${description}`, value: ratio };
            });

            const { aspectRatio } = await inquirer.prompt([
                {
                    type: "select",
                    name: "aspectRatio",
                    message: "Select default aspect ratio:",
                    choices: aspectRatioChoices,
                    default: existing?.defaultAspectRatio || "1:1",
                    theme: inquirerTheme,
                },
            ]);

            // Prompt for default image size
            const imageSizeChoices = IMAGE_SIZES.map((size) => {
                let description = "";
                if (size === "1K") description = " (fastest, lowest cost)";
                else if (size === "2K") description = " (balanced)";
                else if (size === "4K") description = " (highest quality, most expensive)";
                return { name: `${size}${description}`, value: size };
            });

            const { imageSize } = await inquirer.prompt([
                {
                    type: "select",
                    name: "imageSize",
                    message: "Select default image size:",
                    choices: imageSizeChoices,
                    default: existing?.defaultImageSize || "2K",
                    theme: inquirerTheme,
                },
            ]);

            // Save configuration
            const imageConfig: ImageConfig = {
                provider: "openrouter",
                model,
                defaultAspectRatio: aspectRatio,
                defaultImageSize: imageSize,
            };

            await ImageGenerationService.saveConfiguration(imageConfig, scope, {
                projectPath: scope === "project" ? projectPath : undefined,
            });

            // Get model display name
            const modelInfo = OPENROUTER_IMAGE_MODELS.find((m) => m.value === model);
            const modelDisplayName = modelInfo ? modelInfo.name : model;

            console.log("\n" + chalk.green("✓") + chalk.bold(` Image generation configured for ${scope}`));
            console.log(chalk.gray(`   Provider: OpenRouter`));
            console.log(chalk.gray(`   Model: ${modelDisplayName} (${model})`));
            console.log(chalk.gray(`   Default aspect ratio: ${aspectRatio}`));
            console.log(chalk.gray(`   Default image size: ${imageSize}`));
            console.log(chalk.gray("\nAgents can now use the generate_image tool to create images."));
        } catch (error: unknown) {
            // Handle SIGINT (Ctrl+C) gracefully
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                return;
            }

            console.log(chalk.red(`❌ Failed to configure image generation: ${error}`));
            process.exitCode = 1;
        }
    });
