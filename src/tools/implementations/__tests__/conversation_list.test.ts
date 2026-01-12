import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AgentInstance } from "@/agents/types";

// Mock dependencies - must be before imports
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(),
        warn: mock(),
        error: mock(),
        debug: mock(),
    },
}));

import { ConversationStore } from "@/conversations/ConversationStore";
import { logger } from "@/utils/logger";
import { createConversationListTool } from "../conversation_list";

type StoreOverrides = {
    messages?: Array<{ timestamp: number }>;
    metadata?: Record<string, unknown>;
    lastActivityTime?: number;
};

// Track instantiated stores for the "new ConversationStore" path
const instantiatedStores: Array<{ basePath: string; loadedWith?: { projectId: string; conversationId: string } }> = [];
const inMemoryStores = new Map<string, ConversationStore>();
let mockProjectId: string | null = "current-project";
let mockBasePath = "/mock/base/path";
let mockStoreOverrides: Record<string, StoreOverrides> = {};

const mockGetProjectId = mock(() => mockProjectId);
const mockGetBasePath = mock(() => mockBasePath);
const mockListProjectIdsFromDisk = mock(() => [mockProjectId ?? "current-project"]);
const mockListConversationIdsFromDisk = mock(() => ["conv1"]);
const mockListConversationIdsFromDiskForProject = mock((projectId: string) => {
    if (projectId === "current-project") return ["conv1"];
    if (projectId === "other-project") return ["conv2"];
    return [];
});

const buildMessages = (overrides: StoreOverrides) => {
    if (overrides.messages && overrides.messages.length > 0) return overrides.messages;
    if (typeof overrides.lastActivityTime === "number") {
        return [{ timestamp: overrides.lastActivityTime }];
    }
    return [
        { timestamp: 1700000000 },
        { timestamp: 1700001000 },
    ];
};

const buildMetadata = (conversationId: string, overrides: StoreOverrides) => {
    const defaults = {
        title: `Conversation ${conversationId}`,
        summary: `Summary for ${conversationId}`,
        phase: "execution",
        statusLabel: "active",
        statusCurrentActivity: "Working",
    };

    return { ...defaults, ...(overrides.metadata ?? {}) };
};

const applyStateToStore = (
    store: ConversationStore,
    conversationId: string,
    projectId: string,
    overrides: StoreOverrides
) => {
    const messages = buildMessages(overrides);
    const metadata = buildMetadata(conversationId, overrides);

    const state = {
        activeRal: {},
        nextRalNumber: {},
        injections: [],
        messages: messages.map((message, index) => ({
            pubkey: "user-pubkey",
            content: "",
            messageType: "text",
            timestamp: message.timestamp,
            eventId: `event-${projectId}-${conversationId}-${index}`,
        })),
        metadata,
        agentTodos: {},
        todoNudgedAgents: [],
        todoRemindedAgents: [],
        blockedAgents: [],
        executionTime: {
            totalSeconds: 0,
            isActive: false,
            lastUpdated: Date.now(),
        },
    };

    const storeData = store as unknown as {
        state?: typeof state;
        conversationId?: string;
        eventIdSet?: Set<string>;
        blockedAgentsSet?: Set<string>;
    };

    storeData.state = state;
    storeData.conversationId = conversationId;
    storeData.eventIdSet = new Set();
    storeData.blockedAgentsSet = new Set();
};

const createMockConversationStore = (
    id: string,
    overrides: StoreOverrides = {},
    projectId = mockProjectId ?? "current-project"
) => {
    const store = new ConversationStore(mockBasePath);
    applyStateToStore(store, id, projectId, overrides);
    return store;
};

const getOrCreateStore = (conversationId: string, projectId = mockProjectId ?? "current-project") => {
    const existing = inMemoryStores.get(conversationId);
    if (existing) return existing;
    const store = createMockConversationStore(
        conversationId,
        mockStoreOverrides[`${projectId}:${conversationId}`] ?? {},
        projectId
    );
    inMemoryStores.set(conversationId, store);
    return store;
};

const loadImplementation = function (this: ConversationStore, projectId: string, conversationId: string) {
    applyStateToStore(
        this,
        conversationId,
        projectId,
        mockStoreOverrides[`${projectId}:${conversationId}`] ?? {}
    );

    const basePath = (this as unknown as { basePath?: string }).basePath ?? mockBasePath;
    instantiatedStores.push({ basePath, loadedWith: { projectId, conversationId } });
};

const mockGetOrLoad = mock((conversationId: string) => getOrCreateStore(conversationId));
const mockLoad = mock(loadImplementation);

const originalGetProjectId = ConversationStore.getProjectId;
const originalGetBasePath = ConversationStore.getBasePath;
const originalListProjectIdsFromDisk = ConversationStore.listProjectIdsFromDisk;
const originalListConversationIdsFromDisk = ConversationStore.listConversationIdsFromDisk;
const originalListConversationIdsFromDiskForProject = ConversationStore.listConversationIdsFromDiskForProject;
const originalGetOrLoad = ConversationStore.getOrLoad;
const originalLoad = ConversationStore.prototype.load;

afterAll(() => {
    ConversationStore.getProjectId = originalGetProjectId;
    ConversationStore.getBasePath = originalGetBasePath;
    ConversationStore.listProjectIdsFromDisk = originalListProjectIdsFromDisk;
    ConversationStore.listConversationIdsFromDisk = originalListConversationIdsFromDisk;
    ConversationStore.listConversationIdsFromDiskForProject = originalListConversationIdsFromDiskForProject;
    ConversationStore.getOrLoad = originalGetOrLoad;
    ConversationStore.prototype.load = originalLoad;
});

describe("conversation_list Tool", () => {
    let mockContext: ExecutionContext;
    let mockAgent: AgentInstance;

    beforeEach(() => {
        // Reset all mocks
        (logger.info as ReturnType<typeof mock>).mockReset();
        (logger.warn as ReturnType<typeof mock>).mockReset();
        (logger.error as ReturnType<typeof mock>).mockReset();
        (logger.debug as ReturnType<typeof mock>).mockReset();
        inMemoryStores.clear();

        // Clear tracked instantiated stores
        instantiatedStores.length = 0;

        // Reset store overrides
        mockStoreOverrides = {};

        mockProjectId = "current-project";
        mockBasePath = "/mock/base/path";

        mockGetProjectId.mockReset();
        mockGetProjectId.mockImplementation(() => mockProjectId);
        mockGetBasePath.mockReset();
        mockGetBasePath.mockImplementation(() => mockBasePath);
        mockListProjectIdsFromDisk.mockReset();
        mockListProjectIdsFromDisk.mockImplementation(() => [mockProjectId ?? "current-project"]);
        mockListConversationIdsFromDisk.mockReset();
        mockListConversationIdsFromDisk.mockImplementation(() => ["conv1"]);
        mockListConversationIdsFromDiskForProject.mockReset();
        mockListConversationIdsFromDiskForProject.mockImplementation((projectId: string) => {
            if (projectId === "current-project") return ["conv1"];
            if (projectId === "other-project") return ["conv2"];
            return [];
        });

        mockGetOrLoad.mockReset();
        mockGetOrLoad.mockImplementation((id: string) => getOrCreateStore(id));
        mockLoad.mockReset();
        mockLoad.mockImplementation(loadImplementation);

        ConversationStore.getProjectId = mockGetProjectId as typeof ConversationStore.getProjectId;
        ConversationStore.getBasePath = mockGetBasePath as typeof ConversationStore.getBasePath;
        ConversationStore.listProjectIdsFromDisk = mockListProjectIdsFromDisk as typeof ConversationStore.listProjectIdsFromDisk;
        ConversationStore.listConversationIdsFromDisk = mockListConversationIdsFromDisk as typeof ConversationStore.listConversationIdsFromDisk;
        ConversationStore.listConversationIdsFromDiskForProject = mockListConversationIdsFromDiskForProject as typeof ConversationStore.listConversationIdsFromDiskForProject;
        ConversationStore.getOrLoad = mockGetOrLoad as typeof ConversationStore.getOrLoad;
        ConversationStore.prototype.load = mockLoad as typeof ConversationStore.prototype.load;

        // Setup mock agent
        mockAgent = {
            name: "test-agent",
            pubkey: "mock-agent-pubkey",
        } as AgentInstance;

        // Setup mock context
        mockContext = {
            agent: mockAgent,
            conversationId: "mock-conversation-id",
        } as ExecutionContext;
    });

    afterEach(() => {
        // Clear instantiated stores
        instantiatedStores.length = 0;
    });

    afterAll(() => {
        mock.restore();
    });

    describe("Default behavior (no projectId provided)", () => {
        it("should default to current project using ConversationStore.getProjectId()", async () => {
            const tool = createConversationListTool(mockContext);
            await tool.execute({});

            expect(ConversationStore.getProjectId).toHaveBeenCalled();
        });

        it("should call ConversationStore.getOrLoad for cached loading", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);
            mockGetOrLoad.mockImplementation((id: string) => createMockConversationStore(id));

            const tool = createConversationListTool(mockContext);
            await tool.execute({});

            expect(mockGetOrLoad).toHaveBeenCalledWith("conv1");
            expect(mockGetOrLoad).toHaveBeenCalledWith("conv2");
        });

        it("should return conversations only for the current project", async () => {
            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000 }, { timestamp: 1700001000 }],
                metadata: {
                    title: "Current Project Conversation",
                    summary: "A conversation in current project",
                    phase: "execution",
                },
                lastActivityTime: 1700001000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({});

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].id).toBe("conv1");
            expect(result.conversations[0].title).toBe("Current Project Conversation");
        });

        it("should log the current projectId in the log output", async () => {
            const tool = createConversationListTool(mockContext);
            await tool.execute({});

            expect(logger.info).toHaveBeenCalledWith(
                "📋 Listing conversations",
                expect.objectContaining({
                    projectId: "current-project",
                })
            );
        });
    });

    describe("projectId='specific_project' (External Project)", () => {
        it("should NOT use getOrLoad (cache) for external projects", async () => {
            const tool = createConversationListTool(mockContext);
            await tool.execute({ projectId: "other-project" });

            // getOrLoad should not be called for external project conversations
            expect(mockGetOrLoad).not.toHaveBeenCalledWith("conv2");
        });

        it("should use new ConversationStore() and store.load() for external projects", async () => {
            const tool = createConversationListTool(mockContext);
            await tool.execute({ projectId: "other-project" });

            // Verify that new ConversationStore instances were created
            const otherProjectStores = instantiatedStores.filter(
                s => s.loadedWith?.projectId === "other-project"
            );
            expect(otherProjectStores.length).toBeGreaterThan(0);

            // Verify load was called with the external project
            expect(mockLoad).toHaveBeenCalledWith("other-project", "conv2");
        });

        it("should return conversations for the specified external project", async () => {
            mockStoreOverrides["other-project:conv2"] = {
                messages: [{ timestamp: 1700002000 }],
                metadata: {
                    title: "Other Project Conversation",
                    summary: "A conversation in other project",
                    phase: "planning",
                },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ projectId: "other-project" });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].id).toBe("conv2");
        });

        it("should include projectId in ConversationSummary for external project", async () => {
            mockStoreOverrides["other-project:conv2"] = {
                messages: [{ timestamp: 1700002000 }],
                metadata: { title: "Other Project Conv" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ projectId: "other-project" });

            expect(result.success).toBe(true);
            expect(result.conversations[0].projectId).toBe("other-project");
        });

        it("should call listConversationIdsFromDiskForProject for external project", async () => {
            const tool = createConversationListTool(mockContext);
            await tool.execute({ projectId: "other-project" });

            expect(ConversationStore.listConversationIdsFromDiskForProject).toHaveBeenCalledWith("other-project");
        });
    });

    describe("projectId='all' (Cross-Project)", () => {
        beforeEach(() => {
            // Setup for cross-project tests
            (ConversationStore.listProjectIdsFromDisk as ReturnType<typeof mock>).mockReturnValue([
                "current-project",
                "other-project",
            ]);
        });

        it("should iterate through all projects", async () => {
            const tool = createConversationListTool(mockContext);
            await tool.execute({ projectId: "all" });

            expect(ConversationStore.listProjectIdsFromDisk).toHaveBeenCalled();
        });

        it("should use getOrLoad for current project conversations", async () => {
            const tool = createConversationListTool(mockContext);
            await tool.execute({ projectId: "all" });

            // Current project should use cached getOrLoad
            expect(mockGetOrLoad).toHaveBeenCalledWith("conv1");
        });

        it("should use new ConversationStore logic for external projects", async () => {
            const tool = createConversationListTool(mockContext);
            await tool.execute({ projectId: "all" });

            // External project should create new instances
            const otherProjectStores = instantiatedStores.filter(
                s => s.loadedWith?.projectId === "other-project"
            );
            expect(otherProjectStores.length).toBeGreaterThan(0);
        });

        it("should return conversations from ALL projects", async () => {
            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000 }],
                metadata: { title: "Current Project Conv" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["other-project:conv2"] = {
                messages: [{ timestamp: 1700002000 }],
                metadata: { title: "Other Project Conv" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ projectId: "all" });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(2);

            const convIds = result.conversations.map(c => c.id);
            expect(convIds).toContain("conv1");
            expect(convIds).toContain("conv2");
        });

        it("should include correct projectId in each ConversationSummary", async () => {
            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000 }],
                metadata: { title: "Current Project Conv" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["other-project:conv2"] = {
                messages: [{ timestamp: 1700002000 }],
                metadata: { title: "Other Project Conv" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ projectId: "all" });

            expect(result.success).toBe(true);

            const conv1 = result.conversations.find(c => c.id === "conv1");
            const conv2 = result.conversations.find(c => c.id === "conv2");

            expect(conv1?.projectId).toBe("current-project");
            expect(conv2?.projectId).toBe("other-project");
        });

        it("should sort conversations by last activity descending across all projects", async () => {
            // Setup conversations with different timestamps
            // conv1 (current-project): older timestamp
            // conv2 (other-project): newer timestamp
            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000 }],
                metadata: { title: "Older Conversation" },
                lastActivityTime: 1700000000, // Older
            };
            mockStoreOverrides["other-project:conv2"] = {
                messages: [{ timestamp: 1700005000 }],
                metadata: { title: "Newer Conversation" },
                lastActivityTime: 1700005000, // Newer
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ projectId: "all" });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(2);

            // Most recent should be first
            expect(result.conversations[0].id).toBe("conv2");
            expect(result.conversations[0].lastActivity).toBe(1700005000);

            // Older should be second
            expect(result.conversations[1].id).toBe("conv1");
            expect(result.conversations[1].lastActivity).toBe(1700000000);
        });

        it("should handle multiple conversations per project correctly", async () => {
            // Setup multiple conversations per project
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv3"]);
            (ConversationStore.listConversationIdsFromDiskForProject as ReturnType<typeof mock>).mockImplementation((projectId: string) => {
                if (projectId === "current-project") return ["conv1", "conv3"];
                if (projectId === "other-project") return ["conv2", "conv4"];
                return [];
            });

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700001000 }],
                metadata: { title: "Conv 1" },
                lastActivityTime: 1700001000,
            };
            mockStoreOverrides["current-project:conv3"] = {
                messages: [{ timestamp: 1700003000 }],
                metadata: { title: "Conv 3" },
                lastActivityTime: 1700003000,
            };
            mockStoreOverrides["other-project:conv2"] = {
                messages: [{ timestamp: 1700002000 }],
                metadata: { title: "Conv 2" },
                lastActivityTime: 1700002000,
            };
            mockStoreOverrides["other-project:conv4"] = {
                messages: [{ timestamp: 1700004000 }],
                metadata: { title: "Conv 4" },
                lastActivityTime: 1700004000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ projectId: "all" });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(4);

            // Should be sorted by lastActivity descending
            expect(result.conversations[0].id).toBe("conv4"); // 1700004000
            expect(result.conversations[1].id).toBe("conv3"); // 1700003000
            expect(result.conversations[2].id).toBe("conv2"); // 1700002000
            expect(result.conversations[3].id).toBe("conv1"); // 1700001000
        });
    });

    describe("Date Range Filtering", () => {
        it("should filter by fromTime", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000 }],
                metadata: { title: "Old Conv" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700005000 }],
                metadata: { title: "New Conv" },
                lastActivityTime: 1700005000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ fromTime: 1700004000 });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].id).toBe("conv2");
        });

        it("should filter by toTime", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000 }],
                metadata: { title: "Old Conv" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700005000 }],
                metadata: { title: "New Conv" },
                lastActivityTime: 1700005000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ toTime: 1700002000 });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].id).toBe("conv1");
        });
    });

    describe("Limit Parameter", () => {
        it("should respect the limit parameter", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2", "conv3"]);

            mockStoreOverrides["current-project:conv1"] = { lastActivityTime: 1700001000 };
            mockStoreOverrides["current-project:conv2"] = { lastActivityTime: 1700002000 };
            mockStoreOverrides["current-project:conv3"] = { lastActivityTime: 1700003000 };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ limit: 2 });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(2);
            // Should return the 2 most recent
            expect(result.conversations[0].id).toBe("conv3");
            expect(result.conversations[1].id).toBe("conv2");
        });

        it("should default limit to 50", async () => {
            const tool = createConversationListTool(mockContext);
            await tool.execute({});

            expect(logger.info).toHaveBeenCalledWith(
                "📋 Listing conversations",
                expect.objectContaining({
                    limit: 50,
                })
            );
        });
    });

    describe("Error Handling", () => {
        it("should skip conversations that fail to load", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "bad-conv", "conv2"]);

            mockGetOrLoad.mockImplementation((id: string) => {
                if (id === "bad-conv") {
                    throw new Error("Failed to load");
                }
                return createMockConversationStore(id);
            });

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({});

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(2);
            expect(logger.debug).toHaveBeenCalledWith(
                "Failed to load conversation",
                expect.objectContaining({ id: "bad-conv" })
            );
        });
    });

    describe("ConversationSummary Structure", () => {
        it("should return properly structured ConversationSummary objects", async () => {
            mockStoreOverrides["current-project:conv1"] = {
                messages: [
                    { timestamp: 1700000000 },
                    { timestamp: 1700001000 },
                ],
                metadata: {
                    title: "Test Conversation",
                    summary: "A test summary",
                    phase: "execution",
                    statusLabel: "active",
                    statusCurrentActivity: "Working on task",
                },
                lastActivityTime: 1700001000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({});

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);

            const summary = result.conversations[0];
            expect(summary).toMatchObject({
                id: "conv1",
                title: "Test Conversation",
                summary: "A test summary",
                statusLabel: "active",
                statusCurrentActivity: "Working on task",
                messageCount: 2,
                createdAt: 1700000000,
                lastActivity: 1700001000,
            });
        });
    });

    describe("Logging", () => {
        it("should log conversation listing with correct details", async () => {
            const tool = createConversationListTool(mockContext);
            await tool.execute({ limit: 10, fromTime: 1700000000, toTime: 1700005000 });

            expect(logger.info).toHaveBeenCalledWith(
                "📋 Listing conversations",
                expect.objectContaining({
                    limit: 10,
                    fromTime: 1700000000,
                    toTime: 1700005000,
                    projectId: "current-project",
                    agent: "test-agent",
                })
            );
        });

        it("should log completion with result counts", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            const tool = createConversationListTool(mockContext);
            await tool.execute({ limit: 1 });

            expect(logger.info).toHaveBeenCalledWith(
                "✅ Conversations listed",
                expect.objectContaining({
                    total: 2,
                    filtered: 2,
                    returned: 1,
                })
            );
        });
    });

    describe("getHumanReadableContent", () => {
        it("should return descriptive content for empty params", () => {
            const tool = createConversationListTool(mockContext);
            const content = (tool as any).getHumanReadableContent({});
            expect(content).toBe("Listing conversations");
        });

        it("should include limit in human readable content", () => {
            const tool = createConversationListTool(mockContext);
            const content = (tool as any).getHumanReadableContent({ limit: 10 });
            expect(content).toContain("limit=10");
        });

        it("should include date range in human readable content", () => {
            const tool = createConversationListTool(mockContext);
            const content = (tool as any).getHumanReadableContent({
                fromTime: 1700000000,
                toTime: 1700005000,
            });
            expect(content).toContain("from=");
            expect(content).toContain("to=");
        });

        it("should include projectId in human readable content", () => {
            const tool = createConversationListTool(mockContext);
            const content = (tool as any).getHumanReadableContent({ projectId: "other-project" });
            expect(content).toContain("project=other-project");
        });

        it("should show 'all projects' for projectId='all'", () => {
            const tool = createConversationListTool(mockContext);
            const content = (tool as any).getHumanReadableContent({ projectId: "all" });
            expect(content).toContain("all projects");
        });
    });
});
