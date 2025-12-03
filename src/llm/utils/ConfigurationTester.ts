import type { LLMLogger } from "@/logging/LLMLogger";
import type { TenexLLMs } from "@/services/config/types";
import chalk from "chalk";
import inquirer from "inquirer";
import { llmServiceFactory } from "../LLMServiceFactory";

/**
 * Tests LLM configurations
 */
export class ConfigurationTester {
    static async test(llmsConfig: TenexLLMs): Promise<void> {
        const configNames = Object.keys(llmsConfig.configurations);

        if (configNames.length === 0) {
            console.log(chalk.yellow("⚠️  No configurations to test"));
            return;
        }

        const { name } = await inquirer.prompt([
            {
                type: "list",
                name: "name",
                message: "Select configuration to test:",
                choices: configNames.map((n) => ({
                    name: n === llmsConfig.default ? `${n} (default)` : n,
                    value: n,
                })),
            },
        ]);

        const config = llmsConfig.configurations[name];
        console.log(chalk.yellow(`\nTesting configuration "${name}"...`));
        console.log(chalk.gray(`Provider: ${config.provider}, Model: ${config.model}`));

        try {
            // Ensure providers are initialized
            if (!llmServiceFactory.hasProvider(config.provider)) {
                await llmServiceFactory.initializeProviders(llmsConfig.providers);
            }

            // Create a simple mock logger for testing
            const mockLogger: Pick<LLMLogger, "logLLMRequest" | "logLLMResponse"> = {
                logLLMRequest: async () => {},
                logLLMResponse: async () => {},
            };

            // Create the service using the factory
            const service = llmServiceFactory.createService(mockLogger as LLMLogger, config);

            console.log(chalk.cyan("📡 Sending test message..."));
            const result = await service.complete(
                [{ role: "user", content: "Say 'Hello, TENEX!' in exactly those words." }],
                {},
                {
                    temperature: config.temperature,
                    maxTokens: config.maxTokens,
                }
            );

            console.log(chalk.green("\n✅ Test successful!"));
            const resultText = "text" in result ? result.text : "";
            console.log(chalk.white("Response: ") + chalk.cyan(resultText));

            // Show usage stats if available
            if ("usage" in result && result.usage) {
                const usage = result.usage;
                const inputTokens = "inputTokens" in usage ? usage.inputTokens : "?";
                const outputTokens = "outputTokens" in usage ? usage.outputTokens : "?";
                const totalTokens = "totalTokens" in usage ? usage.totalTokens : "?";
                console.log(
                    chalk.gray(`\nTokens: ${inputTokens} + ${outputTokens} = ${totalTokens}`)
                );
            }

            await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error: unknown) {
            console.log(chalk.red("\n❌ Test failed!"));

            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage) {
                console.log(chalk.red(`Error: ${errorMessage}`));
            }

            // Check for common issues
            if (errorMessage?.includes("401") || errorMessage?.includes("Unauthorized")) {
                console.log(chalk.yellow("\n💡 Invalid or expired API key"));
            } else if (errorMessage?.includes("404")) {
                console.log(chalk.yellow(`\n💡 Model '${config.model}' may not be available`));
            } else if (errorMessage?.includes("rate limit")) {
                console.log(chalk.yellow("\n💡 Rate limit hit. Please wait and try again"));
            }

            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    }
}
