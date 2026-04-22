import { agentStorage, deriveAgentPubkeyFromNsec } from "@/agents/AgentStorage";
import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { NDKEvent } from "@nostr-dev-kit/ndk";

export class InstalledAgentListService {
    async publishImmediately(): Promise<void> {
        await agentStorage.initialize();

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
