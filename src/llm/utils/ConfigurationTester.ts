import { config as configService } from "@/services/ConfigService";
import type { TenexLLMs } from "@/services/config/types";
import chalk from "chalk";
import inquirer from "inquirer";
import { z } from "zod";
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

        const llmConfig = llmsConfig.configurations[name];
        console.log(chalk.yellow(`\nTesting configuration "${name}"...`));
        console.log(chalk.gray(`Provider: ${llmConfig.provider}, Model: ${llmConfig.model}`));

        try {
            // Load full config (needed for MCP server configs in claudeCode/codexCli providers)
            await configService.loadConfig();

            // Initialize providers before testing
            await llmServiceFactory.initializeProviders(llmsConfig.providers);

            // Create the service using the factory
            const service = llmServiceFactory.createService(llmConfig);

            console.log(chalk.cyan("📡 Sending test message..."));
            const result = await service.complete(
                [{ role: "user", content: "Say 'Hello, TENEX!' in exactly those words." }],
                {},
                {
                    temperature: llmConfig.temperature,
                    maxTokens: llmConfig.maxTokens,
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
                console.log(chalk.yellow(`\n💡 Model '${llmConfig.model}' may not be available`));
            } else if (errorMessage?.includes("rate limit")) {
                console.log(chalk.yellow("\n💡 Rate limit hit. Please wait and try again"));
            }

            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    }

    /**
     * Test a configuration for summarization using generateObject
     */
    static async testSummarization(llmsConfig: TenexLLMs, configName: string): Promise<void> {
        const llmConfig = llmsConfig.configurations[configName];
        if (!llmConfig) {
            console.log(chalk.red(`❌ Configuration "${configName}" not found`));
            return;
        }

        console.log(chalk.yellow(`\nTesting summarization with "${configName}"...`));
        console.log(chalk.gray(`Provider: ${llmConfig.provider}, Model: ${llmConfig.model}`));

        // Schema that mimics what we'd use for kind 513 summaries
        const SummarySchema = z.object({
            title: z.string().describe("A brief title for the summary"),
            summary: z.string().describe("A concise summary of the conversation"),
            keyPoints: z.array(z.string()).describe("Key points from the conversation"),
        });

        try {
            // Load full config (needed for MCP server configs in claudeCode/codexCli providers)
            await configService.loadConfig();

            // Initialize providers before testing
            await llmServiceFactory.initializeProviders(llmsConfig.providers);

            // Create the service using the factory
            const service = llmServiceFactory.createService(llmConfig);

            console.log(chalk.cyan("📡 Testing generateObject..."));

            const testConversation = `
User: I need help setting up authentication for my web app.
Assistant: I can help with that. What authentication method are you considering?
User: I'm thinking OAuth with Google and GitHub.
Assistant: Great choice. OAuth is secure and user-friendly. Let me outline the steps...
`;

            const result = await service.generateObject(
                [
                    {
                        role: "system",
                        content:
                            "You are a helpful assistant that summarizes conversations. Generate a structured summary.",
                    },
                    {
                        role: "user",
                        content: `Summarize this conversation:\n${testConversation}`,
                    },
                ],
                SummarySchema
            );

            console.log(chalk.green("\n✅ generateObject test successful!"));
            console.log(chalk.white("\nGenerated summary:"));
            console.log(chalk.cyan(`  Title: ${result.object.title}`));
            console.log(chalk.cyan(`  Summary: ${result.object.summary}`));
            console.log(chalk.cyan(`  Key Points:`));
            for (const point of result.object.keyPoints) {
                console.log(chalk.cyan(`    • ${point}`));
            }

            // Show usage stats if available
            if (result.usage) {
                const { inputTokens, outputTokens, totalTokens } = result.usage;
                console.log(chalk.gray(`\nTokens: ${inputTokens} + ${outputTokens} = ${totalTokens}`));
            }

            await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error: unknown) {
            console.log(chalk.red("\n❌ generateObject test failed!"));

            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage) {
                console.log(chalk.red(`Error: ${errorMessage}`));
            }

            // Check for common issues
            if (errorMessage?.includes("401") || errorMessage?.includes("Unauthorized")) {
                console.log(chalk.yellow("\n💡 Invalid or expired API key"));
            } else if (errorMessage?.includes("404")) {
                console.log(chalk.yellow(`\n💡 Model '${llmConfig.model}' may not be available`));
            } else if (errorMessage?.includes("rate limit")) {
                console.log(chalk.yellow("\n💡 Rate limit hit. Please wait and try again"));
            } else if (
                errorMessage?.includes("structured output") ||
                errorMessage?.includes("json")
            ) {
                console.log(
                    chalk.yellow(
                        "\n💡 This model may not support structured output (generateObject)"
                    )
                );
            }

            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    }
}
