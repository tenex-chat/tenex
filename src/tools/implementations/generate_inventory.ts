import { tool } from 'ai';
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { generateInventory, inventoryExists } from "@/utils/inventory";
import { logger } from "@/utils/logger";
import { z } from "zod";
import type { ExecutionContext } from "@/agents/execution/types";

const execAsync = promisify(exec);

const generateInventorySchema = z.object({});

type GenerateInventoryInput = z.infer<typeof generateInventorySchema>;
type GenerateInventoryOutput = {
  message: string;
  inventoryExists: boolean;
  regenerated: boolean;
};

// Core implementation - extracted from existing execute function
async function executeGenerateInventory(input: GenerateInventoryInput, context: ExecutionContext): Promise<GenerateInventoryOutput> {
  logger.info("Agent requesting inventory generation", {
    projectPath: context.projectPath,
  });

  // Check if inventory already exists
  const exists = await inventoryExists(context.projectPath);

  // Check for recently modified files using git status
  let focusFiles: Array<{ path: string; status: string }> | undefined;
  try {
    const { stdout } = await execAsync("git status --porcelain", {
      cwd: context.projectPath,
    });
    if (stdout.trim()) {
      focusFiles = stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => ({
          status: line.substring(0, 2).trim(),
          path: line.substring(3),
        }));

      logger.info("Detected modified files for inventory focus", {
        count: focusFiles.length,
        files: focusFiles.slice(0, 10), // Log first 10 files
      });
    }
  } catch (error) {
    logger.warn("Failed to get git status for focus files", { error });
    // Continue without focus files
  }

  // Prepare options if agent context is available
  const options = {
    focusFiles,
    agent: context.agent,
    conversationRootEventId: context.conversationId,
  };

  // Generate the inventory
  await generateInventory(context.projectPath, options);

  const statusMessage = exists
    ? "✅ Project inventory regenerated successfully!"
    : "✅ Project inventory generated successfully!";

  const message = `${statusMessage}

📋 Main inventory saved to context/INVENTORY.md
📚 Complex module guides (if any) saved to context/ directory

The inventory provides comprehensive information about the codebase structure, significant files, and architectural patterns to help with development tasks.`;

  return {
    message,
    inventoryExists: true,
    regenerated: exists,
  };
}

// AI SDK tool factory
export function createGenerateInventoryTool(context: ExecutionContext) {
  return tool({
    description: "Generate a comprehensive project inventory using repomix + LLM analysis",
    inputSchema: generateInventorySchema,
    execute: async (input: GenerateInventoryInput) => {
      return await executeGenerateInventory(input, context);
    },
  });
}

