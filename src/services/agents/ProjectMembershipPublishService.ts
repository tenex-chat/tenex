import { NDKEvent as NDKEventClass } from "@nostr-dev-kit/ndk";
import { agentStorage } from "@/agents/AgentStorage";
import { collectEvents } from "@/nostr/collectEvents";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { Nip46SigningLog, Nip46SigningService } from "@/services/nip46";
import { shortenOptionalEventId, shortenPubkey } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";

type ProjectMembershipSyncResult = {
    projectDTag: string;
    outcome: "published" | "project_not_found" | "signing_failed" | "publish_failed" | "signing_disabled";
};

function selectLatestProjectEvent(events: NDKEventClass[]): NDKEventClass | null {
    if (events.length === 0) {
        return null;
    }

    return [...events].sort((a, b) => {
        const createdDelta = (b.created_at || 0) - (a.created_at || 0);
        if (createdDelta !== 0) {
            return createdDelta;
        }
        return (b.id || "").localeCompare(a.id || "");
    })[0] ?? null;
}

export class ProjectMembershipPublishService {
    async syncProjectMembership(projectDTag: string): Promise<ProjectMembershipSyncResult> {
        await initNDK();
        await agentStorage.initialize();

        const projectEvent = await this.fetchProjectEvent(projectDTag);
        if (!projectEvent) {
            logger.warn("[ProjectMembershipPublishService] Could not find project event for membership sync", {
                projectDTag,
            });
            return { projectDTag, outcome: "project_not_found" };
        }

        const assignedPubkeys = await agentStorage.getProjectAgentPubkeys(projectDTag);
        const updatedTags = projectEvent.tags.filter((tag) => {
            if (tag[0] === "p") {
                return Boolean(tag[1] && assignedPubkeys.includes(tag[1]));
            }
            return true;
        });

        const ndk = getNDK();
        const updatedEvent = new NDKEventClass(ndk, {
            kind: 31933,
            content: projectEvent.content,
            tags: updatedTags,
        });

        const ownerPubkey = projectEvent.pubkey;
        const nip46Service = Nip46SigningService.getInstance();

        if (!nip46Service.isEnabled()) {
            logger.warn("[ProjectMembershipPublishService] NIP-46 not enabled — 31933 update skipped", {
                projectDTag,
                note: "Stale 31933 on relays may re-introduce removed agents on daemon restart",
            });
            return { projectDTag, outcome: "signing_disabled" };
        }

        const signingLog = Nip46SigningLog.getInstance();
        const result = await nip46Service.signEvent(ownerPubkey, updatedEvent, "agent_manager_31933");

        if (result.outcome !== "signed") {
            logger.warn("[ProjectMembershipPublishService] Skipping 31933 publish — signing failed", {
                ownerPubkey: shortenPubkey(ownerPubkey),
                projectDTag,
                outcome: result.outcome,
                reason: "reason" in result ? result.reason : undefined,
            });
            return { projectDTag, outcome: "signing_failed" };
        }

        try {
            await updatedEvent.publish();
            signingLog.log({
                op: "event_published",
                ownerPubkey: Nip46SigningLog.truncatePubkey(ownerPubkey),
                eventKind: 31933,
                signerType: "nip46",
                eventId: updatedEvent.id,
            });
            logger.info("[ProjectMembershipPublishService] Published owner-signed 31933 update", {
                ownerPubkey: shortenPubkey(ownerPubkey),
                projectDTag,
                eventId: shortenOptionalEventId(updatedEvent.id),
                agentTagCount: updatedTags.filter((tag) => tag[0] === "p").length,
            });
            return { projectDTag, outcome: "published" };
        } catch (error) {
            logger.warn("[ProjectMembershipPublishService] Failed to publish 31933 update", {
                ownerPubkey: shortenPubkey(ownerPubkey),
                projectDTag,
                error: error instanceof Error ? error.message : String(error),
            });
            return { projectDTag, outcome: "publish_failed" };
        }
    }

    async syncManyProjectMemberships(projectDTags: string[]): Promise<ProjectMembershipSyncResult[]> {
        const uniqueProjectIds = Array.from(new Set(projectDTags.filter(Boolean)));
        const results: ProjectMembershipSyncResult[] = [];

        for (const projectDTag of uniqueProjectIds) {
            results.push(await this.syncProjectMembership(projectDTag));
        }

        return results;
    }

    private async fetchProjectEvent(projectDTag: string): Promise<NDKEventClass | null> {
        const ndk = getNDK();
        const whitelistedPubkeys = config.getWhitelistedPubkeys();
        const filter = whitelistedPubkeys.length > 0
            ? { kinds: [31933], "#d": [projectDTag], authors: whitelistedPubkeys }
            : { kinds: [31933], "#d": [projectDTag] };

        const events = await collectEvents(ndk, filter, {
            timeoutMs: 10_000,
            subOpts: { groupable: false },
        });

        return selectLatestProjectEvent(events as NDKEventClass[]);
    }
}

export const projectMembershipPublishService = new ProjectMembershipPublishService();
