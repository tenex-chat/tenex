import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AgentInstance } from "@/agents/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import { createConversationListTool } from "../conversation_list";

// Mock dependencies
mock.module("@/utils/logger", () => ({
    logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({ getNameSync: (pk: string) => pk.substring(0, 12) }),
}));

mock.module("@/services/agents/AgentResolution", () => ({
    resolveAgentSlug: (slug: string) => ({ pubkey: null, availableSlugs: [] }),
}));

mock.module("@/utils/nostr-entity-parser", () => ({
    parseNostrUser: () => null,
}));

describe("Debug Mock Store", () => {
    beforeEach(() => {
        const mockGetProjectId = mock(() => "test-project");
        ConversationStore.getProjectId = mockGetProjectId as any;
        ConversationStore.getBasePath = mock(() => "/test") as any;
        ConversationStore.listConversationIdsFromDisk = mock(() => ["conv1"]) as any;
        ConversationStore.listConversationIdsFromDiskForProject = mock(() => []) as any;
        ConversationStore.listProjectIdsFromDisk = mock(() => ["test-project"]) as any;

        const mockGetOrLoad = mock((id: string) => {
            const store = new ConversationStore("/test");
            (store as any).state = {
                messages: [{ pubkey: "user", content: "test", messageType: "text", timestamp: 1700001000 }],
                activeRal: {},
                nextRalNumber: {},
                injections: [],
                agentTodos: {},
                todoNudgedAgents: [],
                blockedAgents: [],
                executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
                contextManagementCompactions: {},
                selfAppliedSkills: {},
                agentPromptHistories: {},
                contextManagementReminderStates: {},
            };
            (store as any).conversationId = id;
            (store as any).projectId = "test-project";
            return store;
        });
        ConversationStore.getOrLoad = mockGetOrLoad as any;
        ConversationStore.prototype.load = mock(() => {}) as any;
    });

    it("should test getLastActivityTime on mock store", () => {
        const store = ConversationStore.getOrLoad("conv1");
        console.log("Store.state:", (store as any).state);
        console.log("Store.state.messages:", (store as any).state?.messages);
        console.log("getLastActivityTime:", store.getLastActivityTime());
        expect(store.getLastActivityTime()).toBe(1700001000);
    });

    it("should test conversation_list tool returns lastActive", async () => {
        const mockAgent = { name: "test-agent", pubkey: "mock-agent-pubkey" } as AgentInstance;
        const mockContext = { agent: mockAgent, conversationId: "mock-conv" } as ExecutionContext;

        const tool = createConversationListTool(mockContext);
        const result = await tool.execute({});

        console.log("Result:", JSON.stringify(result, null, 2));
        expect(result.success).toBe(true);
        expect(result.conversations.length).toBeGreaterThan(0);
        expect(result.conversations[0].lastActive).toBeDefined();
    });
});
