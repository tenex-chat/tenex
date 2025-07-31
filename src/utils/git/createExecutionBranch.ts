import { execSync } from "node:child_process";
import { logger } from "@/utils/logger";

export interface GitBranchResult {
    branchName: string;
    created: boolean;
}

/**
 * Create a git branch for execution
 */
export function createExecutionBranch(
    baseName: string,
    projectPath: string = process.cwd()
): GitBranchResult {
    try {
        // Check if we're in a git repository
        try {
            execSync("git status", {
                cwd: projectPath,
                stdio: "ignore",
            });
        } catch {
            logger.info("Not a git repository, initializing git repository");
            try {
                execSync("git init", {
                    cwd: projectPath,
                    stdio: "pipe",
                });
                logger.info("Git repository initialized successfully");
            } catch (initError) {
                logger.error("Failed to initialize git repository", { error: initError });
                return { branchName: "no-git", created: false };
            }
        }

        // Generate branch name
        const safeName = baseName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .substring(0, 30);

        const timestamp = Date.now();
        const branchName = `tenex/${safeName}-${timestamp}`;

        // Create and checkout new branch
        execSync(`git checkout -b ${branchName}`, {
            cwd: projectPath,
            stdio: "pipe",
        });

        logger.info("Created execution branch", { branchName });
        return { branchName, created: true };
    } catch (error) {
        logger.error("Failed to create git branch", { error });
        return { branchName: "main", created: false };
    }
}
