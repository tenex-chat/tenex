import { beforeEach, describe, expect, it, mock, afterEach } from "bun:test";
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

// Store mock implementations for ConversationStore
const mockGetOrLoad = mock();
const mockLoad = mock();
const mockGetAllMessages = mock();
const mockGetLastActivityTime = mock();

// Mock ConversationStore instance factory
const createMockConversationStore = (
    id: string,
    overrides: {
        messages?: Array<{ timestamp: number }>;
        metadata?: Record<string, unknown>;
        lastActivityTime?: number;
    } = {}
) => {
    const messages = overrides.messages ?? [
        { timestamp: 1700000000 },
        { timestamp: 1700001000 },
    ];
    const metadata = overrides.metadata ?? {
        title: `Conversation ${id}`,
        summary: `Summary for ${id}`,
        phase: "execution",
        statusLabel: "active",
        statusCurrentActivity: "Working",
    };
    const lastActivityTime = overrides.lastActivityTime ?? messages[messages.length - 1]?.timestamp ?? 0;

    return {
        id,
        getAllMessages: () => messages,
        getLastActivityTime: () => lastActivityTime,
        metadata,
        title: metadata.title,
        phase: metadata.phase,
    };
};

// Track instantiated stores for the "new ConversationStore" path
const instantiatedStores: Array<{ basePath: string; loadedWith?: { projectId: string; conversationId: string } }> = [];

mock.module("@/conversations/ConversationStore", () => {
    const MockConversationStore = class {
        private basePath: string;
        private projectId: string | null = null;
        private conversationId: string | null = null;
        private mockStore: ReturnType<typeof createMockConversationStore> | null = null;

        constructor(basePath: string) {
            this.basePath = basePath;
            instantiatedStores.push({ basePath });
        }

        load(projectId: string, conversationId: string) {
            this.projectId = projectId;
            this.conversationId = conversationId;
            // Track the load call
            const storeEntry = instantiatedStores.find(s => s.basePath === this.basePath && !s.loadedWith);
            if (storeEntry) {
                storeEntry.loadedWith = { projectId, conversationId };
            }
            // Call the mock to allow test customization
            mockLoad(projectId, conversationId);
            // Create a mock store based on the IDs
            this.mockStore = createMockConversationStore(conversationId, mockStoreOverrides[`${projectId}:${conversationId}`] ?? {});
        }

        get id() {
            return this.conversationId;
        }

        getAllMessages() {
            return this.mockStore?.getAllMessages() ?? [];
        }

        getLastActivityTime() {
            return this.mockStore?.getLastActivityTime() ?? 0;
        }

        get metadata() {
            return this.mockStore?.metadata ?? {};
        }

        get title() {
            return this.mockStore?.title;
        }

        get phase() {
            return this.mockStore?.phase;
        }
    };

    return {
        ConversationStore: Object.assign(MockConversationStore, {
            getProjectId: mock(() => "current-project"),
            getBasePath: mock(() => "/mock/base/path"),
            listProjectIdsFromDisk: mock(() => ["current-project"]),
            listConversationIdsFromDisk: mock(() => ["conv1"]),
            listConversationIdsFromDiskForProject: mock((projectId: string) => {
                if (projectId === "current-project") return ["conv1"];
                if (projectId === "other-project") return ["conv2"];
                return [];
            }),
            getOrLoad: mockGetOrLoad,
        }),
    };
});

import { ConversationStore } from "@/conversations/ConversationStore";
import { logger } from "@/utils/logger";
import { createConversationListTool } from "../conversation_list";

// Store overrides for customizing mock stores per test
let mockStoreOverrides: Record<string, {
    messages?: Array<{ timestamp: number }>;
    metadata?: Record<string, unknown>;
    lastActivityTime?: number;
}> = {};

describe("conversation_list Tool", () => {
    let mockContext: ExecutionContext;
    let mockAgent: AgentInstance;

    beforeEach(() => {
        // Reset all mocks
        (logger.info as ReturnType<typeof mock>).mockReset();
        (logger.warn as ReturnType<typeof mock>).mockReset();
        (logger.error as ReturnType<typeof mock>).mockReset();
        (logger.debug as ReturnType<typeof mock>).mockReset();
        mockGetOrLoad.mockReset();
        mockLoad.mockReset();

        // Clear tracked instantiated stores
        instantiatedStores.length = 0;

        // Reset store overrides
        mockStoreOverrides = {};

        // Reset static method mocks to defaults
        (ConversationStore.getProjectId as ReturnType<typeof mock>).mockReturnValue("current-project");
        (ConversationStore.getBasePath as ReturnType<typeof mock>).mockReturnValue("/mock/base/path");
        (ConversationStore.listProjectIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["current-project"]);
        (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1"]);
        (ConversationStore.listConversationIdsFromDiskForProject as ReturnType<typeof mock>).mockImplementation((projectId: string) => {
            if (projectId === "current-project") return ["conv1"];
            if (projectId === "other-project") return ["conv2"];
            return [];
        });

        // Setup mock getOrLoad to return mock conversation stores
        mockGetOrLoad.mockImplementation((id: string) => {
            return createMockConversationStore(id, mockStoreOverrides[`current-project:${id}`] ?? {});
        });

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
