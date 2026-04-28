import { z } from "zod";
import { tool } from "ai";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { SkillService } from "@/services/skill/SkillService";
import type { SkillStoreScope } from "@/services/skill/types";

const MAX_DESCRIPTION_LENGTH = 150;

interface SkillSummary {
    identifier: string;
    name?: string;
    description?: string;
    scope: SkillStoreScope;
    hasTools: boolean;
}

interface SkillListResult {
    total: number;
    scopes: {
        yourProject: SkillSummary[];
        yourAll: SkillSummary[];
        project: SkillSummary[];
        global: SkillSummary[];
        builtIn: SkillSummary[];
    };
    counts: {
        yourProject: number;
        yourAll: number;
        project: number;
        global: number;
        builtIn: number;
        total: number;
    };
}

function scopeToKey(scope: SkillStoreScope): keyof SkillListResult["scopes"] {
    switch (scope) {
        case "agent-project": return "yourProject";
        case "agent": return "yourAll";
        case "project": return "project";
        case "shared": return "global";
        case "built-in": return "builtIn";
    }
}

function truncateDescription(value?: string): string | undefined {
    if (!value) return undefined;
    const flat = value.replace(/\n/g, " ");
    return flat.length > MAX_DESCRIPTION_LENGTH ? flat.substring(0, MAX_DESCRIPTION_LENGTH) : flat;
}

export function createSkillListTool(context: ToolExecutionContext): AISdkTool {
    const { agent, projectBasePath } = context;

    return tool({
        description:
            "List all available skills grouped by scope (yourProject, yourAll, project, global, builtIn) with per-scope counts and total. Blocked skills are excluded.",
        inputSchema: z.object({}),
        execute: async () => {
            const skillService = SkillService.getInstance();
            const filteredSkills = await skillService.listAvailableSkills({
                agentPubkey: agent.pubkey,
                projectPath: projectBasePath || undefined,
            });

            const result: SkillListResult = {
                total: 0,
                scopes: {
                    yourProject: [],
                    yourAll: [],
                    project: [],
                    global: [],
                    builtIn: [],
                },
                counts: {
                    yourProject: 0,
                    yourAll: 0,
                    project: 0,
                    global: 0,
                    builtIn: 0,
                    total: 0,
                },
            };

            for (const skill of filteredSkills) {
                const key = scopeToKey(skill.scope ?? "shared");
                const summary: SkillSummary = {
                    identifier: skill.identifier,
                    scope: skill.scope ?? "shared",
                    hasTools: (skill.toolNames?.length ?? 0) > 0,
                    ...(skill.name !== undefined && { name: skill.name }),
                    ...(skill.description !== undefined || skill.content !== undefined
                        ? { description: truncateDescription(skill.description ?? skill.content) }
                        : {}),
                };
                result.scopes[key].push(summary);
                result.counts[key]++;
                result.counts.total++;
            }

            result.total = result.counts.total;

            return result;
        },
    }) as AISdkTool;
}
