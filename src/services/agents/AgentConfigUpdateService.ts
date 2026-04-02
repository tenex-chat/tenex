import { computeToolsDelta } from "@/agents/ConfigResolver";
import { agentStorage } from "@/agents/AgentStorage";
import type { AgentDefaultConfig, AgentProjectConfig } from "@/agents/types";
import { getToolTags } from "@/nostr/TagExtractor";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export interface ApplyAgentConfigUpdateResult {
    agentPubkey?: string;
    scope: "global" | "project";
    projectDTag?: string;
    configUpdated: boolean;
    pmUpdated: boolean;
    hasModel: boolean;
    toolCount: number;
    skillCount: number;
    mcpCount: number;
    hasPM: boolean;
    hasReset: boolean;
}

/**
 * Applies kind:24020 semantics to agent storage.
 *
 * Routing and project validation stay with daemon/event-handler.
 * This service owns the meaning of the event itself.
 */
export class AgentConfigUpdateService {
    async applyEvent(
        event: NDKEvent,
        options?: { projectDTag?: string }
    ): Promise<ApplyAgentConfigUpdateResult> {
        const agentPubkey = event.tagValue("p");
        const projectDTag = options?.projectDTag;
        const scope = projectDTag !== undefined ? "project" : "global";

        if (!agentPubkey) {
            logger.warn("AGENT_CONFIG_UPDATE event missing agent pubkey", {
                eventId: event.id,
                scope,
            });
            return {
                scope,
                projectDTag,
                configUpdated: false,
                pmUpdated: false,
                hasModel: false,
                toolCount: 0,
                skillCount: 0,
                mcpCount: 0,
                hasPM: false,
                hasReset: false,
            };
        }

        const newModel = event.tagValue("model");
        const newToolNames = getToolTags(event).map((tool) => tool.name).filter(Boolean);
        const skillTagValues = event.tags
            .filter((tag) => tag[0] === "skill")
            .map((tag) => tag[1]?.trim())
            .filter((skillId): skillId is string => Boolean(skillId));
        const mcpServerSlugs = event.tags
            .filter((tag) => tag[0] === "mcp")
            .map((tag) => tag[1]?.trim())
            .filter((slug): slug is string => Boolean(slug));
        const hasPMTag = event.tags.some((tag) => tag[0] === "pm");
        const hasResetTag = event.tags.some((tag) => tag[0] === "reset");

        if (projectDTag !== undefined) {
            return {
                agentPubkey,
                scope,
                projectDTag,
                ...(await this.applyProjectScopedUpdate({
                    agentPubkey,
                    projectDTag,
                    newModel,
                    newToolNames,
                    skillTagValues,
                    mcpServerSlugs,
                    hasPMTag,
                    hasResetTag,
                    event,
                })),
            };
        }

        return {
            agentPubkey,
            scope,
            ...(await this.applyGlobalUpdate({
                agentPubkey,
                newModel,
                newToolNames,
                skillTagValues,
                mcpServerSlugs,
                hasPMTag,
                hasResetTag,
                event,
            })),
        };
    }

    private async applyProjectScopedUpdate(params: {
        agentPubkey: string;
        projectDTag: string;
        newModel: string | undefined;
        newToolNames: string[];
        skillTagValues: string[];
        mcpServerSlugs: string[];
        hasPMTag: boolean;
        hasResetTag: boolean;
        event: NDKEvent;
    }): Promise<Omit<ApplyAgentConfigUpdateResult, "agentPubkey" | "scope" | "projectDTag">> {
        let configUpdated = false;

        if (params.hasResetTag) {
            configUpdated = await agentStorage.updateProjectOverride(
                params.agentPubkey,
                params.projectDTag,
                {},
                true
            );
        } else {
            const projectOverride: AgentProjectConfig = {};

            if (params.newModel) {
                projectOverride.model = params.newModel;
            }

            const hasRawToolTags = params.event.tags.some((tag) => tag[0] === "tool");
            if (hasRawToolTags) {
                const storedAgent = await agentStorage.loadAgent(params.agentPubkey);
                const defaultTools = storedAgent?.default?.tools ?? [];
                const toolsDelta = computeToolsDelta(defaultTools, params.newToolNames);
                if (toolsDelta.length > 0) {
                    projectOverride.tools = toolsDelta;
                }
            }

            const hasSkillTags = params.event.tags.some((tag) => tag[0] === "skill");
            if (hasSkillTags) {
                projectOverride.skills = params.skillTagValues;
            }

            const hasMcpTags = params.event.tags.some((tag) => tag[0] === "mcp");
            if (hasMcpTags) {
                projectOverride.mcpAccess = params.mcpServerSlugs;
            }

            configUpdated = await agentStorage.updateProjectOverride(
                params.agentPubkey,
                params.projectDTag,
                projectOverride
            );
        }

        let pmUpdated = false;
        if (params.hasResetTag) {
            pmUpdated = await agentStorage.updateProjectScopedIsPM(
                params.agentPubkey,
                params.projectDTag,
                undefined
            );
        } else if (params.hasPMTag) {
            pmUpdated = await agentStorage.updateProjectScopedIsPM(
                params.agentPubkey,
                params.projectDTag,
                true
            );
        }

        return {
            configUpdated,
            pmUpdated,
            hasModel: !!params.newModel,
            toolCount: params.newToolNames.length,
            skillCount: params.skillTagValues.length,
            mcpCount: params.mcpServerSlugs.length,
            hasPM: params.hasPMTag,
            hasReset: params.hasResetTag,
        };
    }

    private async applyGlobalUpdate(params: {
        agentPubkey: string;
        newModel: string | undefined;
        newToolNames: string[];
        skillTagValues: string[];
        mcpServerSlugs: string[];
        hasPMTag: boolean;
        hasResetTag: boolean;
        event: NDKEvent;
    }): Promise<Omit<ApplyAgentConfigUpdateResult, "agentPubkey" | "scope" | "projectDTag">> {
        const defaultUpdates: AgentDefaultConfig = {};

        const hasModelTag = params.event.tags.some((tag) => tag[0] === "model");
        if (hasModelTag && params.newModel) {
            defaultUpdates.model = params.newModel;
        }

        const hasToolTags = params.event.tags.some((tag) => tag[0] === "tool");
        if (hasToolTags) {
            defaultUpdates.tools = params.newToolNames;
        }

        const hasSkillTags = params.event.tags.some((tag) => tag[0] === "skill");
        if (hasSkillTags) {
            defaultUpdates.skills = params.skillTagValues;
        }

        const hasMcpTags = params.event.tags.some((tag) => tag[0] === "mcp");
        if (hasMcpTags) {
            defaultUpdates.mcpAccess = params.mcpServerSlugs;
        }

        const configUpdated = await agentStorage.updateDefaultConfig(
            params.agentPubkey,
            defaultUpdates,
            { clearProjectOverrides: true }
        );
        const pmUpdated = await agentStorage.updateAgentIsPM(params.agentPubkey, params.hasPMTag);

        return {
            configUpdated,
            pmUpdated,
            hasModel: !!params.newModel,
            toolCount: params.newToolNames.length,
            skillCount: params.skillTagValues.length,
            mcpCount: params.mcpServerSlugs.length,
            hasPM: params.hasPMTag,
            hasReset: params.hasResetTag,
        };
    }
}
