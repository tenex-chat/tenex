import { agentStorage } from "@/agents/AgentStorage";
import type { AgentDefaultConfig } from "@/agents/types";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export interface ApplyAgentConfigUpdateResult {
    agentPubkey?: string;
    configUpdated: boolean;
    hasModel: boolean;
    skillCount: number;
    mcpCount: number;
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
                hasModel: false,
                skillCount: 0,
                mcpCount: 0,
            };
        }

        const newModel = event.tagValue("model");
        const skillTagValues = event.tags
            .filter((tag) => tag[0] === "skill")
            .map((tag) => tag[1]?.trim())
            .filter((skillId): skillId is string => Boolean(skillId));
        const mcpServerSlugs = event.tags
            .filter((tag) => tag[0] === "mcp")
            .map((tag) => tag[1]?.trim())
            .filter((slug): slug is string => Boolean(slug));

        return {
            agentPubkey,
            ...(await this.applyGlobalUpdate({
                agentPubkey,
                newModel,
                skillTagValues,
                mcpServerSlugs,
                event,
            })),
        };
    }

    private async applyGlobalUpdate(params: {
        agentPubkey: string;
        newModel: string | undefined;
        skillTagValues: string[];
        mcpServerSlugs: string[];
        event: NDKEvent;
    }): Promise<Omit<ApplyAgentConfigUpdateResult, "agentPubkey">> {
        const defaultUpdates: AgentDefaultConfig = {};

        const hasModelTag = params.event.tags.some((tag) => tag[0] === "model");
        if (hasModelTag && params.newModel) {
            defaultUpdates.model = params.newModel;
        }

        const hasSkillTags = params.event.tags.some((tag) => tag[0] === "skill");
        if (hasSkillTags) {
            defaultUpdates.skills = params.skillTagValues;
        }

        const hasMcpTags = params.event.tags.some((tag) => tag[0] === "mcp");
        if (hasMcpTags) {
            defaultUpdates.mcp = params.mcpServerSlugs;
        }

        const configUpdated = await agentStorage.updateDefaultConfig(
            params.agentPubkey,
            defaultUpdates
        );

        return {
            configUpdated,
            hasModel: !!params.newModel,
            skillCount: params.skillTagValues.length,
            mcpCount: params.mcpServerSlugs.length,
        };
    }
}
