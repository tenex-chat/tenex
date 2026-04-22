import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "./kinds";
import { getNDK } from "./ndkClient";
import { enqueueSignedEventForRustPublish } from "./RustPublishOutbox";

export interface ProjectScopedAgentConfigUpdate {
    projectBinding: string;
    agentPubkey: string;
    model: string;
    tools: string[];
    clientTag?: string;
}

export class AgentConfigPublisher {
    async publishProjectScopedUpdate(params: ProjectScopedAgentConfigUpdate): Promise<NDKEvent> {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.TenexAgentConfigUpdate;
        event.content = "";
        event.tags = [
            ["a", params.projectBinding],
            ["client", params.clientTag ?? "tenex-telegram"],
            ["p", params.agentPubkey],
            ["model", params.model],
            ...params.tools.map((toolName) => ["tool", toolName]),
        ];

        const backendSigner = await config.getBackendSigner();
        await event.sign(backendSigner, { pTags: false });
        await enqueueSignedEventForRustPublish(event, {
            correlationId: "agent_config_update",
            projectId: params.projectBinding,
            conversationId: params.projectBinding,
            requestId: `agent-config:${params.projectBinding}:${params.agentPubkey}:${event.id}`,
        });

        logger.info("[AgentConfigPublisher] Enqueued project-scoped agent config update for Rust publish", {
            eventId: event.id,
            projectBinding: params.projectBinding,
            agentPubkey: params.agentPubkey,
            model: params.model,
            toolCount: params.tools.length,
            clientTag: params.clientTag ?? "tenex-telegram",
        });

        return event;
    }
}
