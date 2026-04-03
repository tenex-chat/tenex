import {
    DEFAULT_ANTHROPIC_PROMPT_CACHING_TTL,
    DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_CLEAR_AT_LEAST_INPUT_TOKENS,
    DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_CLEAR_TOOL_INPUTS,
    DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_EXCLUDE_TOOLS,
    DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_KEEP_TOOL_USES,
    DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_TRIGGER_TOOL_USES,
    DEFAULT_COMPACTION_THRESHOLD_PERCENT,
    DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT,
    DEFAULT_WARNING_THRESHOLD_PERCENT,
    DEFAULT_WORKING_TOKEN_BUDGET,
} from "@/agents/execution/context-management/settings";
import { config } from "@/services/ConfigService";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

export const contextManagementCommand = new Command("context-management")
    .description("Configure managed context settings")
    .action(async () => {
        const globalPath = config.getGlobalPath();
        const tenexConfig = await config.loadTenexConfig(globalPath);
        const contextManagement = tenexConfig.contextManagement || {};
        const anthropicPromptCaching = contextManagement.anthropicPromptCaching || {};
        const anthropicServerToolEditing = anthropicPromptCaching.serverToolEditing || {};

        const { action } = await inquirer.prompt([{
            type: "select",
            name: "action",
            message: "Context Management Settings",
            choices: [
                { name: "Configure settings", value: "configure" },
                { name: "Reset to defaults", value: "reset" },
                { name: chalk.dim("Back"), value: "back" },
            ],
            theme: inquirerTheme,
        }]);

        if (action === "back") return;

        if (action === "reset") {
            delete tenexConfig.contextManagement;
            await config.saveTenexConfig(globalPath, tenexConfig);
            console.log(chalk.green("\n✓ Context management settings reset to defaults"));
            return;
        }

        const answers = await inquirer.prompt([
            {
                type: "confirm",
                name: "enabled",
                message: "Enable ai-sdk-context-management strategies:",
                default: contextManagement.enabled !== false,
            },
            {
                type: "input",
                name: "tokenBudget",
                message: "Token budget for managed context:",
                default: contextManagement.tokenBudget ?? DEFAULT_WORKING_TOKEN_BUDGET,
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num <= 0) {
                        return "Please enter a positive number";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "forceScratchpadThresholdPercent",
                message: "Force scratchpad threshold (%):",
                default: (
                    contextManagement.forceScratchpadThresholdPercent
                    ?? DEFAULT_FORCE_SCRATCHPAD_THRESHOLD_PERCENT
                ),
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num < 0 || num > 100) {
                        return "Please enter a number between 0 and 100";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "utilizationWarningThresholdPercent",
                message: "Utilization warning threshold (%):",
                default: (
                    contextManagement.utilizationWarningThresholdPercent
                    ?? DEFAULT_WARNING_THRESHOLD_PERCENT
                ),
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num < 0 || num > 100) {
                        return "Please enter a number between 0 and 100";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "compactionThresholdPercent",
                message: "Automatic compaction threshold (%):",
                default: (
                    contextManagement.compactionThresholdPercent
                    ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT
                ),
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num < 0 || num > 100) {
                        return "Please enter a number between 0 and 100";
                    }
                    return true;
                },
            },
        ]);

        const anthropicAnswers = await inquirer.prompt([
            {
                type: "select",
                name: "ttl",
                message: "Anthropic cache-control TTL:",
                choices: [
                    { name: "1 hour", value: "1h" },
                    { name: "5 minutes", value: "5m" },
                ],
                default: anthropicPromptCaching.ttl ?? DEFAULT_ANTHROPIC_PROMPT_CACHING_TTL,
                theme: inquirerTheme,
            },
            {
                type: "confirm",
                name: "serverToolEditingEnabled",
                message: "Enable Anthropic server-side tool editing:",
                default: (
                    anthropicServerToolEditing.enabled
                    ?? anthropicPromptCaching.clearToolUses
                ) !== false,
            },
            {
                type: "input",
                name: "triggerToolUses",
                message: "Anthropic tool-edit trigger after N tool uses:",
                default: (
                    anthropicServerToolEditing.triggerToolUses
                    ?? DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_TRIGGER_TOOL_USES
                ),
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num <= 0) {
                        return "Please enter a positive integer";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "keepToolUses",
                message: "Anthropic tool-edit keep count:",
                default: (
                    anthropicServerToolEditing.keepToolUses
                    ?? DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_KEEP_TOOL_USES
                ),
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num < 0) {
                        return "Please enter zero or a positive integer";
                    }
                    return true;
                },
            },
            {
                type: "input",
                name: "clearAtLeastInputTokens",
                message: "Anthropic tool-edit minimum cleared input tokens:",
                default: (
                    anthropicServerToolEditing.clearAtLeastInputTokens
                    ?? DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_CLEAR_AT_LEAST_INPUT_TOKENS
                ),
                validate: (value) => {
                    const num = Number.parseInt(value, 10);
                    if (Number.isNaN(num) || num < 0) {
                        return "Please enter zero or a positive integer";
                    }
                    return true;
                },
            },
            {
                type: "confirm",
                name: "clearToolInputs",
                message: "Clear tool inputs during Anthropic server-side editing:",
                default: anthropicServerToolEditing.clearToolInputs
                    ?? DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_CLEAR_TOOL_INPUTS,
            },
            {
                type: "input",
                name: "excludeTools",
                message: "Anthropic tool-edit excluded tools (comma-separated):",
                default: (
                    anthropicServerToolEditing.excludeTools
                    ?? [...DEFAULT_ANTHROPIC_SERVER_TOOL_EDITING_EXCLUDE_TOOLS]
                ).join(", "),
            },
        ]);

        const strategyAnswers = await inquirer.prompt([
            {
                type: "confirm",
                name: "anthropicPromptCaching",
                message: "Enable AnthropicPromptCachingStrategy:",
                default: (
                    contextManagement.strategies?.anthropicPromptCaching
                    ?? contextManagement.strategies?.systemPromptCaching
                ) !== false,
            },
            {
                type: "confirm",
                name: "reminders",
                message: "Enable RemindersStrategy:",
                default: contextManagement.strategies?.reminders !== false,
            },
            {
                type: "confirm",
                name: "scratchpad",
                message: "Enable ScratchpadStrategy:",
                default: contextManagement.strategies?.scratchpad !== false,
            },
            {
                type: "confirm",
                name: "toolResultDecay",
                message: "Enable ToolResultDecayStrategy:",
                default: contextManagement.strategies?.toolResultDecay !== false,
            },
            {
                type: "confirm",
                name: "compaction",
                message: "Enable CompactionToolStrategy:",
                default: contextManagement.strategies?.compaction !== false,
            },
            {
                type: "confirm",
                name: "contextUtilizationReminder",
                message: "Enable reminders context-utilization source:",
                default: contextManagement.strategies?.contextUtilizationReminder !== false,
            },
            {
                type: "confirm",
                name: "contextWindowStatus",
                message: "Enable reminders context-window-status source:",
                default: contextManagement.strategies?.contextWindowStatus !== false,
            },
        ]);

        tenexConfig.contextManagement = {
            enabled: answers.enabled,
            tokenBudget: Number.parseInt(answers.tokenBudget, 10),
            forceScratchpadThresholdPercent: Number.parseInt(answers.forceScratchpadThresholdPercent, 10),
            utilizationWarningThresholdPercent: Number.parseInt(answers.utilizationWarningThresholdPercent, 10),
            compactionThresholdPercent: Number.parseInt(answers.compactionThresholdPercent, 10),
            anthropicPromptCaching: {
                ttl: anthropicAnswers.ttl,
                serverToolEditing: {
                    enabled: anthropicAnswers.serverToolEditingEnabled,
                    triggerToolUses: Number.parseInt(anthropicAnswers.triggerToolUses, 10),
                    keepToolUses: Number.parseInt(anthropicAnswers.keepToolUses, 10),
                    clearAtLeastInputTokens: Number.parseInt(
                        anthropicAnswers.clearAtLeastInputTokens,
                        10
                    ),
                    clearToolInputs: anthropicAnswers.clearToolInputs,
                    excludeTools: anthropicAnswers.excludeTools
                        .split(",")
                        .map((tool: string) => tool.trim())
                        .filter((tool: string) => tool.length > 0),
                },
            },
            strategies: {
                anthropicPromptCaching: strategyAnswers.anthropicPromptCaching,
                reminders: strategyAnswers.reminders,
                scratchpad: strategyAnswers.scratchpad,
                toolResultDecay: strategyAnswers.toolResultDecay,
                compaction: strategyAnswers.compaction,
                contextUtilizationReminder: strategyAnswers.contextUtilizationReminder,
                contextWindowStatus: strategyAnswers.contextWindowStatus,
            },
        };

        await config.saveTenexConfig(globalPath, tenexConfig);
        console.log(chalk.green("\n✓ Context management settings updated"));
    });
