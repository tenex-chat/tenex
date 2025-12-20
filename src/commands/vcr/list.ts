import { Command } from "commander";
import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import chalk from "chalk";

/**
 * Lists recorded LLM interactions from the flight recorder
 */
export function createListCommand(): Command {
    const cmd = new Command("list")
        .description("List recorded LLM interactions")
        .option(
            "--since <date>",
            "Only show recordings since this date (YYYY-MM-DD)"
        )
        .option(
            "--dir <path>",
            "Recordings directory",
            join(homedir(), ".tenex", "recordings")
        )
        .action(async (options) => {
            await listRecordings(options);
        });

    return cmd;
}

async function listRecordings(options: {
    since?: string;
    dir: string;
}): Promise<void> {
    const baseDir = options.dir;

    try {
        // Read all date directories
        const entries = await readdir(baseDir, { withFileTypes: true });
        const dateDirs = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
            .sort();

        if (dateDirs.length === 0) {
            console.log(chalk.yellow("No recordings found"));
            return;
        }

        // Filter by --since if provided
        const sinceDate = options.since ? new Date(options.since) : null;
        const filteredDirs = dateDirs.filter((dir) => {
            if (!sinceDate) return true;
            const dirDate = new Date(dir);
            return dirDate >= sinceDate;
        });

        if (filteredDirs.length === 0) {
            console.log(
                chalk.yellow(
                    `No recordings found since ${options.since}`
                )
            );
            return;
        }

        // List recordings by date
        let totalRecordings = 0;

        for (const dateDir of filteredDirs) {
            const dirPath = join(baseDir, dateDir);
            const files = await readdir(dirPath);
            const recordings = files.filter((f) => f.endsWith(".json"));

            if (recordings.length === 0) continue;

            console.log(chalk.bold(`\n${dateDir}`));
            console.log(chalk.gray("─".repeat(40)));

            // Get file stats and sort by time
            const fileStats = await Promise.all(
                recordings.map(async (file) => {
                    const filePath = join(dirPath, file);
                    const stats = await stat(filePath);
                    return { file, stats };
                })
            );

            fileStats.sort(
                (a, b) => a.stats.mtime.getTime() - b.stats.mtime.getTime()
            );

            // Display each recording
            for (const { file, stats } of fileStats) {
                const time = stats.mtime.toISOString().split("T")[1].split(".")[0];
                const size = formatBytes(stats.size);
                console.log(
                    `  ${chalk.cyan(time)}  ${chalk.gray(file.padEnd(40))}  ${chalk.dim(size)}`
                );
                totalRecordings++;
            }
        }

        console.log(
            chalk.bold(`\nTotal: ${totalRecordings} recordings`)
        );
    } catch (error) {
        if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
        ) {
            console.log(chalk.yellow(`No recordings directory found at: ${baseDir}`));
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
