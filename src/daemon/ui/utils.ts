import type { ProjectRuntime } from "../ProjectRuntime";
import type { ProjectInfo, ConversationInfo } from "./types";

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

export function extractProjectInfo(runtimes: Map<string, ProjectRuntime>): ProjectInfo[] {
  const projectList: ProjectInfo[] = [];

  for (const [projectId, runtime] of runtimes) {
    const status = runtime.getStatus();
    projectList.push({
      projectId,
      title: status.title,
      isRunning: status.isRunning,
      startTime: status.startTime,
      eventCount: status.eventCount,
      agentCount: status.agentCount,
    });
  }

  return projectList;
}

export function extractCachedConversations(runtimes: Map<string, ProjectRuntime>): ConversationInfo[] {
  const conversations: ConversationInfo[] = [];

  for (const [projectId, runtime] of runtimes) {
    const context = runtime.getContext();
    if (!context?.conversationCoordinator) continue;

    const cachedConversations = context.conversationCoordinator.getAllConversations();

    for (const conv of cachedConversations) {
      const lastEvent = conv.history[conv.history.length - 1];
      conversations.push({
        id: conv.id,
        title: conv.title || conv.metadata.summary || "Untitled Conversation",
        summary: conv.metadata.summary,
        lastActivity: lastEvent?.created_at || 0,
        projectId,
      });
    }
  }

  // Sort by last activity (most recent first)
  return conversations.sort((a, b) => b.lastActivity - a.lastActivity);
}
