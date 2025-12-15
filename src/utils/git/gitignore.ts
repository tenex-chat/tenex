import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@/utils/logger";

/**
 * Check if a gitignore entry already exists (handles various formats)
 */
function hasGitignoreEntry(content: string, entry: string): boolean {
    const lines = content.split("\n");
    const normalizedEntry = entry.replace(/^\//, "").replace(/\/$/, "");
    return lines.some((line) => {
        const normalizedLine = line.trim().replace(/^\//, "").replace(/\/$/, "");
        return normalizedLine === normalizedEntry;
    });
}

/**
 * Ensures .tenex is in the project's .gitignore file
 */
export async function ensureTenexInGitignore(projectPath: string): Promise<void> {
    await ensureGitignoreEntry(projectPath, ".tenex/", "TENEX project files");
}

/**
 * Ensures .worktrees is in the project's .gitignore file.
 * This must be called when creating worktrees to prevent them from being committed.
 */
export async function ensureWorktreesGitignore(projectPath: string): Promise<void> {
    await ensureGitignoreEntry(projectPath, ".worktrees/", "Git worktrees");
}

/**
 * Generic function to ensure an entry exists in .gitignore
 */
async function ensureGitignoreEntry(
    projectPath: string,
    entry: string,
    comment: string
): Promise<void> {
    const gitignorePath = path.join(projectPath, ".gitignore");

    try {
        let gitignoreContent = "";

        // Check if .gitignore exists
        try {
            gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
        } catch {
            // .gitignore doesn't exist, we'll create it
            logger.debug("No .gitignore found, will create one");
        }

        // Check if entry is already in .gitignore
        if (!hasGitignoreEntry(gitignoreContent, entry)) {
            // Add entry to .gitignore
            const updatedContent = gitignoreContent.trim()
                ? `${gitignoreContent.trim()}\n\n# ${comment}\n${entry}\n`
                : `# ${comment}\n${entry}\n`;

            await fs.writeFile(gitignorePath, updatedContent);
            logger.info(`Added ${entry} to .gitignore`);
        } else {
            logger.debug(`${entry} already in .gitignore`);
        }
    } catch (error) {
        logger.error("Failed to update .gitignore", { error, entry });
        throw error;
    }
}
