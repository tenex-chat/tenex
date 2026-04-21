import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import routingFixture from "@/test-utils/fixtures/daemon/routing-decisions.compat.json";
import { createProjectDTag, type ProjectDTag } from "@/types/project-ids";
import { logger } from "@/utils/logger";
import type { ProjectRuntime } from "../../ProjectRuntime";
import { determineTargetProject } from "../DaemonRouter";

type RoutingProjectFixture = (typeof routingFixture.projects)[number];

function buildKnownProjects(): Map<ProjectDTag, NDKProject> {
    return new Map(
        routingFixture.projects.map((project) => [
            createProjectDTag(project.dTag),
            {
                tagValue: (name: string) => (name === "title" ? project.title : undefined),
            } as unknown as NDKProject,
        ])
    );
}

function buildAgentProjectIndex(): Map<string, Set<ProjectDTag>> {
    const index = new Map<string, Set<ProjectDTag>>();

    for (const project of routingFixture.projects) {
        const projectId = createProjectDTag(project.dTag);
        for (const agent of project.agents) {
            const projectIds = index.get(agent.pubkey) ?? new Set<ProjectDTag>();
            projectIds.add(projectId);
            index.set(agent.pubkey, projectIds);
        }
    }

    return index;
}

function buildRuntime(project: RoutingProjectFixture): ProjectRuntime {
    return {
        getContext: () => ({
            agentRegistry: {
                getAllAgents: () => project.agents,
            },
        }),
    } as unknown as ProjectRuntime;
}

function buildActiveRuntimes(projectIds: string[]): Map<ProjectDTag, ProjectRuntime> {
    const activeRuntimes = new Map<ProjectDTag, ProjectRuntime>();

    for (const projectId of projectIds) {
        const project = routingFixture.projects.find((candidate) => candidate.dTag === projectId);
        if (!project) {
            throw new Error(`Unknown fixture project: ${projectId}`);
        }
        activeRuntimes.set(createProjectDTag(project.dTag), buildRuntime(project));
    }

    return activeRuntimes;
}

describe("DaemonRouter compatibility fixtures", () => {
    beforeEach(() => {
        spyOn(logger, "debug").mockImplementation(() => {});
        spyOn(logger, "info").mockImplementation(() => {});
        spyOn(logger, "warn").mockImplementation(() => {});
        spyOn(logger, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        mock.restore();
    });

    it("matches canonical daemon routing decisions", () => {
        const knownProjects = buildKnownProjects();
        const agentProjectIndex = buildAgentProjectIndex();

        for (const testCase of routingFixture.cases) {
            const result = determineTargetProject(
                testCase.event as NDKEvent,
                knownProjects,
                agentProjectIndex as any,
                buildActiveRuntimes(testCase.activeProjectIds)
            );

            expect({ name: testCase.name, result }).toEqual({
                name: testCase.name,
                result: testCase.expected,
            });
        }
    });
});
