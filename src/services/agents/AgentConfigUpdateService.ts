import { agentStorage } from "@/agents/AgentStorage";
import type { AgentDefaultConfig } from "@/agents/types";
import { getToolTags } from "@/nostr/TagExtractor";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export interface ApplyAgentConfigUpdateResult {
    agentPubkey?: string;
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
    async applyEvent(event: NDKEvent): Promise<ApplyAgentConfigUpdateResult> {
        const agentPubkey = event.tagValue("p");

        if (!agentPubkey) {
            logger.warn("AGENT_CONFIG_UPDATE event missing agent pubkey", {
                eventId: event.id,
            });
            return {
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
        const blockedSkillValues = event.tags
            .filter((tag) => tag[0] === "blocked-skill")
            .map((tag) => tag[1]?.trim())
            .filter((skillId): skillId is string => Boolean(skillId));
        const mcpServerSlugs = event.tags
            .filter((tag) => tag[0] === "mcp")
            .map((tag) => tag[1]?.trim())
            .filter((slug): slug is string => Boolean(slug));
        const hasPMTag = event.tags.some((tag) => tag[0] === "pm");
        const hasResetTag = event.tags.some((tag) => tag[0] === "reset");

        return {
            agentPubkey,
            ...(await this.applyGlobalUpdate({
                agentPubkey,
                newModel,
                newToolNames,
                skillTagValues,
                blockedSkillValues,
                mcpServerSlugs,
                hasPMTag,
                hasResetTag,
                event,
            })),
        };
    }

    private async applyGlobalUpdate(params: {
        agentPubkey: string;
        newModel: string | undefined;
        newToolNames: string[];
        skillTagValues: string[];
        blockedSkillValues: string[];
        mcpServerSlugs: string[];
        hasPMTag: boolean;
        hasResetTag: boolean;
        event: NDKEvent;
    }): Promise<Omit<ApplyAgentConfigUpdateResult, "agentPubkey">> {
        if (params.hasResetTag) {
            const configUpdated = await agentStorage.resetDefaultConfig(params.agentPubkey);
            return {
                configUpdated,
                pmUpdated: configUpdated,
                hasModel: !!params.newModel,
                toolCount: params.newToolNames.length,
                skillCount: params.skillTagValues.length,
                mcpCount: params.mcpServerSlugs.length,
                hasPM: params.hasPMTag,
                hasReset: params.hasResetTag,
            };
        }

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

        const hasBlockedSkillTags = params.event.tags.some((tag) => tag[0] === "blocked-skill");
        if (hasBlockedSkillTags) {
            defaultUpdates.blockedSkills = params.blockedSkillValues;
        }

        const hasMcpTags = params.event.tags.some((tag) => tag[0] === "mcp");
        if (hasMcpTags) {
            defaultUpdates.mcpAccess = params.mcpServerSlugs;
        }

        const configUpdated = await agentStorage.updateDefaultConfig(
            params.agentPubkey,
            defaultUpdates
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
