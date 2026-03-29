import { config as configService } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

function validatePositiveInteger(value: string): true | string {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num) || num <= 0) {
        return "Please enter a positive number";
    }
    return true;
}

export const telemetryCommand = new Command("telemetry")
    .description("Configure OpenTelemetry tracing and analysis telemetry")
    .action(async () => {
        try {
            const globalPath = configService.getGlobalPath();
            const existingConfig = await configService.loadTenexConfig(globalPath);
            const telemetry = existingConfig.telemetry || {};
            const analysis = telemetry.analysis || {};
            const resolvedAnalysis = configService.getAnalysisTelemetryConfig();

            console.log(`  Tracing enabled: ${telemetry.enabled ?? true}`);
            console.log(`  Service name: ${telemetry.serviceName ?? "tenex-daemon"}`);
            console.log(`  Endpoint: ${telemetry.endpoint ?? "http://localhost:4318/v1/traces"}`);
            console.log(`  Analysis store enabled: ${analysis.enabled ?? false}`);
            console.log(`  Analysis DB path: ${analysis.dbPath ?? resolvedAnalysis.dbPath}`);
            console.log(`  Analysis retention days: ${analysis.retentionDays ?? resolvedAnalysis.retentionDays}`);
            console.log(
                `  Large message threshold: ${analysis.largeMessageThresholdTokens ?? resolvedAnalysis.largeMessageThresholdTokens}`
            );
            console.log(
                `  Store previews: ${analysis.storeMessagePreviews ?? resolvedAnalysis.storeMessagePreviews}`
            );
            console.log(
                `  Max preview chars: ${analysis.maxPreviewChars ?? resolvedAnalysis.maxPreviewChars}`
            );
            console.log(
                `  Store full messages: ${analysis.storeFullMessageText ?? resolvedAnalysis.storeFullMessageText}\n`
            );

            const { action } = await inquirer.prompt([{
                type: "select",
                name: "action",
                message: "Telemetry Settings",
                choices: [
                    { name: "Configure tracing and analysis", value: "configure" },
                    { name: "Reset analysis settings to defaults", value: "reset-analysis" },
                    { name: chalk.dim("Back"), value: "back" },
                ],
                theme: inquirerTheme,
            }]);

            if (action === "back") {
                return;
            }

            if (action === "reset-analysis") {
                existingConfig.telemetry = {
                    ...telemetry,
                    analysis: undefined,
                };
                await configService.saveGlobalConfig(existingConfig);
                console.log(chalk.green("✓") + chalk.bold(" Analysis telemetry reset to defaults."));
                return;
            }

            const answers = await inquirer.prompt([
                {
                    type: "confirm",
                    name: "enabled",
                    message: "Enable OpenTelemetry tracing?",
                    default: telemetry.enabled ?? true,
                    theme: inquirerTheme,
                },
                {
                    type: "input",
                    name: "serviceName",
                    message: "OTEL service name:",
                    default: telemetry.serviceName ?? "tenex-daemon",
                    theme: inquirerTheme,
                },
                {
                    type: "input",
                    name: "endpoint",
                    message: "OTLP HTTP endpoint:",
                    default: telemetry.endpoint ?? "http://localhost:4318/v1/traces",
                    theme: inquirerTheme,
                },
                {
                    type: "confirm",
                    name: "analysisEnabled",
                    message: "Enable local analysis telemetry store?",
                    default: analysis.enabled ?? false,
                    theme: inquirerTheme,
                },
                {
                    type: "input",
                    name: "analysisDbPath",
                    message: "Analysis SQLite DB path:",
                    default: analysis.dbPath ?? resolvedAnalysis.dbPath,
                    when: (answers) => answers.analysisEnabled,
                    theme: inquirerTheme,
                },
                {
                    type: "input",
                    name: "analysisRetentionDays",
                    message: "Analysis retention days:",
                    default: analysis.retentionDays ?? resolvedAnalysis.retentionDays,
                    when: (answers) => answers.analysisEnabled,
                    validate: validatePositiveInteger,
                    theme: inquirerTheme,
                },
                {
                    type: "input",
                    name: "largeMessageThresholdTokens",
                    message: "Large-message carry threshold (tokens):",
                    default:
                        analysis.largeMessageThresholdTokens
                        ?? resolvedAnalysis.largeMessageThresholdTokens,
                    when: (answers) => answers.analysisEnabled,
                    validate: validatePositiveInteger,
                    theme: inquirerTheme,
                },
                {
                    type: "confirm",
                    name: "storeMessagePreviews",
                    message: "Store prompt message previews?",
                    default:
                        analysis.storeMessagePreviews
                        ?? resolvedAnalysis.storeMessagePreviews,
                    when: (answers) => answers.analysisEnabled,
                    theme: inquirerTheme,
                },
                {
                    type: "input",
                    name: "maxPreviewChars",
                    message: "Maximum preview length:",
                    default: analysis.maxPreviewChars ?? resolvedAnalysis.maxPreviewChars,
                    when: (answers) => answers.analysisEnabled && answers.storeMessagePreviews,
                    validate: validatePositiveInteger,
                    theme: inquirerTheme,
                },
                {
                    type: "confirm",
                    name: "storeFullMessageText",
                    message: "Store full prompt message text?",
                    default:
                        analysis.storeFullMessageText
                        ?? resolvedAnalysis.storeFullMessageText,
                    when: (answers) => answers.analysisEnabled,
                    theme: inquirerTheme,
                },
            ]);

            existingConfig.telemetry = {
                ...telemetry,
                enabled: answers.enabled,
                serviceName: answers.serviceName,
                endpoint: answers.endpoint,
                analysis: answers.analysisEnabled
                    ? {
                          enabled: true,
                          dbPath: answers.analysisDbPath,
                          retentionDays: Number.parseInt(answers.analysisRetentionDays, 10),
                          largeMessageThresholdTokens: Number.parseInt(
                              answers.largeMessageThresholdTokens,
                              10
                          ),
                          storeMessagePreviews: answers.storeMessagePreviews,
                          maxPreviewChars: answers.storeMessagePreviews
                              ? Number.parseInt(answers.maxPreviewChars, 10)
                              : undefined,
                          storeFullMessageText: answers.storeFullMessageText,
                      }
                    : {
                          ...analysis,
                          enabled: false,
                      },
            };

            await configService.saveGlobalConfig(existingConfig);
            console.log(chalk.green("✓") + chalk.bold(" Telemetry config saved."));
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                return;
            }
            console.log(chalk.red(`❌ Failed to configure telemetry: ${error}`));
            process.exitCode = 1;
        }
    });
