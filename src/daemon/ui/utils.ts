import type { NDKProject } from "@nostr-dev-kit/ndk";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { ProjectRuntime } from "../ProjectRuntime";
import type { ConversationInfo, ProjectInfo } from "./types";

export function areProjectListsEqual(a: ProjectInfo[], b: ProjectInfo[]): boolean {
    if (a.length !== b.length) return false;

    for (let i = 0; i < a.length; i++) {
        const projA = a[i];
        const projB = b[i];
        if (
            projA.projectId !== projB.projectId ||
            projA.title !== projB.title ||
            projA.isRunning !== projB.isRunning ||
            projA.eventCount !== projB.eventCount ||
            projA.agentCount !== projB.agentCount ||
            projA.startTime?.getTime() !== projB.startTime?.getTime()
        ) {
            return false;
        }
    }

    return true;
}

export function extractProjectInfo(
    knownProjects: Map<string, NDKProject>,
    activeRuntimes: Map<string, ProjectRuntime>
): ProjectInfo[] {
    const projectList: ProjectInfo[] = [];

    for (const [projectId, project] of knownProjects) {
        const runtime = activeRuntimes.get(projectId);

        if (runtime) {
            // Project is running - get status from runtime
            const status = runtime.getStatus();
            projectList.push({
                projectId,
                title: status.title,
                isRunning: status.isRunning,
                startTime: status.startTime,
                eventCount: status.eventCount,
                agentCount: status.agentCount,
            });
        } else {
            // Project is offline - use project data directly
            const title = project.tagValue("title") || "Untitled Project";
            const agentTags = project.tags.filter((t) => t[0] === "agent");

            projectList.push({
                projectId,
                title,
                isRunning: false,
                startTime: null,
                eventCount: 0,
                agentCount: agentTags.length,
            });
        }
    }

    return projectList;
}

export function extractCachedConversations(
    runtimes: Map<string, ProjectRuntime>
): ConversationInfo[] {
    const conversations: ConversationInfo[] = [];

    // Get all cached conversations from ConversationStore
    const cachedConversations = ConversationStore.getAll();

    for (const conv of cachedConversations) {
        // Find which project this conversation belongs to
        let projectId = "unknown";
        for (const [pid, runtime] of runtimes) {
            if (runtime.isActive()) {
                projectId = pid;
                break;
            }
        }

        conversations.push({
            id: conv.id,
            title: conv.getTitle() || conv.getMetadata().summary || "Untitled Conversation",
            summary: conv.getMetadata().summary,
            lastActivity: conv.getLastActivityTime(),
            projectId,
        });
    }

    // Sort by last activity (most recent first)
    return conversations.sort((a, b) => b.lastActivity - a.lastActivity);
}
