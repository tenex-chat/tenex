import * as fs from "node:fs";
import * as path from "node:path";
import type { Phase } from "@/conversations/phases";
import { logger } from "@/utils/logger";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

// Project inventory context fragment
interface InventoryContextArgs {
    phase: Phase;
}

// Helper function to count total files recursively
function countTotalFiles(dir: string): number {
    let count = 0;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
                if (entry.isDirectory()) {
                    count += countTotalFiles(path.join(dir, entry.name));
                } else {
                    count += 1;
                }
            }
        }
    } catch (error) {
        logger.debug(`Could not count files in ${dir}`, { error });
    }
    return count;
}

// Helper function to get project files (excluding dot files/dirs)
function getProjectFiles(): { files: string[]; isEmpty: boolean; tree: string } {
    const projectFiles: string[] = [];
    let isEmpty = true;
    let totalFileCount = 0;

    // Helper function to count files in a directory (non-recursive, only direct children)
    function countDirectFiles(dir: string): number {
        let count = 0;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (
                    !entry.name.startsWith(".") &&
                    entry.name !== "node_modules" &&
                    !entry.isDirectory()
                ) {
                    count += 1;
                }
            }
        } catch (error) {
            logger.debug(`Could not count files in ${dir}`, { error });
        }
        return count;
    }

    // Helper function to build tree structure recursively
    function buildTree(dir: string, prefix = "", isLast = true, showFiles = true): string[] {
        const treeLines: string[] = [];

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            // Filter and sort entries
            const filteredEntries = entries.filter((entry) => {
                // Skip dot files/dirs and node_modules
                return !entry.name.startsWith(".") && entry.name !== "node_modules";
            });

            // Sort directories first, then files
            filteredEntries.sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.localeCompare(b.name);
            });

            filteredEntries.forEach((entry, index) => {
                const isLastEntry = index === filteredEntries.length - 1;
                const connector = isLastEntry ? "└── " : "├── ";
                const extension = isLastEntry ? "    " : "│   ";

                if (entry.isDirectory()) {
                    const subDir = path.join(dir, entry.name);
                    // Always show directories and recurse
                    if (showFiles) {
                        treeLines.push(`${prefix}${connector}${entry.name}/`);
                    } else {
                        // Count only direct files in this directory
                        const fileCount = countDirectFiles(subDir);
                        const fileLabel =
                            fileCount === 0
                                ? ""
                                : fileCount === 1
                                  ? " (1 file)"
                                  : ` (${fileCount} files)`;
                        treeLines.push(`${prefix}${connector}${entry.name}/${fileLabel}`);
                    }
                    // Always recurse into subdirectories
                    const subTree = buildTree(subDir, prefix + extension, isLastEntry, showFiles);
                    treeLines.push(...subTree);
                } else if (showFiles) {
                    treeLines.push(`${prefix}${connector}${entry.name}`);
                }
            });
        } catch (error) {
            logger.debug(`Could not read directory ${dir}`, { error });
        }

        return treeLines;
    }

    try {
        const projectDir = process.cwd();
        const entries = fs.readdirSync(projectDir, { withFileTypes: true });

        for (const entry of entries) {
            // Skip dot files/dirs and node_modules
            if (entry.name.startsWith(".") || entry.name === "node_modules") {
                continue;
            }

            isEmpty = false;

            if (entry.isDirectory()) {
                projectFiles.push(`${entry.name}/`);
            } else {
                projectFiles.push(entry.name);
            }
        }

        // Sort directories first, then files
        projectFiles.sort((a, b) => {
            const aIsDir = a.endsWith("/");
            const bIsDir = b.endsWith("/");
            if (aIsDir && !bIsDir) return -1;
            if (!aIsDir && bIsDir) return 1;
            return a.localeCompare(b);
        });
    } catch (error) {
        logger.debug("Could not read project directory", { error });
    }

    // Count total files to decide whether to show individual files
    totalFileCount = countTotalFiles(process.cwd());
    const showFiles = totalFileCount <= 40;

    // Build the tree structure
    const treeLines = buildTree(process.cwd(), "", true, showFiles);

    // If not showing files and there are files in the root directory, add a count
    if (!showFiles) {
        const rootFileCount = countDirectFiles(process.cwd());
        if (rootFileCount > 0) {
            const fileLabel =
                rootFileCount === 1 ? "1 file in root" : `${rootFileCount} files in root`;
            treeLines.push(`\n(${fileLabel})`);
        }
    }

    const tree = treeLines.join("\n");

    return { files: projectFiles, isEmpty, tree };
}

// Helper function to load inventory and context synchronously
function loadProjectContextSync(phase: Phase): {
    inventoryContent: string | null;
    projectContent: string | null;
    contextFiles: string[];
} {
    let inventoryContent: string | null = null;
    let contextFiles: string[] = [];

    // Load inventory content for chat and brainstorm phases
    if (phase === "chat" || phase === "brainstorm") {
        try {
            const inventoryPath = path.join(process.cwd(), "context", "INVENTORY.md");
            if (fs.existsSync(inventoryPath)) {
                inventoryContent = fs.readFileSync(inventoryPath, "utf8");
            }
        } catch (error) {
            logger.debug("Could not load inventory content", { error });
        }
    }

    // Get list of context files
    try {
        const contextDir = path.join(process.cwd(), "context");
        if (fs.existsSync(contextDir)) {
            const files = fs.readdirSync(contextDir);
            contextFiles = files.filter(
                (f) => f.endsWith(".md") && f !== "INVENTORY.md" && f !== "PROJECT.md"
            );
        }
    } catch (error) {
        // Context directory may not exist
        logger.debug("Could not read context directory", { error });
    }

    return { inventoryContent, projectContent: null, contextFiles };
}

export const inventoryContextFragment: PromptFragment<InventoryContextArgs> = {
    id: "project-inventory-context",
    priority: 25,
    template: (args) => {
        const { phase } = args;

        // If content is provided directly, use it; otherwise load from file
        const loaded = loadProjectContextSync(phase);
        const { inventoryContent, contextFiles } = loaded;

        const parts: string[] = [];

        parts.push(`<project_inventory>
The project inventory provides comprehensive information about this codebase:
`);

        if (inventoryContent) {
            parts.push(`${inventoryContent}

This inventory helps you understand the project structure, significant files, and architectural patterns when working with the codebase.

This is just a map for you to be quickly situated.
`);
        } else {
            // Get project files to determine if this is a fresh project
            const { isEmpty, tree } = getProjectFiles();

            if (isEmpty) {
                parts.push(`## Project Context
This is a fresh project with no files yet.`);
            } else {
                // Count total files to determine if we should strongly recommend inventory generation
                const totalFileCount = countTotalFiles(process.cwd());
                
                if (totalFileCount > 15) {
                    parts.push(`## Project Context

⚠️ **IMPORTANT: Project Inventory Recommended**

This project contains ${totalFileCount} files but lacks a proper inventory. For optimal results, we strongly recommend having the @project-manager agent explore and familiarize itself with the codebase first.

**To generate an inventory, ask:** "@project-manager please explore this project and generate an initial inventory"

This will help all agents better understand:
- Project structure and architecture
- Key files and their purposes
- Technology stack and dependencies
- Coding patterns and conventions

**Current file structure:**

\`\`\`
${tree}
\`\`\`
`);
                } else {
                    parts.push(`## Project Context

A proper project inventory does not exist yet. The @project-manager agent can generate a comprehensive inventory to improve results.

Here is a basic file structure we created for you:

\`\`\`
${tree}
\`\`\`
`);
                }
            }
        }

        // Add context files listing if available
        if (contextFiles && contextFiles.length > 0) {
            parts.push(`### Additional Context Files
The following documentation files are available in the context/ directory and can be read using the read_path tool:
${contextFiles.map((f) => `- context/${f}`).join("\n")}`);
        }

        parts.push("</project_inventory>\n");

        return parts.join("\n\n");
    },
    validateArgs: (args): args is InventoryContextArgs => {
        return (
            typeof args === "object" &&
            args !== null &&
            typeof (args as InventoryContextArgs).phase === "string"
        );
    },
};

// Register fragments
fragmentRegistry.register(inventoryContextFragment);
