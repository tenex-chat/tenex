/**
 * SkillToolLoader — dynamically loads tool implementations from skill directories.
 *
 * Each skill may contain a `tools/` subdirectory with `.ts` modules that export
 * a `createTools(context)` factory function returning `Record<string, AISdkTool>`.
 */

import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import type { SkillData } from "./types";
import { logger } from "@/utils/logger";
import { existsSync } from "fs";
import { readdir } from "fs/promises";
import { join } from "path";

const TOOLS_DIR_NAME = "tools";

/**
 * Resolve the absolute path to a skill's `tools/` directory, if it exists.
 * Returns null if the skill has no localDir or the tools/ subdirectory is missing.
 */
export async function getSkillToolsDir(skillData: SkillData): Promise<string | null> {
    if (!skillData.localDir) {
        return null;
    }

    const toolsDir = join(skillData.localDir, TOOLS_DIR_NAME);
    if (!existsSync(toolsDir)) {
        return null;
    }

    return toolsDir;
}

/**
 * Expected export shape from each tool module in a skill's tools/ directory.
 */
interface SkillToolModule {
    createTools: (context: ToolExecutionContext) => Record<string, AISdkTool>;
}

function isSkillToolModule(mod: unknown): mod is SkillToolModule {
    return (
        typeof mod === "object" &&
        mod !== null &&
        "createTools" in mod &&
        typeof (mod as Record<string, unknown>).createTools === "function"
    );
}

/**
 * Dynamically import all tool modules from a single skill's `tools/` directory
 * and call each module's `createTools(context)` factory.
 *
 * Returns a merged record of all tools provided by the skill.
 * Logs warnings for modules that fail to load but does not throw.
 */
export async function loadSkillTools(
    skillData: SkillData,
    context: ToolExecutionContext
): Promise<Record<string, AISdkTool>> {
    const toolsDir = await getSkillToolsDir(skillData);
    if (!toolsDir) {
        return {};
    }

    const result: Record<string, AISdkTool> = {};

    let entries: string[];
    try {
        entries = await readdir(toolsDir);
    } catch (err) {
        logger.warn(`[SkillToolLoader] Failed to read tools dir for skill "${skillData.identifier}"`, { error: err });
        return {};
    }

    const tsFiles = entries.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"));

    for (const file of tsFiles) {
        const filePath = join(toolsDir, file);
        try {
            const mod: unknown = await import(filePath);

            if (!isSkillToolModule(mod)) {
                logger.warn(
                    `[SkillToolLoader] Module "${file}" in skill "${skillData.identifier}" does not export createTools()`
                );
                continue;
            }

            const tools = mod.createTools(context);
            for (const [name, toolImpl] of Object.entries(tools)) {
                if (result[name]) {
                    logger.warn(
                        `[SkillToolLoader] Duplicate tool name "${name}" in skill "${skillData.identifier}", overwriting`
                    );
                }
                result[name] = toolImpl;
            }
        } catch (err) {
            logger.warn(`[SkillToolLoader] Failed to load tool module "${file}" from skill "${skillData.identifier}"`, {
                error: err,
            });
        }
    }

    return result;
}

/**
 * Load and merge tools from all active skills.
 *
 * Iterates over the provided skill list, loads each skill's tools, and merges
 * them into a single record. Later skills overwrite earlier ones on name collision.
 */
export async function loadAllSkillTools(
    skills: SkillData[],
    context: ToolExecutionContext
): Promise<Record<string, AISdkTool>> {
    const result: Record<string, AISdkTool> = {};

    for (const skill of skills) {
        const tools = await loadSkillTools(skill, context);
        Object.assign(result, tools);
    }

    return result;
}
