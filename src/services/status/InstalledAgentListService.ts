const STATUS_INTERVAL_MS = 30_000;

import { agentStorage, deriveAgentPubkeyFromNsec } from "@/agents/AgentStorage";
import { NDKKind } from "@/nostr/kinds";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";

export class InstalledAgentListService {
    private interval?: NodeJS.Timeout;

    async startPublishing(): Promise<void> {
        await this.publishImmediately();

        this.interval = setInterval(() => {
            void this.publishImmediately().catch((error) => {
                logger.warn("[InstalledAgentListService] Failed to publish installed agent inventory", {
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }, STATUS_INTERVAL_MS);
        this.interval.unref();
    }

    stopPublishing(): void {
        if (!this.interval) return;
        clearInterval(this.interval);
        this.interval = undefined;
    }

    async publishImmediately(): Promise<void> {
        await agentStorage.initialize();
        await initNDK();

        const event = await this.createInventoryEvent();
        const backendSigner = await config.getBackendSigner();
        await event.sign(backendSigner, { pTags: false });
        await event.publish();
    }

    private async createInventoryEvent(): Promise<NDKEvent> {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.TenexInstalledAgentList;
        event.content = "";

        for (const pubkey of config.getWhitelistedPubkeys()) {
            event.tag(["p", pubkey]);
        }

        const storedAgents = await agentStorage.getAllStoredAgents();
        storedAgents
            .map((agent) => ({
                pubkey: deriveAgentPubkeyFromNsec(agent.nsec),
                slug: agent.slug,
            }))
            .sort((left, right) => {
                const bySlug = left.slug.localeCompare(right.slug);
                return bySlug !== 0 ? bySlug : left.pubkey.localeCompare(right.pubkey);
            })
            .forEach((agent) => {
                event.tag(["agent", agent.pubkey, agent.slug]);
            });

        return event;
    }
}
