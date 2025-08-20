import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { logger } from "@/utils/logger";
import { type CliOptions, runDefaultAction } from "repomix";

export interface RepomixResult {
  content: string;
  size: number;
  lines: number;
  cleanup: () => void;
}

/**
 * Generate repository content using repomix
 * @param projectPath - The root path of the project
 * @param targetDirectory - Optional directory to analyze relative to projectPath
 */
export async function generateRepomixOutput(
  projectPath: string,
  targetDirectory?: string
): Promise<RepomixResult> {
  const outputPath = join(tmpdir(), `repomix-${randomUUID()}.xml`);

  try {
    // Resolve the target path
    let analyzePath = projectPath;
    if (targetDirectory) {
      const resolvedTarget = resolve(projectPath, targetDirectory);

      // Validate that the target directory exists
      if (!existsSync(resolvedTarget)) {
        throw new Error(`Target directory does not exist: ${targetDirectory}`);
      }

      // Ensure the target is within the project path
      const relativePath = relative(projectPath, resolvedTarget);
      if (relativePath.startsWith("..")) {
        throw new Error(`Target directory must be within the project: ${targetDirectory}`);
      }

      analyzePath = resolvedTarget;
    }

    logger.debug("Running repomix", { outputPath, projectPath, targetDirectory, analyzePath });

    // Configure repomix options for XML output
    const cliOptions: CliOptions = {
      output: outputPath,
      style: "xml",
      copyToClipboard: false,
      verbose: true,
    };

    // Use the programmatic API to generate repomix output
    const result = await runDefaultAction([analyzePath], analyzePath, cliOptions);

    // Read the generated file
    const content = readFileSync(outputPath, "utf-8");
    const lines = content.split("\n").length;

    logger.debug("Repomix output generated", {
      size: content.length,
      lines,
      totalFiles: result.packResult.totalFiles,
      totalTokens: result.packResult.totalTokens,
    });

    return {
      content,
      size: content.length,
      lines,
      cleanup: () => {
        try {
          unlinkSync(outputPath);
        } catch (e) {
          logger.warn("Failed to clean up temporary file", { outputPath, error: e });
        }
      },
    };
  } catch (error) {
    // Clean up on error
    try {
      unlinkSync(outputPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}
