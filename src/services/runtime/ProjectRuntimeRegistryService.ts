import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { ProjectContext } from "@/services/projects/ProjectContext";
import { projectContextStore } from "@/services/projects/ProjectContextStore";
import type { ProjectDTag } from "@/types/project-ids";

export interface ProjectRuntimeRegistration {
    projectId: ProjectDTag | string;
    projectContext: ProjectContext;
    agentExecutor: AgentExecutor;
}

class ProjectRuntimeRegistryService {
    private registrations = new Map<string, ProjectRuntimeRegistration>();

    register(registration: ProjectRuntimeRegistration): void {
        this.registrations.set(registration.projectId, registration);
    }

    unregister(projectId: ProjectDTag | string): void {
        this.registrations.delete(projectId);
    }

    get(projectId: ProjectDTag | string | null | undefined): ProjectRuntimeRegistration | undefined {
        return projectId ? this.registrations.get(projectId) : undefined;
    }

    async runInProjectContext<T>(
        registration: ProjectRuntimeRegistration,
        operation: () => Promise<T>
    ): Promise<T> {
        return await projectContextStore.run(registration.projectContext, operation);
    }
}

export const projectRuntimeRegistry = new ProjectRuntimeRegistryService();
