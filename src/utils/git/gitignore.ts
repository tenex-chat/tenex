import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@/utils/logger";

/**
 * Ensures .tenex is in the project's .gitignore file
 */
export async function ensureTenexInGitignore(projectPath: string): Promise<void> {
  const gitignorePath = path.join(projectPath, ".gitignore");

  try {
    let gitignoreContent = "";

    // Check if .gitignore exists
    try {
      gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
    } catch {
      // .gitignore doesn't exist, we'll create it
      logger.info("No .gitignore found, will create one");
    }

    // Check if .tenex is already in .gitignore
    const lines = gitignoreContent.split("\n");
    const hasTenexEntry = lines.some(
      (line) =>
        line.trim() === ".tenex" ||
        line.trim() === ".tenex/" ||
        line.trim() === "/.tenex" ||
        line.trim() === "/.tenex/"
    );

    if (!hasTenexEntry) {
      // Add .tenex to .gitignore
      const updatedContent = gitignoreContent.trim()
        ? `${gitignoreContent.trim()}\n\n# TENEX project files\n.tenex/\n`
        : "# TENEX project files\n.tenex/\n";

      await fs.writeFile(gitignorePath, updatedContent);
      logger.info("Added .tenex/ to .gitignore");
    } else {
      logger.info(".tenex already in .gitignore");
    }
  } catch (error) {
    logger.error("Failed to update .gitignore", { error });
    throw error;
  }
}
