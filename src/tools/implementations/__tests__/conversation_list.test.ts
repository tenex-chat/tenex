import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AgentInstance } from "@/agents/types";
import * as agentResolutionModule from "@/services/agents/AgentResolution";
import * as nostrEntityParserModule from "@/utils/nostr-entity-parser";
import { shortenPubkey } from "@/utils/conversation-id";

// Mock dependencies - must be before imports
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(),
        warn: mock(),
        error: mock(),
        debug: mock(),
    },
}));

// Mock PubkeyService
const mockGetNameSync = mock((pubkey: string) => {
    // Map specific pubkeys to names for testing
    if (pubkey === "agent-pubkey-1") return "agent-1";
    if (pubkey === "agent-pubkey-2") return "agent-2";
    if (pubkey === "user-pubkey") return "user-pubkey12"; // shortened pubkey format
    return shortenPubkey(pubkey);
});

mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getNameSync: mockGetNameSync,
    }),
}));

const mockResolveAgentSlug = mock((slug: string) => {
    if (slug === "agent-1") return { pubkey: "agent-pubkey-1", availableSlugs: ["agent-1", "agent-2"] };
    if (slug === "agent-2") return { pubkey: "agent-pubkey-2", availableSlugs: ["agent-1", "agent-2"] };
    return { pubkey: null, availableSlugs: ["agent-1", "agent-2"] };
});

import { ConversationStore } from "@/conversations/ConversationStore";
import { logger } from "@/utils/logger";
import { createConversationListTool } from "../conversation_list";

type StoreOverrides = {
    messages?: Array<{
        timestamp: number;
        pubkey?: string;
        senderPubkey?: string;
        senderPrincipal?: {
            id: string;
            transport: string;
            linkedPubkey?: string;
            displayName?: string;
            username?: string;
            kind?: "agent" | "human" | "system";
        };
        messageType?: string;
        delegationMarker?: {
            delegationConversationId: string;
            recipientPubkey: string;
            parentConversationId: string;
            completedAt: number;
            status: string;
        };
    }>;
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
    if (overrides.messages && overrides.messages.length > 0) {
        return overrides.messages.map(msg => ({
            pubkey: msg.pubkey ?? "user-pubkey",
            senderPubkey: msg.senderPubkey,
            senderPrincipal: msg.senderPrincipal,
            content: "",
            messageType: msg.messageType ?? "text",
            timestamp: msg.timestamp,
            delegationMarker: msg.delegationMarker,
        }));
    }
    if (typeof overrides.lastActivityTime === "number") {
        return [{ pubkey: "user-pubkey", content: "", messageType: "text", timestamp: overrides.lastActivityTime }];
    }
    return [
        { pubkey: "user-pubkey", content: "", messageType: "text", timestamp: 1700000000 },
        { pubkey: "user-pubkey", content: "", messageType: "text", timestamp: 1700001000 },
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
            pubkey: (message as any).pubkey ?? "user-pubkey",
            content: (message as any).content ?? "",
            messageType: (message as any).messageType ?? "text",
            timestamp: message.timestamp,
            eventId: `event-${projectId}-${conversationId}-${index}`,
            senderPubkey: (message as any).senderPubkey,
            senderPrincipal: (message as any).senderPrincipal,
            delegationMarker: (message as any).delegationMarker,
        })),
        metadata,
        agentTodos: {},
        todoNudgedAgents: [],
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

afterEach(() => {
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
    let resolveAgentSlugSpy: ReturnType<typeof spyOn>;
    let parseNostrUserSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        resolveAgentSlugSpy = spyOn(agentResolutionModule, "resolveAgentSlug").mockImplementation(
            mockResolveAgentSlug
        );
        parseNostrUserSpy = spyOn(nostrEntityParserModule, "parseNostrUser").mockImplementation(
            (input: string | undefined) => {
                if (!input) {
                    return null;
                }
                const trimmed = input.trim();
                if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
                    return trimmed.toLowerCase();
                }
                return null;
            }
        );
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
        resolveAgentSlugSpy?.mockRestore();
        parseNostrUserSpy?.mockRestore();
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
            // New fields: participants and delegations
            expect(result.conversations[0].participants).toBeDefined();
            expect(Array.isArray(result.conversations[0].participants)).toBe(true);
            expect(result.conversations[0].delegations).toBeDefined();
            expect(Array.isArray(result.conversations[0].delegations)).toBe(true);
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
                },
                lastActivityTime: 1700001000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({});

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);

            const summary = result.conversations[0];
            expect(summary.id).toBe("conv1");
            expect(summary.title).toBe("Test Conversation");
            expect(summary.summary).toBe("A test summary");
            expect(summary.messageCount).toBe(2);
            expect(summary.createdAt).toBe(1700000000);
            expect(summary.lastActivity).toBe(1700001000);
            // New fields
            expect(summary.participants).toBeDefined();
            expect(Array.isArray(summary.participants)).toBe(true);
            expect(summary.delegations).toBeDefined();
            expect(Array.isArray(summary.delegations)).toBe(true);
            // Should NOT have statusLabel and statusCurrentActivity
            expect((summary as any).statusLabel).toBeUndefined();
            expect((summary as any).statusCurrentActivity).toBeUndefined();
        });

        it("should include participant names resolved from pubkeys", async () => {
            mockStoreOverrides["current-project:conv1"] = {
                messages: [
                    { timestamp: 1700000000, pubkey: "agent-pubkey-1" },
                    { timestamp: 1700001000, pubkey: "agent-pubkey-2" },
                    { timestamp: 1700002000, pubkey: "agent-pubkey-1" },
                ],
                metadata: { title: "Multi-participant Conv" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({});

            expect(result.success).toBe(true);
            const summary = result.conversations[0];
            // Should have unique participants (agent-1 and agent-2)
            expect(summary.participants).toContain("agent-1");
            expect(summary.participants).toContain("agent-2");
            expect(summary.participants).toHaveLength(2);
        });

        it("should include transport-only participants without treating their principal id as a pubkey", async () => {
            mockStoreOverrides["current-project:conv1"] = {
                messages: [
                    {
                        timestamp: 1700000000,
                        pubkey: "",
                        senderPrincipal: {
                            id: "telegram:user:42",
                            transport: "telegram",
                            displayName: "Pablo Telegram",
                            kind: "human",
                        },
                    },
                    { timestamp: 1700001000, pubkey: "agent-pubkey-1" },
                ],
                metadata: { title: "Telegram conversation" },
                lastActivityTime: 1700001000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({});

            expect(result.success).toBe(true);
            const summary = result.conversations[0];
            expect(summary.participants).toContain("Pablo Telegram");
            expect(summary.participants).toContain("agent-1");
            expect(summary.participants).toHaveLength(2);
        });

        it("should include exact delegation IDs", async () => {
            const delegationConvId = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
            mockStoreOverrides["current-project:conv1"] = {
                messages: [
                    { timestamp: 1700000000 },
                    {
                        timestamp: 1700001000,
                        messageType: "delegation-marker",
                        delegationMarker: {
                            delegationConversationId: delegationConvId,
                            recipientPubkey: "recipient-pubkey",
                            parentConversationId: "parent-conv-id",
                            completedAt: 1700001000000,
                            status: "completed",
                        },
                    },
                ],
                metadata: { title: "Conv with Delegation" },
                lastActivityTime: 1700001000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({});

            expect(result.success).toBe(true);
            const summary = result.conversations[0];
            expect(summary.delegations).toHaveLength(1);
            expect(summary.delegations[0]).toBe(delegationConvId);
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

    describe("'with' Parameter Filtering", () => {
        it("should filter by agent slug", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [
                    { timestamp: 1700000000, pubkey: "agent-pubkey-1" },
                ],
                metadata: { title: "Conv with agent-1" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [
                    { timestamp: 1700002000, pubkey: "agent-pubkey-2" },
                ],
                metadata: { title: "Conv with agent-2" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ with: "agent-1" });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("Conv with agent-1");
        });

        it("should filter by pubkey (hex format)", async () => {
            const hexPubkey = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [
                    { timestamp: 1700000000, pubkey: hexPubkey },
                ],
                metadata: { title: "Conv with hex pubkey" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [
                    { timestamp: 1700002000, pubkey: "other-pubkey" },
                ],
                metadata: { title: "Conv with other pubkey" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ with: hexPubkey });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("Conv with hex pubkey");
        });

        it("should throw an error when 'with' slug cannot be resolved", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000 }],
                metadata: { title: "Conv 1" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700002000 }],
                metadata: { title: "Conv 2" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);

            // When the 'with' parameter cannot be resolved, it should throw an error
            // instead of silently returning all conversations
            await expect(tool.execute({ with: "unknown-agent" })).rejects.toThrow(
                /Failed to resolve 'with' parameter: "unknown-agent"/
            );
        });

        it("should include available slugs in error message when slug resolution fails", async () => {
            const tool = createConversationListTool(mockContext);

            await expect(tool.execute({ with: "nonexistent-slug" })).rejects.toThrow(
                /Available agent slugs in this project: agent-1, agent-2/
            );
        });

        it("should throw an error when slug is used with projectId='all'", async () => {
            (ConversationStore.listProjectIdsFromDisk as ReturnType<typeof mock>).mockReturnValue([
                "current-project",
                "other-project",
            ]);

            const tool = createConversationListTool(mockContext);

            // Using a slug with projectId="all" should throw an error
            await expect(tool.execute({ projectId: "all", with: "agent-1" })).rejects.toThrow(
                /Agent slugs are not supported when projectId='all'/
            );
        });

        it("should throw an error when slug is used with projectId='ALL' (case insensitive)", async () => {
            (ConversationStore.listProjectIdsFromDisk as ReturnType<typeof mock>).mockReturnValue([
                "current-project",
                "other-project",
            ]);

            const tool = createConversationListTool(mockContext);

            // Using a slug with projectId="ALL" (uppercase) should also throw
            await expect(tool.execute({ projectId: "ALL", with: "agent-1" })).rejects.toThrow(
                /Agent slugs are not supported when projectId='all'/
            );
        });

        it("should allow pubkey with projectId='all'", async () => {
            const hexPubkey = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            (ConversationStore.listProjectIdsFromDisk as ReturnType<typeof mock>).mockReturnValue([
                "current-project",
                "other-project",
            ]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: hexPubkey }],
                metadata: { title: "Conv with hex pubkey" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["other-project:conv2"] = {
                messages: [{ timestamp: 1700002000, pubkey: "other-pubkey" }],
                metadata: { title: "Conv with other pubkey" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            // Using a pubkey with projectId="all" should work fine
            const result = await tool.execute({ projectId: "all", with: hexPubkey });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("Conv with hex pubkey");
        });

        it("should throw descriptive error for invalid pubkey format", async () => {
            const tool = createConversationListTool(mockContext);

            // A value that looks like a pubkey but is invalid
            const invalidPubkey = "npub1invalid";

            await expect(tool.execute({ with: invalidPubkey })).rejects.toThrow(
                /looks like a pubkey but could not be parsed/
            );
        });

        it("should combine 'with' filter with date range filter", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2", "conv3"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: "agent-pubkey-1" }],
                metadata: { title: "Old conv with agent-1" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700005000, pubkey: "agent-pubkey-1" }],
                metadata: { title: "New conv with agent-1" },
                lastActivityTime: 1700005000,
            };
            mockStoreOverrides["current-project:conv3"] = {
                messages: [{ timestamp: 1700005000, pubkey: "agent-pubkey-2" }],
                metadata: { title: "New conv with agent-2" },
                lastActivityTime: 1700005000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ with: "agent-1", fromTime: 1700004000 });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("New conv with agent-1");
        });
    });

    describe("'participants' Parameter Filtering", () => {
        // 64-char hex pubkeys used in participants tests
        const HEX_PUBKEY_1 = "1111111111111111111111111111111111111111111111111111111111111111";
        const HEX_PUBKEY_2 = "2222222222222222222222222222222222222222222222222222222222222222";

        it("should filter by single participant entry", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: HEX_PUBKEY_1 }],
                metadata: { title: "Conv with pubkey-1" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700002000, pubkey: HEX_PUBKEY_2 }],
                metadata: { title: "Conv with pubkey-2" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ participants: [HEX_PUBKEY_1] });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("Conv with pubkey-1");
        });

        it("should filter by multiple participants with OR semantics", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2", "conv3"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: HEX_PUBKEY_1 }],
                metadata: { title: "Conv with agent-1" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700002000, pubkey: HEX_PUBKEY_2 }],
                metadata: { title: "Conv with agent-2" },
                lastActivityTime: 1700002000,
            };
            mockStoreOverrides["current-project:conv3"] = {
                messages: [{ timestamp: 1700004000, pubkey: "user-pubkey" }],
                metadata: { title: "Conv with user" },
                lastActivityTime: 1700004000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ participants: [HEX_PUBKEY_1, HEX_PUBKEY_2] });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(2);
            const titles = result.conversations.map(c => c.title);
            expect(titles).toContain("Conv with agent-1");
            expect(titles).toContain("Conv with agent-2");
        });

        it("should return empty when no participants match", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: "agent-pubkey-1" }],
                metadata: { title: "Conv with agent-1" },
                lastActivityTime: 1700000000,
            };

            const tool = createConversationListTool(mockContext);
            // Use a 64-char hex that won't match anything
            const result = await tool.execute({
                participants: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
            });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(0);
        });

        it("should combine 'with' and 'participants' as OR", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2", "conv3"]);

            // agent-1 slug resolves to "agent-pubkey-1" via mockResolveAgentSlug
            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: "agent-pubkey-1" }],
                metadata: { title: "Conv A - agent-1 only" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700002000, pubkey: HEX_PUBKEY_2 }],
                metadata: { title: "Conv B - pubkey-2 only" },
                lastActivityTime: 1700002000,
            };
            mockStoreOverrides["current-project:conv3"] = {
                messages: [{ timestamp: 1700004000, pubkey: "user-pubkey" }],
                metadata: { title: "Conv C - user only" },
                lastActivityTime: 1700004000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ with: "agent-1", participants: [HEX_PUBKEY_2] });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(2);
            const titles = result.conversations.map(c => c.title);
            expect(titles).toContain("Conv A - agent-1 only");
            expect(titles).toContain("Conv B - pubkey-2 only");
        });

        it("should resolve agent slug in participants array", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: "agent-pubkey-1" }],
                metadata: { title: "Conv with agent-1" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700002000, pubkey: "agent-pubkey-2" }],
                metadata: { title: "Conv with agent-2" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ participants: ["agent-1"] });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("Conv with agent-1");
            expect(resolveAgentSlugSpy).toHaveBeenCalledWith("agent-1");
        });

        it("should throw when slug used in participants with projectId=ALL", async () => {
            (ConversationStore.listProjectIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["current-project"]);

            const tool = createConversationListTool(mockContext);

            await expect(tool.execute({ projectId: "ALL", participants: ["agent-1"] })).rejects.toThrow(
                /participants\[0\].*agent slug.*cannot be used with projectId=ALL/
            );
        });

        it("should resolve shortened hex pubkey via prefix match", async () => {
            // Use a 64-char pubkey that starts with our 18-char prefix
            const fullPubkey = "abcdef0123456789ab" + "0".repeat(46); // 18 + 46 = 64 chars
            const prefix = "abcdef0123456789ab"; // exactly 18 chars

            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: fullPubkey }],
                metadata: { title: "Conv with matching pubkey" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700002000, pubkey: "agent-pubkey-2" }],
                metadata: { title: "Conv with other pubkey" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ participants: [prefix] });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("Conv with matching pubkey");
        });

        it("should throw on ambiguous shortened pubkey", async () => {
            // Two pubkeys sharing the same 18-char prefix
            const prefix = "abcdef0123456789ab";
            const pubkey1 = prefix + "1" + "0".repeat(45); // 64 chars
            const pubkey2 = prefix + "2" + "0".repeat(45); // 64 chars

            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: pubkey1 }],
                metadata: { title: "Conv 1" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700002000, pubkey: pubkey2 }],
                metadata: { title: "Conv 2" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);

            await expect(tool.execute({ participants: [prefix] })).rejects.toThrow(
                /participants\[0\].*ambiguous/
            );
        });

        it("should throw on no-match shortened pubkey", async () => {
            const prefix = "aaaaaabbbbbbcccccc"; // 18 chars — won't match any known pubkey

            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: "agent-pubkey-1" }],
                metadata: { title: "Conv 1" },
                lastActivityTime: 1700000000,
            };

            const tool = createConversationListTool(mockContext);

            await expect(tool.execute({ participants: [prefix] })).rejects.toThrow(
                /participants\[0\].*no known pubkey matches/
            );
        });

        it("should deduplicate when 'with' and 'participants' resolve to same pubkey", async () => {
            // agent-1 slug resolves to "agent-pubkey-1" via mockResolveAgentSlug
            // We use HEX_PUBKEY_1 for both the message and the participants array entry
            // but also use "agent-1" slug for 'with' which resolves to "agent-pubkey-1"
            // Both should be treated as one pubkey in the Set
            const agentPubkey1Hex = "1111111111111111111111111111111111111111111111111111111111111111";

            // Override resolveAgentSlug so "agent-1" resolves to our 64-char hex pubkey
            resolveAgentSlugSpy.mockImplementation((slug: string) => {
                if (slug === "agent-1") return { pubkey: agentPubkey1Hex, availableSlugs: ["agent-1"] };
                return { pubkey: null, availableSlugs: ["agent-1"] };
            });

            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: agentPubkey1Hex }],
                metadata: { title: "Conv with agent-1" },
                lastActivityTime: 1700000000,
            };

            const tool = createConversationListTool(mockContext);
            // 'with: "agent-1"' resolves to agentPubkey1Hex, participants: [agentPubkey1Hex] also resolves to same
            const result = await tool.execute({ with: "agent-1", participants: [agentPubkey1Hex] });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("Conv with agent-1");
        });

        it("should resolve npub entries in participants array", async () => {
            // Mock parseNostrUser to handle npub by returning a known pubkey
            parseNostrUserSpy.mockImplementation((input: string | undefined) => {
                if (!input) return null;
                const trimmed = input.trim();
                if (trimmed === "npub1agentone") return "agent-pubkey-1";
                if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
                return null;
            });

            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: "agent-pubkey-1" }],
                metadata: { title: "Conv with agent-1" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700002000, pubkey: "agent-pubkey-2" }],
                metadata: { title: "Conv with agent-2" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ participants: ["npub1agentone"] });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("Conv with agent-1");
        });

        it("should resolve nprofile entries in participants array", async () => {
            // Mock parseNostrUser to handle nprofile by returning a known pubkey
            parseNostrUserSpy.mockImplementation((input: string | undefined) => {
                if (!input) return null;
                const trimmed = input.trim();
                if (trimmed === "nprofile1agentone") return "agent-pubkey-1";
                if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
                return null;
            });

            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: "agent-pubkey-1" }],
                metadata: { title: "Conv with agent-1" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700002000, pubkey: "agent-pubkey-2" }],
                metadata: { title: "Conv with agent-2" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ participants: ["nprofile1agentone"] });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("Conv with agent-1");
        });

        it("should trim and normalize case of entries", async () => {
            const hexPubkey = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: hexPubkey }],
                metadata: { title: "Conv with hex pubkey" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700002000, pubkey: "agent-pubkey-2" }],
                metadata: { title: "Conv with agent-2" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            // Use uppercase and whitespace — should be normalized
            const result = await tool.execute({
                participants: [`  ${hexPubkey.toUpperCase()}  `],
            });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("Conv with hex pubkey");
        });

        it("should treat empty array as no filter", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: "agent-pubkey-1" }],
                metadata: { title: "Conv 1" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700002000, pubkey: "agent-pubkey-2" }],
                metadata: { title: "Conv 2" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            // Empty participants array should return all conversations, not throw
            const result = await tool.execute({ participants: [] });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(2);
        });

        it("should throw on blank/whitespace-only entries", async () => {
            const hexPubkey = "agent-pubkey-1";

            const tool = createConversationListTool(mockContext);

            // Second entry (index 1) is whitespace-only
            await expect(
                tool.execute({ participants: ["agent-1", "   "] })
            ).rejects.toThrow(/participants\[1\].*empty or whitespace/);
        });

        it("should throw for slug entry under projectId=ALL but not hex entry", async () => {
            (ConversationStore.listProjectIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["current-project"]);

            const hexPubkey = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

            const tool = createConversationListTool(mockContext);

            // First entry is valid hex (index 0), second is a slug (index 1) — should throw for slug
            await expect(
                tool.execute({ projectId: "ALL", participants: [hexPubkey, "some-slug"] })
            ).rejects.toThrow(/participants\[1\].*agent slug.*cannot be used with projectId=ALL/);
        });

        it("should combine participants with fromTime/toTime filters", async () => {
            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2", "conv3"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: HEX_PUBKEY_1 }],
                metadata: { title: "Old conv with pubkey-1" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700005000, pubkey: HEX_PUBKEY_1 }],
                metadata: { title: "New conv with pubkey-1" },
                lastActivityTime: 1700005000,
            };
            mockStoreOverrides["current-project:conv3"] = {
                messages: [{ timestamp: 1700005000, pubkey: HEX_PUBKEY_2 }],
                metadata: { title: "New conv with pubkey-2" },
                lastActivityTime: 1700005000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ participants: [HEX_PUBKEY_1], fromTime: 1700004000 });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("New conv with pubkey-1");
        });

        it("should resolve shortened hex prefix even when matching conv is outside the date range", async () => {
            // fullPubkey only appears in conv1 which is outside the fromTime window.
            // Prefix resolution must consult ALL conversations, not just the date-filtered ones.
            const fullPubkey = "abcdef0123456789ab" + "0".repeat(46); // 64 chars
            const prefix = "abcdef0123456789ab"; // 18-char prefix

            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                // Outside the fromTime window — but this is where fullPubkey lives
                messages: [{ timestamp: 1699000000, pubkey: fullPubkey }],
                metadata: { title: "Old conv with target pubkey" },
                lastActivityTime: 1699000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700010000, pubkey: "agent-pubkey-2" }],
                metadata: { title: "New conv with other pubkey" },
                lastActivityTime: 1700010000,
            };

            const tool = createConversationListTool(mockContext);
            // fromTime excludes conv1 from results. Without the fix, prefix resolution would
            // scan only date-filtered conversations and throw "no known pubkey matches".
            // With the fix, resolution scans allConversations and uniquely resolves the prefix.
            await expect(tool.execute({ participants: [prefix], fromTime: 1700000000 })).resolves.toMatchObject({
                success: true,
            });
        });

        it("should resolve nostr:npub... format in participants array", async () => {
            parseNostrUserSpy.mockImplementation((input: string | undefined) => {
                if (!input) return null;
                const trimmed = input.trim();
                const cleaned = trimmed.startsWith("nostr:") ? trimmed.substring(6) : trimmed;
                if (cleaned === "npub1agentone") return "agent-pubkey-1";
                if (/^[0-9a-fA-F]{64}$/.test(cleaned)) return cleaned.toLowerCase();
                return null;
            });

            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: "agent-pubkey-1" }],
                metadata: { title: "Conv with agent-1" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700002000, pubkey: "agent-pubkey-2" }],
                metadata: { title: "Conv with agent-2" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ participants: ["nostr:npub1agentone"] });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("Conv with agent-1");
        });

        it("should resolve nostr:nprofile... format in participants array", async () => {
            parseNostrUserSpy.mockImplementation((input: string | undefined) => {
                if (!input) return null;
                const trimmed = input.trim();
                const cleaned = trimmed.startsWith("nostr:") ? trimmed.substring(6) : trimmed;
                if (cleaned === "nprofile1agentone") return "agent-pubkey-1";
                if (/^[0-9a-fA-F]{64}$/.test(cleaned)) return cleaned.toLowerCase();
                return null;
            });

            (ConversationStore.listConversationIdsFromDisk as ReturnType<typeof mock>).mockReturnValue(["conv1", "conv2"]);

            mockStoreOverrides["current-project:conv1"] = {
                messages: [{ timestamp: 1700000000, pubkey: "agent-pubkey-1" }],
                metadata: { title: "Conv with agent-1" },
                lastActivityTime: 1700000000,
            };
            mockStoreOverrides["current-project:conv2"] = {
                messages: [{ timestamp: 1700002000, pubkey: "agent-pubkey-2" }],
                metadata: { title: "Conv with agent-2" },
                lastActivityTime: 1700002000,
            };

            const tool = createConversationListTool(mockContext);
            const result = await tool.execute({ participants: ["nostr:nprofile1agentone"] });

            expect(result.success).toBe(true);
            expect(result.conversations).toHaveLength(1);
            expect(result.conversations[0].title).toBe("Conv with agent-1");
        });
    });

});
