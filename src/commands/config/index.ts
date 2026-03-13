import { contextManagementCommand } from "@/commands/config/context-management";
import { embedCommand } from "@/commands/config/embed";
import { escalationCommand } from "@/commands/config/escalation";
import { identityCommand } from "@/commands/config/identity";
import { imageCommand } from "@/commands/config/image";
import { interventionCommand } from "@/commands/config/intervention";
import { llmCommand } from "@/commands/config/llm";
import { loggingCommand } from "@/commands/config/logging";
import { providersCommand } from "@/commands/config/providers";
import { relaysCommand } from "@/commands/config/relays";
import { rolesCommand } from "@/commands/config/roles";
import { summarizationCommand } from "@/commands/config/summarization";
import { systemPromptCommand } from "@/commands/config/system-prompt";
import { telemetryCommand } from "@/commands/config/telemetry";
import { inquirerTheme } from "@/utils/cli-theme";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";

interface MenuEntry {
    label: string;
    description: string;
    command: Command;
}

interface MenuSection {
    header: string;
    entries: MenuEntry[];
}

const MENU_SECTIONS: MenuSection[] = [
    {
        header: "AI",
        entries: [
            { label: "Providers", description: "API keys and connections", command: providersCommand },
            { label: "LLMs", description: "Model configurations", command: llmCommand },
            { label: "Roles", description: "Which model handles what task", command: rolesCommand },
            { label: "Embeddings", description: "Text embedding model", command: embedCommand },
            { label: "Image Gen", description: "Image generation model", command: imageCommand },
        ],
    },
    {
        header: "Agents",
        entries: [
            { label: "Escalation", description: "Route ask() through an agent first", command: escalationCommand },
            { label: "Intervention", description: "Auto-review when you're idle", command: interventionCommand },
        ],
    },
    {
        header: "Network",
        entries: [
            { label: "Relays", description: "Nostr relay connections", command: relaysCommand },
        ],
    },
    {
        header: "Conversations",
        entries: [
            { label: "Context", description: "Sliding window and scratchpad strategies", command: contextManagementCommand },
            { label: "Summarization", description: "Auto-summary timing", command: summarizationCommand },
        ],
    },
    {
        header: "Advanced",
        entries: [
            { label: "Identity", description: "Authorized pubkeys", command: identityCommand },
            { label: "System Prompt", description: "Global prompt for all projects", command: systemPromptCommand },
            { label: "Logging", description: "Log level and file path", command: loggingCommand },
            { label: "Telemetry", description: "OpenTelemetry tracing", command: telemetryCommand },
        ],
    },
];

async function runConfigMenu(): Promise<void> {
    while (true) {
        console.log();

        const choices: Array<{ name: string; value: number } | { type: "separator"; line: string }> = [];
        const commandMap: Command[] = [];
        let idx = 0;

        for (const section of MENU_SECTIONS) {
            choices.push({ type: "separator", line: chalk.dim(`── ${section.header} ──`) });

            for (const entry of section.entries) {
                const label = entry.label.padEnd(16);
                choices.push({
                    name: `  ${label}— ${entry.description}`,
                    value: idx,
                });
                commandMap.push(entry.command);
                idx++;
            }
        }

        choices.push({ type: "separator", line: "" });
        choices.push({ name: chalk.dim("  Back"), value: -1 });

        try {
            const { selection } = await inquirer.prompt([{
                type: "select",
                name: "selection",
                message: "Settings",
                choices,
                theme: inquirerTheme,
                loop: false,
            }]);

            if (selection === -1) return;

            const cmd = commandMap[selection];
            if (cmd) {
                console.log();
                await cmd.parseAsync([], { from: "user" });
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
            throw error;
        }
    }
}

export const configCommand = new Command("config")
    .description("Configure TENEX backend settings")
    .action(async () => {
        try {
            await runConfigMenu();
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) return;
            console.log(chalk.red(`❌ Configuration error: ${error}`));
            process.exitCode = 1;
        }
    })
    .addCommand(providersCommand)
    .addCommand(llmCommand)
    .addCommand(rolesCommand)
    .addCommand(embedCommand)
    .addCommand(imageCommand)
    .addCommand(escalationCommand)
    .addCommand(interventionCommand)
    .addCommand(relaysCommand)
    .addCommand(contextManagementCommand)
    .addCommand(summarizationCommand)
    .addCommand(identityCommand)
    .addCommand(systemPromptCommand)
    .addCommand(loggingCommand)
    .addCommand(telemetryCommand);
