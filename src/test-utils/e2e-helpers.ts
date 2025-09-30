import type { AgentInstance } from "@/agents/types";
import type {
    ProjectTagAccessor,
    SignerPrivateKeyAccessor,
    ProjectOwnershipChecker,
    ProjectManagerAccessor,
    PhaseSpecialistChecker,
    PhaseSpecialistAccessor,
    AgentIdentifierResolver
} from "./e2e-types";

export function createProjectTagAccessor(projectTitle: string): ProjectTagAccessor {
    return (tag: string): string | null => {
        return tag === "title" ? projectTitle : null;
    };
}

export function createSignerPrivateKeyAccessor(privateKey: string): SignerPrivateKeyAccessor {
    return (): string => privateKey;
}

export function createProjectOwnershipChecker(isOwner: boolean): ProjectOwnershipChecker {
    return (): boolean => isOwner;
}

export function createProjectManagerAccessor(pmAgent: AgentInstance): ProjectManagerAccessor {
    return (): AgentInstance => pmAgent;
}

export function createPhaseSpecialistChecker(): PhaseSpecialistChecker {
    return (_phase: string): boolean => false;
}

export function createPhaseSpecialistAccessor(): PhaseSpecialistAccessor {
    return (_phase: string): AgentInstance | null => null;
}

export function createAgentIdentifierResolver(agentsMap: Map<string, AgentInstance>): AgentIdentifierResolver {
    return (identifier: string): AgentInstance | null => {
        return agentsMap.get(identifier) || null;
    };
}