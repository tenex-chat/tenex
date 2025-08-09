import { formatAnyError } from "@/utils/error-formatter";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadLLMRouter } from "@/llm";
import { TaskPublisher, getNDK } from "@/nostr";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import { configService, getProjectContext, isProjectContextInitialized } from "@/services";
import { logger } from "@/utils/logger";
import type { NDKTask } from "@nostr-dev-kit/ndk";
import { Message } from "multi-llm-ts";
import { generateRepomixOutput } from "./repomix.js";
import "@/prompts"; // This ensures all fragments are registered
import type { AgentInstance } from "@/agents/types";

const DEFAULT_INVENTORY_PATH = "context/INVENTORY.md";

interface ComplexModule {
    name: string;
    path: string;
    reason: string;
    suggestedFilename: string;
}

interface ComplexModulesResponse {
    complexModules: ComplexModule[];
}

interface InventoryResult {
    content: string;
    complexModules: ComplexModule[];
}

interface InventoryGenerationOptions {
    conversationRootEventId?: string;
    agent?: AgentInstance;
    focusFiles?: Array<{ path: string; status: string }>;
}

/**
 * Generate comprehensive inventory using repomix + LLM
 */
export async function generateInventory(
    projectPath: string,
    options?: InventoryGenerationOptions
): Promise<void> {
    logger.info("Generating project inventory with repomix + LLM", { projectPath });

    const inventoryPath = await getInventoryPath(projectPath);

    // Ensure context directory exists
    await fs.mkdir(path.dirname(inventoryPath), { recursive: true });

    // Create NDK task if context is available
    let task: NDKTask | undefined;
    let taskPublisher: TaskPublisher | undefined;

    if (options?.agent) {
        const ndk = getNDK();
        if (ndk) {
            taskPublisher = new TaskPublisher(ndk, options.agent);

            task = await taskPublisher.createTask({
                title: "Generating Project Inventory",
                prompt: "Analyzing the codebase structure to create a comprehensive inventory with repomix + LLM",
                conversationRootEventId: options.conversationRootEventId,
            });

            // Initial status update
            await taskPublisher.publishTaskProgress(
                "🔍 Getting a general sense of the project structure and architecture..."
            );
        }
    }

    // Step 1: Generate repomix content once for efficiency
    const repomixResult = await generateRepomixOutput(projectPath);

    try {
        // Step 2: Generate main inventory with complex module identification
        const inventoryResult = await generateMainInventory(
            projectPath,
            repomixResult.content,
            options?.focusFiles
        );

        // Step 3: Save main inventory
        await fs.writeFile(inventoryPath, inventoryResult.content, "utf-8");
        logger.info("Main inventory saved", { inventoryPath });

        // Progress tracking handled by TaskPublisher

        // Step 4: Generate individual module guides for complex modules (max 10)
        const modulesToProcess = inventoryResult.complexModules.slice(0, 10);

        for (let i = 0; i < modulesToProcess.length; i++) {
            const module = modulesToProcess[i];
            if (!module) continue; // Skip if module is undefined

            // TypeScript now knows module is defined
            const definedModule: ComplexModule = module;

            try {
                if (task && taskPublisher) {
                    await taskPublisher.publishTaskProgress(
                        `🔬 Inspecting complex module: ${definedModule.name} at ${definedModule.path}`
                    );
                }

                await generateModuleGuide(projectPath, definedModule, repomixResult.content);

                // Progress tracking handled by TaskPublisher
            } catch (error) {
                logger.warn("Failed to generate module guide", {
                    module: definedModule.name,
                    error: formatAnyError(error),
                });
            }
        }

        // Final completion update
        if (task && taskPublisher) {
            // Task completion handled by TaskPublisher

            await taskPublisher.publishTaskProgress(
                `✅ Project inventory generation completed!\n\n📋 Main inventory: ${inventoryPath}\n📚 Complex module guides: ${modulesToProcess.length} generated\n\nThe codebase is now thoroughly documented and ready for analysis.`
            );
        }

        logger.info("Inventory generation completed", {
            inventoryPath,
            complexModules: modulesToProcess.length,
        });
    } finally {
        repomixResult.cleanup();
    }
}

/**
 * Generate main inventory and identify complex modules
 */
async function generateMainInventory(
    projectPath: string,
    repomixContent: string,
    focusFiles?: Array<{ path: string; status: string }>
): Promise<InventoryResult> {
    logger.debug("Generating main inventory", {
        hasFocusFiles: !!focusFiles,
        focusFileCount: focusFiles?.length,
    });

    // Use PromptBuilder to construct the prompt from fragments
    const prompt = new PromptBuilder()
        .add("main-inventory-generation", { repomixContent, focusFiles })
        .build();

    const llmRouter = await loadLLMRouter(projectPath);

    // Debug: Log the router configuration
    logger.debug("[inventory] LLM Router loaded", {
        availableConfigs: llmRouter.getConfigKeys(),
    });

    const userMessage = new Message("user", prompt);

    logger.debug("[inventory] Calling LLM with configName", {
        configName: "defaults.analyze",
        expectedResolution: "Should resolve to gemini-2.5",
    });

    const response = await llmRouter.complete({
        messages: [userMessage],
        options: {
            temperature: 0.3,
            maxTokens: 4000,
            configName: "defaults.analyze",
        },
    });

    const content = response.content || "";

    // Extract complex modules from JSON at the end
    const complexModules = await extractComplexModules(content, projectPath);

    // Strip the complexModules JSON block from the content before saving
    const cleanContent = stripComplexModulesJson(content);

    return {
        content: cleanContent,
        complexModules,
    };
}

/**
 * Generate detailed guide for a specific complex module
 */
async function generateModuleGuide(
    projectPath: string,
    module: ComplexModule,
    repomixContent: string
): Promise<void> {
    logger.debug("Generating module guide", { module: module.name });

    // Use PromptBuilder to construct the prompt from fragments
    const prompt = new PromptBuilder()
        .add("module-guide-generation", {
            repomixContent,
            moduleName: module.name,
            modulePath: module.path,
            complexityReason: module.reason,
        })
        .build();

    const llmRouter = await loadLLMRouter(projectPath);
    const userMessage = new Message("user", prompt);

    logger.debug("[inventory] Calling LLM for module guide", {
        module: module.name,
        configName: "defaults.analyze",
    });

    const response = await llmRouter.complete({
        messages: [userMessage],
        options: {
            temperature: 0.3,
            maxTokens: 6000,
            configName: "defaults.analyze",
        },
    });

    // Save module guide
    const inventoryPath = await getInventoryPath(projectPath);
    const contextDir = path.dirname(inventoryPath);
    const guideFilePath = path.join(contextDir, module.suggestedFilename);

    await fs.writeFile(guideFilePath, response.content || "", "utf-8");
    logger.info("Module guide saved", {
        module: module.name,
        guideFilePath,
    });
}

/**
 * Strip the complexModules JSON block from the inventory content
 */
function stripComplexModulesJson(content: string): string {
    // Pattern to match the entire section about complex modules JSON format
    // This includes the instruction text and the JSON block
    const complexModulesSection = /At the end.*?```json\s*\n[\s\S]*?"complexModules"[\s\S]*?\n```/g;

    // Remove the entire complex modules JSON section
    let cleanedContent = content.replace(complexModulesSection, "").trim();

    // Also handle case where JSON block might appear without the instruction text
    const jsonBlockPattern = /```json\s*\n[\s\S]*?\n```/g;
    const jsonMatches = cleanedContent.match(jsonBlockPattern);
    if (jsonMatches) {
        for (const match of jsonMatches) {
            if (match.includes('"complexModules"')) {
                cleanedContent = cleanedContent.replace(match, "").trim();
            }
        }
    }

    return cleanedContent;
}

/**
 * Type guard to validate complex modules response structure
 */
function isComplexModulesResponse(data: unknown): data is ComplexModulesResponse {
    if (typeof data !== "object" || data === null) {
        return false;
    }

    const obj = data as Record<string, unknown>;

    if (!Array.isArray(obj.complexModules)) {
        return false;
    }

    return obj.complexModules.every((module: unknown) => {
        if (typeof module !== "object" || module === null) {
            return false;
        }

        const mod = module as Record<string, unknown>;
        return (
            typeof mod.name === "string" &&
            typeof mod.path === "string" &&
            typeof mod.reason === "string" &&
            typeof mod.suggestedFilename === "string"
        );
    });
}

/**
 * Extract complex modules from LLM response with fallback mechanism
 */
async function extractComplexModules(
    content: string,
    projectPath?: string
): Promise<ComplexModule[]> {
    try {
        // Look for JSON block at the end
        const jsonMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
        if (!jsonMatch) {
            logger.debug("No JSON block found in response, trying fallback extraction");
            return projectPath ? await fallbackExtractComplexModules(content, projectPath) : [];
        }

        const jsonString = jsonMatch[1];
        if (!jsonString) {
            logger.warn("Empty JSON match found");
            return projectPath ? await fallbackExtractComplexModules(content, projectPath) : [];
        }

        const jsonData = JSON.parse(jsonString) as unknown;

        // Type guard to validate the structure
        if (isComplexModulesResponse(jsonData)) {
            return jsonData.complexModules;
        }

        logger.warn("Invalid JSON structure for complex modules");
        return [];
    } catch (error) {
        logger.warn("Failed to extract complex modules from JSON, trying fallback", { error });
        return projectPath ? await fallbackExtractComplexModules(content, projectPath) : [];
    }
}

/**
 * Fallback mechanism for JSON extraction using a cleanup LLM call
 */
async function fallbackExtractComplexModules(
    content: string,
    projectPath?: string
): Promise<ComplexModule[]> {
    if (!projectPath) {
        logger.warn("No project path provided for fallback extraction");
        return [];
    }

    try {
        // Use PromptBuilder to construct the prompt from fragments
        const cleanupPrompt = new PromptBuilder()
            .add("complex-modules-extraction", { content })
            .build();

        const llmRouter = await loadLLMRouter(projectPath);
        const userMessage = new Message("user", cleanupPrompt);

        logger.debug("[inventory] Calling LLM for fallback extraction", {
            configName: "defaults.analyze",
        });

        const response = await llmRouter.complete({
            messages: [userMessage],
            options: {
                temperature: 0.1,
                maxTokens: 1000,
                configName: "defaults.analyze",
            },
        });

        const fallbackContent = response.content || "";
        const jsonMatch = fallbackContent.match(/```json\s*\n([\s\S]*?)\n```/);

        if (jsonMatch) {
            const jsonString = jsonMatch[1];
            if (!jsonString) {
                logger.warn("Empty JSON match found in fallback");
                return [];
            }

            const jsonData = JSON.parse(jsonString) as unknown;

            // Type guard to validate the structure
            if (isComplexModulesResponse(jsonData)) {
                return jsonData.complexModules;
            }

            logger.warn("Invalid JSON structure in fallback extraction");
        }

        return [];
    } catch (error) {
        logger.warn("Fallback extraction failed", { error });
        return [];
    }
}

/**
 * Update inventory for specific files (placeholder for future implementation)
 */
export async function updateInventory(projectPath: string, files: string[]): Promise<void> {
    logger.info("Updating inventory", { projectPath, files });
    // For now, just regenerate the full inventory
    // Future optimization: implement partial updates
    await generateInventory(projectPath);
}

/**
 * Check if inventory exists
 */
export async function inventoryExists(projectPath: string): Promise<boolean> {
    try {
        const inventoryPath = await getInventoryPath(projectPath);
        await fs.access(inventoryPath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Load inventory content for system prompts
 */
export async function loadInventoryContent(projectPath: string): Promise<string | null> {
    try {
        const inventoryPath = await getInventoryPath(projectPath);
        const content = await fs.readFile(inventoryPath, "utf-8");
        return content;
    } catch (error) {
        logger.debug("Failed to load inventory content", { error });
        return null;
    }
}

/**
 * Get the inventory file path
 */
async function getInventoryPath(projectPath: string): Promise<string> {
    const projectConfig = await loadProjectConfig(projectPath);
    const inventoryPath = projectConfig?.paths?.inventory || DEFAULT_INVENTORY_PATH;
    return path.join(projectPath, inventoryPath);
}

/**
 * Load project configuration
 */
async function loadProjectConfig(
    projectPath: string
): Promise<{ paths?: { inventory?: string }; title?: string }> {
    try {
        if (isProjectContextInitialized()) {
            // Get config from ProjectContext if available
            const projectCtx = getProjectContext();
            const project = projectCtx.project;
            const titleTag = project.tags.find((tag) => tag[0] === "title");
            return {
                paths: { inventory: DEFAULT_INVENTORY_PATH },
                title: titleTag?.[1] || "Untitled Project",
            };
        }
        // Fallback: try to load config directly
        const { config } = await configService.loadConfig(projectPath);
        return config;
    } catch (error) {
        logger.debug("Failed to load project config", { error });
        return { paths: { inventory: DEFAULT_INVENTORY_PATH } };
    }
}
