import { CONTEXT_INJECTED_TOOLS, CORE_AGENT_TOOLS, DELEGATE_TOOLS } from "@/agents/constants";
import type { AgentInstance } from "@/agents/types";
import { config } from "@/services/ConfigService";
import type { ProjectContext } from "@/services/projects";
import { getAllToolNames } from "@/tools/registry";
import type { ToolName } from "@/tools/types";
import { logger } from "@/utils/logger";

export interface ProjectConfigOptions {
    models: string[];
    tools: string[];
}

export interface ProjectConfigSnapshot {
    model: string;
    tools: string[];
}

function isConfigurableTool(toolName: string): boolean {
    return !DELEGATE_TOOLS.includes(toolName as ToolName) &&
        !CORE_AGENT_TOOLS.includes(toolName as ToolName) &&
        !CONTEXT_INJECTED_TOOLS.includes(toolName as ToolName);
}

export class ProjectConfigOptionsService {
    async getProjectOptions(
        projectContext: Pick<ProjectContext, "agentRegistry" | "mcpManager">
    ): Promise<ProjectConfigOptions> {
        const [models, tools] = await Promise.all([
            this.getAvailableModels(),
            Promise.resolve(this.getAvailableTools(projectContext)),
        ]);

        return {
            models,
            tools,
        };
    }

    async getAvailableModels(): Promise<string[]> {
        const { llms } = await config.loadConfig();
        const configurations = llms?.configurations ?? {};
        return Object.keys(configurations).sort();
    }

    getAvailableTools(
        projectContext: Pick<ProjectContext, "agentRegistry" | "mcpManager">
    ): string[] {
        const toolNames = new Set<string>();

        for (const toolName of getAllToolNames()) {
            if (isConfigurableTool(toolName)) {
                toolNames.add(toolName);
            }
        }

        if (projectContext.mcpManager) {
            try {
                const mcpTools = projectContext.mcpManager.getCachedTools();
                for (const toolName of Object.keys(mcpTools)) {
                    if (toolName && !toolName.startsWith("mcp__tenex__")) {
                        toolNames.add(toolName);
                    }
                }
            } catch (error) {
                logger.debug("[ProjectConfigOptionsService] Failed to enumerate MCP tools", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        return Array.from(toolNames).sort();
    }

    getCurrentSnapshot(
        agent: Pick<AgentInstance, "llmConfig" | "tools">,
        options: Pick<ProjectConfigOptions, "tools">
    ): ProjectConfigSnapshot {
        const availableTools = new Set(options.tools);
        const tools = options.tools.filter((toolName) =>
            availableTools.has(toolName) && agent.tools.includes(toolName)
        );

        return {
            model: agent.llmConfig,
            tools,
        };
    }
}
