import { NDKEvent as NDKEventClass, type NDKFilter } from "@nostr-dev-kit/ndk";
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

export type ProjectVisibilityStatus = "active" | "deleted" | "unknown";

function getProjectDTag(event: NDKEventClass): string | null {
    return event.tags.find((tag) => tag[0] === "d")?.[1] ?? null;
}

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

export function isDeletedProjectEvent(event: NDKEventClass): boolean {
    return event.tags.some((tag) => tag[0] === "deleted");
}

export class ProjectMembershipPublishService {
    async listAssignableProjectDTags(): Promise<string[]> {
        await initNDK();
        await agentStorage.initialize();

        const latestProjectEvents = await this.fetchLatestProjectEvents();
        const assignableProjectIds = new Set<string>();

        for (const projectEvent of latestProjectEvents) {
            const dTag = getProjectDTag(projectEvent);
            if (!dTag || isDeletedProjectEvent(projectEvent)) {
                continue;
            }

            assignableProjectIds.add(dTag);
        }

        const storedProjectIds = await agentStorage.getAllProjectDTags();
        for (const projectId of storedProjectIds) {
            if (assignableProjectIds.has(projectId)) {
                continue;
            }

            const visibility = await this.getProjectVisibility(projectId);
            if (visibility !== "deleted") {
                assignableProjectIds.add(projectId);
            }
        }

        return [...assignableProjectIds].sort((a, b) => a.localeCompare(b));
    }

    async getProjectVisibility(projectDTag: string): Promise<ProjectVisibilityStatus> {
        await initNDK();

        const projectEvent = await this.fetchProjectEvent(projectDTag);
        if (!projectEvent) {
            return "unknown";
        }

        return isDeletedProjectEvent(projectEvent) ? "deleted" : "active";
    }

    async syncProjectMembership(projectDTag: string): Promise<ProjectMembershipSyncResult> {
        await initNDK();
        await agentStorage.initialize();

        const projectEvent = await this.fetchProjectEvent(projectDTag);
        if (!projectEvent || isDeletedProjectEvent(projectEvent)) {
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
        const events = await this.fetchProjectEventsByFilter(
            this.buildProjectFilter({ "#d": [projectDTag] }),
        );

        return selectLatestProjectEvent(events);
    }

    private async fetchLatestProjectEvents(): Promise<NDKEventClass[]> {
        const events = await this.fetchProjectEventsByFilter(
            this.buildProjectFilter({}),
        );
        const latestByDTag = new Map<string, NDKEventClass>();

        for (const event of events) {
            const dTag = getProjectDTag(event);
            if (!dTag) {
                continue;
            }

            const current = latestByDTag.get(dTag);
            if (!current) {
                latestByDTag.set(dTag, event);
                continue;
            }

            const preferred = selectLatestProjectEvent([current, event]);
            if (preferred) {
                latestByDTag.set(dTag, preferred);
            }
        }

        return [...latestByDTag.values()];
    }

    private buildProjectFilter(extraFilter: Partial<NDKFilter>): NDKFilter {
        const whitelistedPubkeys = config.getWhitelistedPubkeys();
        const baseFilter: NDKFilter = whitelistedPubkeys.length > 0
            ? { kinds: [31933], authors: whitelistedPubkeys }
            : { kinds: [31933] };

        return {
            ...baseFilter,
            ...extraFilter,
        };
    }

    private async fetchProjectEventsByFilter(filter: NDKFilter): Promise<NDKEventClass[]> {
        const ndk = getNDK();
        const events = await collectEvents(ndk, filter, {
            timeoutMs: 10_000,
            subOpts: { groupable: false },
        });

        return events as NDKEventClass[];
    }
}

export const projectMembershipPublishService = new ProjectMembershipPublishService();
