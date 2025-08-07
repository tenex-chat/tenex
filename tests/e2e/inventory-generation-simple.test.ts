import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createTempDir, cleanupTempDir } from "@/test-utils";
import { pathExists } from "@/lib/fs/filesystem";

// Mock the inventory generation utilities
const mockGenerateInventory = mock(async (projectPath: string) => {
    const inventoryPath = path.join(projectPath, "context", "INVENTORY.md");
    await fs.mkdir(path.dirname(inventoryPath), { recursive: true });
    await fs.writeFile(inventoryPath, `# Project Inventory

## Overview
This is a mock inventory for testing purposes.

## Structure
- src/ - Source code
- tests/ - Test files
- context/ - Context and documentation

## Key Components
1. Agent System
2. Tool Framework  
3. Conversation Management

## Architecture
The project follows a modular architecture with clear separation of concerns.
`);
});

mock.module("@/utils/inventory", () => ({
    generateInventory: mockGenerateInventory,
    inventoryExists: mock(async (projectPath: string) => {
        try {
            await fs.access(path.join(projectPath, "context", "INVENTORY.md"));
            return true;
        } catch {
            return false;
        }
    })
}));

// Import the tool after mocking dependencies
import { generateInventoryTool } from "@/tools/implementations/generateInventory";
import type { ToolContext } from "@/tools/types";

describe("E2E: Simple Inventory Generation", () => {
    let testDir: string;
    let projectPath: string;

    beforeEach(async () => {
        testDir = await createTempDir();
        projectPath = path.join(testDir, "test-project");
        await fs.mkdir(projectPath, { recursive: true });
        
        // Reset mock
        mockGenerateInventory.mockClear();
    });

    afterEach(async () => {
        await cleanupTempDir(testDir);
    });

    it("should generate inventory when tool is executed", async () => {
        const context: ToolContext = {
            projectPath,
            conversationId: "test-conversation",
            agent: {
                id: "test-agent",
                name: "Test Agent",
                model: "test-model",
                tools: ["generate_inventory"]
            },
            userId: "test-user"
        };

        // Execute the tool
        const result = await generateInventoryTool.execute({}, context);
        
        // Verify successful execution
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.inventoryExists).toBe(true);
            expect(result.value.regenerated).toBe(false);
            expect(result.value.message).toContain("Project inventory generated successfully!");
        }
        
        // Verify inventory generation was called
        expect(mockGenerateInventory).toHaveBeenCalledTimes(1);
        expect(mockGenerateInventory).toHaveBeenCalledWith(
            projectPath,
            expect.objectContaining({
                agent: context.agent,
                conversationRootEventId: "test-conversation"
            })
        );
        
        // Verify inventory file was created
        const inventoryPath = path.join(projectPath, "context", "INVENTORY.md");
        const inventoryExists = await pathExists(inventoryPath);
        expect(inventoryExists).toBe(true);
        
        // Verify content
        const content = await fs.readFile(inventoryPath, 'utf-8');
        expect(content).toContain("# Project Inventory");
        expect(content).toContain("## Overview");
        expect(content).toContain("mock inventory for testing");
    });

    it("should handle existing inventory", async () => {
        // Pre-create an inventory
        const inventoryPath = path.join(projectPath, "context", "INVENTORY.md");
        await fs.mkdir(path.dirname(inventoryPath), { recursive: true });
        await fs.writeFile(inventoryPath, "# Old Inventory\nOutdated content");

        const context: ToolContext = {
            projectPath,
            conversationId: "test-conversation",
            agent: undefined,
            userId: "test-user"
        };

        // Execute the tool
        const result = await generateInventoryTool.execute({}, context);
        
        // Verify regeneration
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.inventoryExists).toBe(true);
            expect(result.value.regenerated).toBe(true);
            expect(result.value.message).toContain("Project inventory regenerated successfully!");
        }
        
        // Verify new content
        const content = await fs.readFile(inventoryPath, 'utf-8');
        expect(content).not.toContain("Old Inventory");
        expect(content).toContain("# Project Inventory");
    });

    it("should handle tool execution errors", async () => {
        mockGenerateInventory.mockRejectedValueOnce(new Error("Test error"));

        const context: ToolContext = {
            projectPath,
            conversationId: "test-conversation",
            agent: undefined,
            userId: "test-user"
        };

        const result = await generateInventoryTool.execute({}, context);
        
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe("execution");
            expect(result.error.tool).toBe("generate_inventory");
            expect(result.error.message).toBe("Test error");
        }
    });
});