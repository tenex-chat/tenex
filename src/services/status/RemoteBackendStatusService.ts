import { NDKKind } from "@/nostr/kinds";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

const STATUS_STALENESS_THRESHOLD_SECS = 45;

export interface RemoteStatusAgent {
    pubkey: string;
    slug: string;
}

export interface RemoteBackendProjectStatus {
    projectCoordinate: string;
    backendPubkey: string;
    agents: RemoteStatusAgent[];
    createdAt: number;
    lastSeenAt: number;
}

export interface RemoteAgentRuntime {
    status: "remote-online";
    backendPubkey: string;
    lastSeenAt: number;
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

function isFresh(status: RemoteBackendProjectStatus): boolean {
    return nowSeconds() - status.lastSeenAt < STATUS_STALENESS_THRESHOLD_SECS;
}

function parseStatusEvent(event: NDKEvent): RemoteBackendProjectStatus | null {
    if (event.kind !== NDKKind.TenexProjectStatus) {
        return null;
    }

    const projectCoordinate = event.tags.find((tag) => tag[0] === "a" && tag[1])?.[1];
    if (!projectCoordinate) {
        return null;
    }

    const agents: RemoteStatusAgent[] = [];
    for (const tag of event.tags) {
        if (tag[0] !== "agent" || !tag[1] || !tag[2]) {
            continue;
        }
        agents.push({
            pubkey: tag[1],
            slug: tag[2],
        });
    }

    return {
        projectCoordinate,
        backendPubkey: event.pubkey,
        agents,
        createdAt: event.created_at ?? nowSeconds(),
        lastSeenAt: nowSeconds(),
    };
}

export class RemoteBackendStatusService {
    private static instance: RemoteBackendStatusService | null = null;

    private statusesByProject = new Map<string, Map<string, RemoteBackendProjectStatus>>();

    static getInstance(): RemoteBackendStatusService {
        if (!RemoteBackendStatusService.instance) {
            RemoteBackendStatusService.instance = new RemoteBackendStatusService();
        }
        return RemoteBackendStatusService.instance;
    }

    handleStatusEvent(event: NDKEvent, localBackendPubkey?: string): void {
        const status = parseStatusEvent(event);
        if (!status) {
            return;
        }

        if (localBackendPubkey && status.backendPubkey === localBackendPubkey) {
            return;
        }

        let projectStatuses = this.statusesByProject.get(status.projectCoordinate);
        if (!projectStatuses) {
            projectStatuses = new Map();
            this.statusesByProject.set(status.projectCoordinate, projectStatuses);
        }

        const existing = projectStatuses.get(status.backendPubkey);
        if (existing && status.createdAt < existing.createdAt) {
            return;
        }

        projectStatuses.set(status.backendPubkey, status);
        logger.debug("[RemoteBackendStatus] Updated remote project status", {
            projectCoordinate: status.projectCoordinate,
            backendPubkey: status.backendPubkey.substring(0, 8),
            agentCount: status.agents.length,
        });
    }

    getRemoteRuntimeForAgent(projectCoordinate: string, agentPubkey: string): RemoteAgentRuntime | undefined {
        const projectStatuses = this.statusesByProject.get(projectCoordinate);
        if (!projectStatuses) {
            return undefined;
        }

        let newest: RemoteAgentRuntime | undefined;
        for (const status of projectStatuses.values()) {
            if (!isFresh(status)) {
                continue;
            }

            if (!status.agents.some((agent) => agent.pubkey === agentPubkey)) {
                continue;
            }

            if (!newest || status.lastSeenAt > newest.lastSeenAt) {
                newest = {
                    status: "remote-online",
                    backendPubkey: status.backendPubkey,
                    lastSeenAt: status.lastSeenAt,
                };
            }
        }

        return newest;
    }

    clear(): void {
        this.statusesByProject.clear();
    }
}
