import * as fileSystem from "@/lib/fs";
import { config as configService } from "@/services/ConfigService";
import { amber, amberBold } from "@/utils/cli-theme";
import { logger } from "@/utils/logger";
import chalk from "chalk";
import { Command } from "commander";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Get the user's preferred editor
 * Checks $VISUAL, $EDITOR, then falls back to common defaults
 */
function getEditor(): string {
    // Check standard environment variables
    if (process.env.VISUAL) {
        return process.env.VISUAL;
    }
    if (process.env.EDITOR) {
        return process.env.EDITOR;
    }

    // Platform-specific defaults
    if (process.platform === "win32") {
        return "notepad";
    }

    // Unix-like systems - try common editors
    return "nano"; // Most user-friendly default
}

/**
 * Open a file in the user's preferred editor and wait for them to close it
 */
async function openInEditor(filePath: string): Promise<void> {
    const editor = getEditor();

    return new Promise((resolve, reject) => {
        // Use shell to properly handle $EDITOR values with quoted paths or complex arguments
        // e.g., EDITOR="code --wait" or EDITOR='"/path/with spaces/code" --wait'
        const fullCommand = `${editor} "${filePath}"`;

        logger.debug(`Opening editor with command: ${fullCommand}`);

        const child = spawn(fullCommand, [], {
            stdio: "inherit",
            shell: true,
        });

        child.on("error", (error) => {
            reject(new Error(`Failed to open editor '${editor}': ${error.message}`));
        });

        child.on("close", (code) => {
            if (code === 0 || code === null) {
                resolve();
            } else {
                reject(new Error(`Editor exited with code ${code}`));
            }
        });
    });
}

/**
 * Command for configuring global system prompt
 *
 * Opens the user's preferred editor to edit a system prompt fragment that
 * will be added to ALL projects' system prompts.
 */
export const globalSystemPromptCommand = new Command("global-system-prompt")
    .description("Configure a global system prompt that is added to all projects")
    .option("--disable", "Disable the global system prompt without deleting it")
    .option("--enable", "Enable the global system prompt")
    .option("--show", "Show the current global system prompt")
    .action(async (options) => {
        try {
            const globalPath = configService.getGlobalPath();

            // Ensure global config directory exists
            await fileSystem.ensureDirectory(globalPath);

            // Load existing configuration
            const existingConfig = await configService.loadTenexConfig(globalPath);

            // Handle --show flag
            if (options.show) {
                const content = existingConfig.globalSystemPrompt?.content;
                const enabled = existingConfig.globalSystemPrompt?.enabled !== false;

                if (!content || content.trim().length === 0) {
                    console.log(chalk.gray("No global system prompt configured."));
                } else {
                    console.log(amberBold(`Global System Prompt (${enabled ? "enabled" : "disabled"}):`));
                    console.log(amber("─".repeat(50)));
                    console.log(content);
                    console.log(amber("─".repeat(50)));
                }
                return;
            }

            // Handle --disable flag
            if (options.disable) {
                const newConfig = {
                    ...existingConfig,
                    globalSystemPrompt: {
                        ...existingConfig.globalSystemPrompt,
                        enabled: false,
                    },
                };
                await configService.saveGlobalConfig(newConfig);
                console.log(chalk.green("✓") + chalk.bold(" Global system prompt disabled."));
                return;
            }

            // Handle --enable flag
            if (options.enable) {
                const newConfig = {
                    ...existingConfig,
                    globalSystemPrompt: {
                        ...existingConfig.globalSystemPrompt,
                        enabled: true,
                    },
                };
                await configService.saveGlobalConfig(newConfig);
                console.log(chalk.green("✓") + chalk.bold(" Global system prompt enabled."));
                return;
            }

            // Default action: open editor
            // Create a temporary file with existing content
            const tempDir = os.tmpdir();
            const tempFile = path.join(tempDir, `tenex-global-prompt-${Date.now()}.md`);

            // Delimiter that separates template instructions from user content
            const CONTENT_DELIMITER = "---- YOUR PROMPT BELOW THIS LINE ----";

            // Get existing content or provide a template
            const existingContent = existingConfig.globalSystemPrompt?.content || "";
            const templateHeader = `# Global System Prompt Configuration
#
# This content will be added to ALL agents' system prompts across ALL projects.
#
# Examples of what you might put here:
# - Personal preferences (e.g., "Always use TypeScript strict mode")
# - Coding standards (e.g., "Follow clean code principles")
# - Communication preferences (e.g., "Be concise in responses")
#
# IMPORTANT: Write your prompt BELOW the delimiter line.
# Everything above the delimiter will be discarded.
# Everything below (including markdown # headings) will be preserved.
#
# Save and close this file when done.

${CONTENT_DELIMITER}
`;
            const templateContent = templateHeader + existingContent;

            await fs.writeFile(tempFile, templateContent, "utf-8");

            console.log(amberBold("Opening editor to configure global system prompt..."));
            console.log(chalk.gray(`(Using editor: ${getEditor()})\n`));

            // Open editor and wait for it to close - use try/finally for cleanup
            let editedContent: string;
            try {
                await openInEditor(tempFile);
                editedContent = await fs.readFile(tempFile, "utf-8");
            } finally {
                // Always clean up temp file, even on error or interrupt
                try {
                    await fs.unlink(tempFile);
                } catch {
                    // Ignore cleanup errors
                }
            }

            // Extract content after the delimiter, preserving all content including # headings
            const delimiterIndex = editedContent.indexOf(CONTENT_DELIMITER);
            let cleanedContent: string;
            if (delimiterIndex !== -1) {
                // Take everything after the delimiter line
                const afterDelimiter = editedContent.substring(
                    delimiterIndex + CONTENT_DELIMITER.length
                );
                cleanedContent = afterDelimiter.trim();
            } else {
                // No delimiter found - use entire content (user may have deleted template)
                cleanedContent = editedContent.trim();
            }

            // Save the configuration
            const newConfig = {
                ...existingConfig,
                globalSystemPrompt: {
                    enabled: true,
                    content: cleanedContent,
                },
            };

            await configService.saveGlobalConfig(newConfig);

            if (cleanedContent.length === 0) {
                console.log(chalk.green("✓") + chalk.bold(" Global system prompt cleared (no content)."));
            } else {
                console.log(chalk.green("✓") + chalk.bold(" Global system prompt saved successfully!"));
                console.log(chalk.gray(`Content length: ${cleanedContent.length} characters`));
                console.log(chalk.gray("\nThis prompt will be added to all agents' system prompts."));
            }
        } catch (error: unknown) {
            // Handle SIGINT (Ctrl+C) gracefully
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
                return;
            }

            console.log(chalk.red(`❌ Failed to configure global system prompt: ${error}`));
            process.exitCode = 1;
        }
    });
