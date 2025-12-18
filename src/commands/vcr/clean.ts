import { Command } from "commander";
import { readdir, rm, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import chalk from "chalk";

/**
 * Cleans up old flight recordings
 */
export function createCleanCommand(): Command {
    const cmd = new Command("clean")
        .description("Clean up old recordings")
        .option(
            "--older-than <days>",
            "Remove recordings older than N days",
            "30"
        )
        .option(
            "--dir <path>",
            "Recordings directory",
            join(homedir(), ".tenex", "recordings")
        )
        .option("--dry-run", "Show what would be deleted without deleting")
        .action(async (options) => {
            await cleanRecordings(options);
        });

    return cmd;
}

async function cleanRecordings(options: {
    olderThan: string;
    dir: string;
    dryRun?: boolean;
}): Promise<void> {
    const baseDir = options.dir;
    const olderThanDays = parseInt(options.olderThan, 10);

    if (isNaN(olderThanDays) || olderThanDays < 0) {
        console.error(
            chalk.red("Invalid --older-than value, must be a positive number")
        );
        process.exit(1);
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    try {
        // Read all date directories
        const entries = await readdir(baseDir, { withFileTypes: true });
        const dateDirs = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name));

        if (dateDirs.length === 0) {
            console.log(chalk.yellow("No recordings found"));
            return;
        }

        let totalDeleted = 0;
        let totalSize = 0;

        for (const dateDir of dateDirs) {
            const dirDate = new Date(dateDir);

            if (dirDate < cutoffDate) {
                const dirPath = join(baseDir, dateDir);

                // Calculate directory size
                const files = await readdir(dirPath);
                let dirSize = 0;
                for (const file of files) {
                    const filePath = join(dirPath, file);
                    const stats = await stat(filePath);
                    dirSize += stats.size;
                }

                if (options.dryRun) {
                    console.log(
                        chalk.yellow(
                            `Would delete: ${dateDir} (${formatBytes(dirSize)})`
                        )
                    );
                } else {
                    await rm(dirPath, { recursive: true, force: true });
                    console.log(
                        chalk.gray(
                            `Deleted: ${dateDir} (${formatBytes(dirSize)})`
                        )
                    );
                }

                totalDeleted++;
                totalSize += dirSize;
            }
        }

        if (totalDeleted === 0) {
            console.log(
                chalk.green(
                    `No recordings older than ${olderThanDays} days found`
                )
            );
        } else {
            const action = options.dryRun ? "Would delete" : "Deleted";
            console.log(
                chalk.bold(
                    `\n${action}: ${totalDeleted} day(s) of recordings (${formatBytes(totalSize)})`
                )
            );
        }
    } catch (error) {
        if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            console.log(
                chalk.yellow(`No recordings directory found at: ${baseDir}`)
            );
            return;
        }
        throw error;
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
