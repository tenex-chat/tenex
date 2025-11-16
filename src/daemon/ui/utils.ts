import type { ProjectRuntime } from "../ProjectRuntime";
import type { ProjectInfo } from "./types";

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
