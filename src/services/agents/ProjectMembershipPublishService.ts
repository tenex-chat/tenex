import { type NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk";
import { agentStorage } from "@/agents/AgentStorage";
import { collectEvents } from "@/nostr/collectEvents";
import { NDKKind } from "@/nostr/kinds";
import { getNDK, initNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import {
    isDeletedProjectEvent,
    projectEventPublishService,
    type ProjectEventPublishOutcome,
} from "@/services/projects/ProjectEventPublishService";
import { logger } from "@/utils/logger";

type ProjectMembershipSyncResult = {
    projectDTag: string;
    outcome: Extract<
        ProjectEventPublishOutcome,
        "published" | "project_not_found" | "signing_failed" | "publish_failed" | "signing_disabled" | "no_changes"
    >;
};

export type ProjectVisibilityStatus = "active" | "deleted" | "unknown";

function getProjectDTag(event: Pick<NDKEvent, "tags">): string | null {
    return event.tags.find((tag) => tag[0] === "d")?.[1] ?? null;
}

function selectLatestProjectEvent(events: NDKEvent[]): NDKEvent | null {
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
        const projectEvent = await projectEventPublishService.fetchLatestProjectEvent({
            projectDTag,
            includeDeleted: true,
        });
        if (!projectEvent) {
            return "unknown";
        }

        return isDeletedProjectEvent(projectEvent) ? "deleted" : "active";
    }

    async syncProjectMembership(projectDTag: string): Promise<ProjectMembershipSyncResult> {
        await initNDK();
        await agentStorage.initialize();

        const projectEvent = await projectEventPublishService.fetchLatestProjectEvent({
            projectDTag,
            includeDeleted: true,
        });
        if (!projectEvent || isDeletedProjectEvent(projectEvent)) {
            logger.warn("[ProjectMembershipPublishService] Could not find project event for membership sync", {
                projectDTag,
            });
            return { projectDTag, outcome: "project_not_found" };
        }

        const assignedPubkeys = await agentStorage.getProjectAgentPubkeys(projectDTag);
        const result = await projectEventPublishService.publishMutation({
            ownerPubkey: projectEvent.pubkey,
            projectDTag,
            trigger: "agent_manager_31933",
            retainAgentPubkeys: assignedPubkeys,
        });

        return {
            projectDTag,
            outcome: result.outcome,
        };
    }

    async syncManyProjectMemberships(projectDTags: string[]): Promise<ProjectMembershipSyncResult[]> {
        const uniqueProjectIds = Array.from(new Set(projectDTags.filter(Boolean)));
        const results: ProjectMembershipSyncResult[] = [];

        for (const projectDTag of uniqueProjectIds) {
            results.push(await this.syncProjectMembership(projectDTag));
        }

        return results;
    }

    private async fetchLatestProjectEvents(): Promise<NDKEvent[]> {
        const events = await this.fetchProjectEventsByFilter(
            this.buildProjectFilter({}),
        );
        const latestByDTag = new Map<string, NDKEvent>();

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
            ? { kinds: [NDKKind.Project as number], authors: whitelistedPubkeys }
            : { kinds: [NDKKind.Project as number] };

        return {
            ...baseFilter,
            ...extraFilter,
        };
    }

    private async fetchProjectEventsByFilter(filter: NDKFilter): Promise<NDKEvent[]> {
        const ndk = getNDK();
        return collectEvents(ndk, filter, {
            timeoutMs: 10_000,
            subOpts: { groupable: false },
        });
    }
}

export const projectMembershipPublishService = new ProjectMembershipPublishService();
export { isDeletedProjectEvent };
