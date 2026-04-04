import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { agentStorage } from "@/agents/AgentStorage";
import * as daemonModule from "@/daemon";
import type { ToolExecutionContext } from "@/tools/types";
import { createProjectListTool } from "../project_list";

const mockGetProjectAgents = mock();
const mockGetAllProjectDTags = mock();

function createMockContext(): ToolExecutionContext {
    return {
        agent: {
            name: "tester",
            slug: "tester",
            pubkey: "a".repeat(64),
            llmConfig: "claude",
            tools: [],
        } as never,
        conversationId: "conversation-1",
        projectBasePath: "/tmp/project",
        workingDirectory: "/tmp/project",
        currentBranch: "main",
        triggeringEnvelope: { transport: "nostr" } as never,
        getConversation: () => undefined,
        agentPublisher: {} as never,
        ralNumber: 1,
        projectContext: {} as never,
    };
}

const toolCallOpts = (id: string) => ({
    toolCallId: id,
    messages: [],
    abortSignal: undefined as never,
});

describe("project_list tool", () => {
    let getProjectAgentsSpy: ReturnType<typeof spyOn>;
    let getAllProjectDTagsSpy: ReturnType<typeof spyOn>;
    let getDaemonSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        mockGetProjectAgents.mockReset();
        mockGetAllProjectDTags.mockReset();
        mockGetProjectAgents.mockResolvedValue([]);
        mockGetAllProjectDTags.mockResolvedValue([]);
        getProjectAgentsSpy = spyOn(agentStorage, "getProjectAgents")
            .mockImplementation(mockGetProjectAgents as never);
        getAllProjectDTagsSpy = spyOn(agentStorage, "getAllProjectDTags")
            .mockImplementation(mockGetAllProjectDTags as never);
    });

    afterEach(() => {
        getProjectAgentsSpy?.mockRestore();
        getAllProjectDTagsSpy?.mockRestore();
        getDaemonSpy?.mockRestore();
        mock.restore();
    });

    it("prefers canonical repo/content project metadata", async () => {
        getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue({
            getKnownProjects: () => new Map([
                ["canonical-project", {
                    content: "Canonical description",
                    tagValue: (tag: string) => ({
                        title: "Canonical Project",
                        repo: "https://repo.example",
                    } as Record<string, string | undefined>)[tag],
                }],
            ]),
            getActiveRuntimes: () => new Map(),
        } as never);

        const toolDef = createProjectListTool(createMockContext());
        const result = await toolDef.execute({}, toolCallOpts("tc-project-list-canonical"));

        expect(result.projects).toHaveLength(1);
        expect(result.projects[0]).toMatchObject({
            id: "canonical-project",
            title: "Canonical Project",
            description: "Canonical description",
            repository: "https://repo.example",
            isRunning: false,
        });
    });

    it("falls back to legacy description and repository tags when canonical fields are absent", async () => {
        getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue({
            getKnownProjects: () => new Map([
                ["legacy-project", {
                    content: "",
                    tagValue: (tag: string) => ({
                        title: "Legacy Project",
                        description: "Legacy description",
                        repository: "https://legacy.example",
                    } as Record<string, string | undefined>)[tag],
                }],
            ]),
            getActiveRuntimes: () => new Map(),
        } as never);

        const toolDef = createProjectListTool(createMockContext());
        const result = await toolDef.execute({}, toolCallOpts("tc-project-list-legacy"));

        expect(result.projects).toHaveLength(1);
        expect(result.projects[0]).toMatchObject({
            id: "legacy-project",
            title: "Legacy Project",
            description: "Legacy description",
            repository: "https://legacy.example",
            isRunning: false,
        });
    });
});
