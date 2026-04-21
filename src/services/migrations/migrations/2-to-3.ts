import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTenexBasePath } from "@/constants";
import { directoryExists } from "@/lib/fs";
import { logger } from "@/utils/logger";
import type { MigrationRunResult, StateMigration } from "../types";

export const migration2To3: StateMigration = {
    from: 2,
    to: 3,
    description: "Bundle built-in skills to TENEX_BASE_DIR/skills/",
    run: migrate2To3,
};

async function migrate2To3(): Promise<MigrationRunResult> {
    const sourceDir = await resolveBuiltInSkillsSourceDir();
    const targetDir = path.join(getTenexBasePath(), "skills", "built-in");

    if (!sourceDir) {
        logger.info("[Migration 2→3] Built-in skills source not found, skipping migration");
        return { migratedCount: 0, skippedCount: 0, warnings: [] };
    }

    try {
        const entries = await fs.readdir(sourceDir, { withFileTypes: true });
        const skillCount = entries.filter((entry) => entry.isDirectory()).length;

        logger.info("[Migration 2→3] Bundling built-in skills", { sourceDir, targetDir });
        await fs.cp(sourceDir, targetDir, {
            recursive: true,
            force: true,
        });

        logger.info("[Migration 2→3] Migration completed");
        return { migratedCount: skillCount, skippedCount: 0, warnings: [] };
    } catch (error) {
        logger.error("[Migration 2→3] Migration failed", {
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}

async function resolveBuiltInSkillsSourceDir(): Promise<string | null> {
    const candidates = [
        path.resolve(import.meta.dirname, "../../../skills/built-in"),
        path.resolve(import.meta.dirname, "../src/skills/built-in"),
    ];

    for (const candidate of candidates) {
        if (await directoryExists(candidate)) {
            return candidate;
        }
    }

    return null;
}
