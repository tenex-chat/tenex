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
        getProjectAgentsSpy = spyOn(agentStorage, "getProjectAgents").mockImplementation(
            mockGetProjectAgents as never
        );
        getAllProjectDTagsSpy = spyOn(agentStorage, "getAllProjectDTags").mockImplementation(
            mockGetAllProjectDTags as never
        );
    });

    afterEach(() => {
        getProjectAgentsSpy?.mockRestore();
        getAllProjectDTagsSpy?.mockRestore();
        getDaemonSpy?.mockRestore();
        mock.restore();
    });

    it("prefers canonical repo/content project metadata", async () => {
        getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue({
            getKnownProjects: () =>
                new Map([
                    [
                        "canonical-project",
                        {
                            content: "Canonical description",
                            tagValue: (tag: string) =>
                                ({
                                    title: "Canonical Project",
                                    repo: "https://repo.example",
                                } as Record<string, string | undefined>)[tag],
                        },
                    ],
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
            getKnownProjects: () =>
                new Map([
                    [
                        "legacy-project",
                        {
                            content: "",
                            tagValue: (tag: string) =>
                                ({
                                    title: "Legacy Project",
                                    description: "Legacy description",
                                    repository: "https://legacy.example",
                                } as Record<string, string | undefined>)[tag],
                        },
                    ],
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

    describe("agent format — running project", () => {
        it("outputs agents as Record<slug, role> with PM suffix on project manager", async () => {
            const pmPubkey = "pm-pubkey-001";
            const workerPubkey = "worker-pubkey-002";

            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue({
                getKnownProjects: () => new Map(),
                getActiveRuntimes: () =>
                    new Map([
                        [
                            "31933:owner:running-project",
                            {
                                getContext: () => ({
                                    project: { tagValue: () => undefined },
                                    projectManager: { pubkey: pmPubkey },
                                    agentRegistry: {
                                        getAllAgentsMap: () =>
                                            new Map([
                                                [
                                                    pmPubkey,
                                                    {
                                                        slug: "architect",
                                                        pubkey: pmPubkey,
                                                        role: "orchestrator",
                                                    },
                                                ],
                                                [
                                                    workerPubkey,
                                                    {
                                                        slug: "claude-code",
                                                        pubkey: workerPubkey,
                                                        role: "worker",
                                                    },
                                                ],
                                            ]),
                                    },
                                }),
                            },
                        ],
                    ]),
            } as never);

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute({}, toolCallOpts("tc-running-pm"));

            expect(result.projects).toHaveLength(1);
            const { agents } = result.projects[0];
            expect(agents["architect (PM)"]).toBe("orchestrator");
            expect(agents["claude-code"]).toBe("worker");
            expect(agents["architect"]).toBeUndefined();
            expect(result.projects[0].isRunning).toBe(true);
        });

        it("does not include pubkey in agent output", async () => {
            const pubkey = "pubkey-001";

            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue({
                getKnownProjects: () => new Map(),
                getActiveRuntimes: () =>
                    new Map([
                        [
                            "some-project",
                            {
                                getContext: () => ({
                                    project: { tagValue: () => undefined },
                                    projectManager: { pubkey },
                                    agentRegistry: {
                                        getAllAgentsMap: () =>
                                            new Map([
                                                [
                                                    pubkey,
                                                    { slug: "worker-a", pubkey, role: "worker" },
                                                ],
                                            ]),
                                    },
                                }),
                            },
                        ],
                    ]),
            } as never);

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute({}, toolCallOpts("tc-no-pubkey"));

            const agentEntry = result.projects[0].agents;
            for (const [key, value] of Object.entries(agentEntry)) {
                expect(key).not.toContain(pubkey);
                expect(value).not.toContain(pubkey);
            }
        });
    });

    describe("agent format — non-running stored project", () => {
        it("outputs agents as Record<slug, role> with no PM suffix", async () => {
            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue({
                getKnownProjects: () =>
                    new Map([
                        [
                            "stored-project",
                            {
                                content: "",
                                tagValue: (tag: string) =>
                                    ({ title: "Stored Project" } as Record<
                                        string,
                                        string | undefined
                                    >)[tag],
                            },
                        ],
                    ]),
                getActiveRuntimes: () => new Map(),
            } as never);

            mockGetProjectAgents.mockResolvedValue([
                { slug: "claude-code", role: "worker", nsec: "nsec-invalid" },
                { slug: "architect", role: "planner", nsec: "nsec-invalid-2" },
            ]);

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute({}, toolCallOpts("tc-stored-agents"));

            const { agents } = result.projects[0];
            expect(agents["claude-code"]).toBe("worker");
            expect(agents["architect"]).toBe("planner");
            expect(result.projects[0].isRunning).toBe(false);
        });

        it("does not call NDKPrivateKeySigner (no pubkey resolution needed)", async () => {
            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue({
                getKnownProjects: () =>
                    new Map([
                        [
                            "offline-p",
                            { content: "", tagValue: () => undefined },
                        ],
                    ]),
                getActiveRuntimes: () => new Map(),
            } as never);

            // Agent with deliberately invalid nsec — should not cause errors
            mockGetProjectAgents.mockResolvedValue([
                { slug: "some-agent", role: "worker", nsec: "not-a-real-nsec" },
            ]);

            const toolDef = createProjectListTool(createMockContext());
            // Should not throw despite invalid nsec
            const result = await toolDef.execute({}, toolCallOpts("tc-no-signer"));
            expect(result.projects[0].agents["some-agent"]).toBe("worker");
        });
    });

    describe("agent format — offline storage-only project", () => {
        it("outputs agents as Record<slug, role> for storage-only projects", async () => {
            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue({
                getKnownProjects: () => new Map(),
                getActiveRuntimes: () => new Map(),
            } as never);

            mockGetAllProjectDTags.mockResolvedValue(["offline-project"]);
            mockGetProjectAgents.mockResolvedValue([
                { slug: "offline-agent", role: "coordinator", nsec: "irrelevant" },
            ]);

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute({}, toolCallOpts("tc-offline"));

            expect(result.projects).toHaveLength(1);
            expect(result.projects[0].id).toBe("offline-project");
            expect(result.projects[0].agents["offline-agent"]).toBe("coordinator");
        });
    });

    describe("fuzzy search", () => {
        function makeDaemonWithTwoProjects() {
            return {
                getKnownProjects: () =>
                    new Map([
                        [
                            "tenex-backend",
                            {
                                content: "Multi-agent AI coordination system",
                                tagValue: (tag: string) =>
                                    ({
                                        title: "TENEX Backend",
                                        repo: "https://github.com/org/tenex",
                                    } as Record<string, string | undefined>)[tag],
                            },
                        ],
                        [
                            "website-project",
                            {
                                content: "Marketing site for product",
                                tagValue: (tag: string) =>
                                    ({
                                        title: "Website Project",
                                        repo: "https://github.com/org/website",
                                    } as Record<string, string | undefined>)[tag],
                            },
                        ],
                    ]),
                getActiveRuntimes: () => new Map(),
            };
        }

        it("filters by id (case-insensitive)", async () => {
            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue(
                makeDaemonWithTwoProjects() as never
            );

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute({ search: "tenex" }, toolCallOpts("tc-search-id"));

            expect(result.projects).toHaveLength(1);
            expect(result.projects[0].id).toBe("tenex-backend");
        });

        it("filters by title", async () => {
            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue(
                makeDaemonWithTwoProjects() as never
            );

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute(
                { search: "Website" },
                toolCallOpts("tc-search-title")
            );

            expect(result.projects).toHaveLength(1);
            expect(result.projects[0].title).toBe("Website Project");
        });

        it("filters by description", async () => {
            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue(
                makeDaemonWithTwoProjects() as never
            );

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute(
                { search: "coordination" },
                toolCallOpts("tc-search-desc")
            );

            expect(result.projects).toHaveLength(1);
            expect(result.projects[0].id).toBe("tenex-backend");
        });

        it("filters by repository", async () => {
            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue(
                makeDaemonWithTwoProjects() as never
            );

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute(
                { search: "org/website" },
                toolCallOpts("tc-search-repo")
            );

            expect(result.projects).toHaveLength(1);
            expect(result.projects[0].id).toBe("website-project");
        });

        it("returns empty array when no projects match", async () => {
            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue(
                makeDaemonWithTwoProjects() as never
            );

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute(
                { search: "zzznomatch" },
                toolCallOpts("tc-search-nomatch")
            );

            expect(result.projects).toHaveLength(0);
            expect(result.summary.totalProjects).toBe(0);
        });

        it("is case-insensitive", async () => {
            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue(
                makeDaemonWithTwoProjects() as never
            );

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute(
                { search: "TENEX BACKEND" },
                toolCallOpts("tc-search-case")
            );

            expect(result.projects).toHaveLength(1);
            expect(result.projects[0].id).toBe("tenex-backend");
        });

        it("returns all projects when search is undefined", async () => {
            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue(
                makeDaemonWithTwoProjects() as never
            );

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute({}, toolCallOpts("tc-search-undef"));

            expect(result.projects).toHaveLength(2);
        });

        it("returns all projects when search is empty string", async () => {
            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue(
                makeDaemonWithTwoProjects() as never
            );

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute({ search: "" }, toolCallOpts("tc-search-empty"));

            expect(result.projects).toHaveLength(2);
        });

        it("returns all projects when search is whitespace only", async () => {
            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue(
                makeDaemonWithTwoProjects() as never
            );

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute(
                { search: "   " },
                toolCallOpts("tc-search-whitespace")
            );

            expect(result.projects).toHaveLength(2);
        });
    });

    describe("filtered summary counts", () => {
        it("summary reflects filtered results, not all collected projects", async () => {
            const pmPubkey = "pm-pub";

            getDaemonSpy = spyOn(daemonModule, "getDaemon").mockReturnValue({
                getKnownProjects: () =>
                    new Map([
                        [
                            "other-project",
                            {
                                content: "Unrelated project",
                                tagValue: (tag: string) =>
                                    ({ title: "Other Project" } as Record<
                                        string,
                                        string | undefined
                                    >)[tag],
                            },
                        ],
                    ]),
                getActiveRuntimes: () =>
                    new Map([
                        [
                            "31933:owner:tenex-project",
                            {
                                getContext: () => ({
                                    project: { tagValue: () => undefined },
                                    projectManager: { pubkey: pmPubkey },
                                    agentRegistry: {
                                        getAllAgentsMap: () =>
                                            new Map([
                                                [
                                                    pmPubkey,
                                                    {
                                                        slug: "pm-agent",
                                                        pubkey: pmPubkey,
                                                        role: "orchestrator",
                                                    },
                                                ],
                                                [
                                                    "worker-pub",
                                                    {
                                                        slug: "worker-agent",
                                                        pubkey: "worker-pub",
                                                        role: "worker",
                                                    },
                                                ],
                                            ]),
                                    },
                                }),
                            },
                        ],
                    ]),
            } as never);

            const toolDef = createProjectListTool(createMockContext());
            const result = await toolDef.execute(
                { search: "tenex" },
                toolCallOpts("tc-summary-filtered")
            );

            // Only the running tenex-project matches; other-project does not
            expect(result.summary.totalProjects).toBe(1);
            expect(result.summary.runningProjects).toBe(1);
            expect(result.summary.totalAgents).toBe(2);
        });
    });
});
