import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AgentInstance } from "@/agents/types";
import * as agentResolutionModule from "@/services/agents/AgentResolution";
import * as nostrEntityParserModule from "@/utils/nostr-entity-parser";

mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(),
        warn: mock(),
        error: mock(),
        debug: mock(),
    },
}));

const mockGetNameSync = mock((pubkey: string) => {
    if (pubkey === "agent-pubkey-1") return "agent-1";
    if (pubkey === "agent-pubkey-2") return "agent-2";
    return `${pubkey.slice(0, 12)}...`;
});

mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getNameSync: mockGetNameSync,
    }),
}));

import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { ConversationStore } from "@/conversations/ConversationStore";
import { createConversationListTool } from "../conversation_list";

describe("conversation_list Tool", () => {
    let mockContext: ExecutionContext;
    let mockAgent: AgentInstance;
    let getProjectIdSpy: ReturnType<typeof spyOn>;
    let getBasePathSpy: ReturnType<typeof spyOn>;
    let listProjectIdsSpy: ReturnType<typeof spyOn>;
    let getInstanceSpy: ReturnType<typeof spyOn>;
    let resolveAgentSlugSpy: ReturnType<typeof spyOn>;
    let parseNostrUserSpy: ReturnType<typeof spyOn>;
    const perProjectResults = new Map<string, unknown[]>();
    const perProjectQueries = new Map<string, Array<Record<string, unknown>>>();

    beforeEach(() => {
        mockAgent = { name: "test-agent", pubkey: "agent-pubkey-1", slug: "agent-1" } as AgentInstance;
        mockContext = {
            agent: mockAgent,
            conversationId: "current-conversation",
        } as ExecutionContext;

        perProjectResults.clear();
        perProjectQueries.clear();
        mockGetNameSync.mockReset();
        mockGetNameSync.mockImplementation((pubkey: string) => {
            if (pubkey === "agent-pubkey-1") return "agent-1";
            if (pubkey === "agent-pubkey-2") return "agent-2";
            return `${pubkey.slice(0, 12)}...`;
        });

        getProjectIdSpy = spyOn(ConversationStore, "getProjectId").mockReturnValue("current-project");
        getBasePathSpy = spyOn(ConversationStore, "getBasePath").mockReturnValue("/mock/projects");
        listProjectIdsSpy = spyOn(ConversationStore, "listProjectIdsFromDisk").mockReturnValue([
            "current-project",
            "other-project",
        ]);
        getInstanceSpy = spyOn(ConversationCatalogService, "getInstance").mockImplementation((projectId: string) => ({
            listConversations: (query: Record<string, unknown>) => {
                const queries = perProjectQueries.get(projectId) ?? [];
                queries.push(query);
                perProjectQueries.set(projectId, queries);
                return perProjectResults.get(projectId) ?? [];
            },
        } as unknown as ConversationCatalogService));
        resolveAgentSlugSpy = spyOn(agentResolutionModule, "resolveAgentSlug").mockImplementation((slug) => {
            if (slug === "agent-1") {
                return { pubkey: "agent-pubkey-1", availableSlugs: ["agent-1", "agent-2"] };
            }

            return { pubkey: null, availableSlugs: ["agent-1", "agent-2"] };
        });
        parseNostrUserSpy = spyOn(nostrEntityParserModule, "parseNostrUser").mockImplementation((value) => {
            if (!value) {
                return null;
            }

            return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
        });
    });

    afterEach(() => {
        getProjectIdSpy.mockRestore();
        getBasePathSpy.mockRestore();
        listProjectIdsSpy.mockRestore();
        getInstanceSpy.mockRestore();
        resolveAgentSlugSpy.mockRestore();
        parseNostrUserSpy.mockRestore();
    });

    it("defaults to the current project and renders participants and delegations from the catalog", async () => {
        perProjectResults.set("current-project", [{
            id: "conv-1",
            title: "Conversation 1",
            summary: "Summary 1",
            messageCount: 3,
            createdAt: 100,
            lastActivity: 300,
            participants: [
                {
                    participantKey: "telegram:user:42",
                    principalId: "telegram:user:42",
                    transport: "telegram",
                    displayName: "Pablo Telegram",
                    isAgent: false,
                },
                {
                    participantKey: "agent-pubkey-1",
                    linkedPubkey: "agent-pubkey-1",
                    kind: "agent",
                    isAgent: true,
                },
            ],
            delegationIds: ["delegation-1"],
        }]);

        const tool = createConversationListTool(mockContext);
        const result = await tool.execute({});

        expect(result.success).toBe(true);
        expect(result.total).toBe(1);
        expect(result.conversations).toEqual([{
            id: "conv-1",
            projectId: "current-project",
            title: "Conversation 1",
            summary: "Summary 1",
            messageCount: 3,
            createdAt: 100,
            lastActivity: 300,
            participants: ["Pablo Telegram", "agent-1"],
            delegations: ["delegation-1"],
        }]);
        expect(getInstanceSpy).toHaveBeenCalledWith("current-project", "/mock/projects/current-project");
    });

    it("merges all projects, sorts globally by last activity, and applies the limit", async () => {
        perProjectResults.set("current-project", [{
            id: "conv-current",
            title: "Current",
            summary: "Current summary",
            messageCount: 1,
            createdAt: 100,
            lastActivity: 200,
            participants: [],
            delegationIds: [],
        }]);
        perProjectResults.set("other-project", [{
            id: "conv-other",
            title: "Other",
            summary: "Other summary",
            messageCount: 1,
            createdAt: 100,
            lastActivity: 400,
            participants: [],
            delegationIds: [],
        }]);

        const tool = createConversationListTool(mockContext);
        const result = await tool.execute({ projectId: "ALL", limit: 1 });

        expect(result.success).toBe(true);
        expect(result.total).toBe(2);
        expect(result.conversations).toHaveLength(1);
        expect(result.conversations[0]?.id).toBe("conv-other");
        expect(result.conversations[0]?.projectId).toBe("other-project");
    });

    it("passes date filters through to the catalog query", async () => {
        perProjectResults.set("current-project", []);

        const tool = createConversationListTool(mockContext);
        await tool.execute({ fromTime: 1000, toTime: 2000 });

        expect(perProjectQueries.get("current-project")).toEqual([{
            fromTime: 1000,
            toTime: 2000,
            participantPubkey: undefined,
        }]);
    });

    it("resolves agent slugs for the with filter and passes the pubkey to the catalog query", async () => {
        perProjectResults.set("current-project", []);

        const tool = createConversationListTool(mockContext);
        await tool.execute({ with: "agent-1" });

        expect(resolveAgentSlugSpy).toHaveBeenCalledWith("agent-1");
        expect(perProjectQueries.get("current-project")).toEqual([{
            fromTime: undefined,
            toTime: undefined,
            participantPubkey: "agent-pubkey-1",
        }]);
    });

    it("accepts hex pubkeys for the with filter across all projects", async () => {
        const hexPubkey = "c".repeat(64);
        perProjectResults.set("current-project", []);
        perProjectResults.set("other-project", []);

        const tool = createConversationListTool(mockContext);
        await tool.execute({ projectId: "all", with: hexPubkey });

        expect(parseNostrUserSpy).toHaveBeenCalledWith(hexPubkey);
        expect(perProjectQueries.get("current-project")?.[0]?.participantPubkey).toBe(hexPubkey);
        expect(perProjectQueries.get("other-project")?.[0]?.participantPubkey).toBe(hexPubkey);
    });

    it("rejects agent slugs when projectId is all", async () => {
        const tool = createConversationListTool(mockContext);

        await expect(tool.execute({ projectId: "all", with: "agent-1" })).rejects.toThrow(
            "Agent slugs are not supported when projectId='all'"
        );
    });

    it("rejects unresolved agent slugs with the available slug list", async () => {
        const tool = createConversationListTool(mockContext);

        await expect(tool.execute({ with: "missing-agent" })).rejects.toThrow(
            'Failed to resolve \'with\' parameter: "missing-agent". Could not find an agent with this slug or parse it as a pubkey. Available agent slugs in this project: agent-1, agent-2.'
        );
    });
});
