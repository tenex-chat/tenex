import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as projectsModule from "@/services/projects";
import { createMockToolContext } from "@/test-utils";
import { createMcpListResourcesTool } from "../mcp_list_resources";
import { createMcpResourceReadTool } from "../mcp_resource_read";
import { createMcpSubscribeTool } from "../mcp_subscribe";

const mockMcpManager = {
    getConfiguredServers: mock(() => ["chrome"]),
    listResourcesWithOptions: mock(async () => [
        {
            name: "tabs",
            uri: "chrome://tabs",
            description: "Open browser tabs",
            mimeType: "text/plain",
        },
    ]),
    listResourceTemplatesWithOptions: mock(async () => []),
    readResource: mock(async () => ({
        contents: [
            {
                text: "browser data",
                mimeType: "text/plain",
            },
        ],
    })),
};

const mockSubscriptionService = {
    createSubscription: mock(async () => ({
        id: "subscription-1",
        serverName: "chrome",
        resourceUri: "chrome://tabs",
        conversationId: "conversation-1",
        status: "ACTIVE",
        description: "watch browser tabs",
        agentPubkey: "agent-pubkey",
        agentSlug: "agent-slug",
        rootEventId: "root-event",
        projectId: "project-1",
        notificationsReceived: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    })),
};

mock.module("@/services/mcp/McpSubscriptionService", () => ({
    McpSubscriptionService: {
        getInstance: () => mockSubscriptionService,
    },
}));

describe("MCP access tools", () => {
    let getProjectContextSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        mockMcpManager.getConfiguredServers.mockClear();
        mockMcpManager.listResourcesWithOptions.mockClear();
        mockMcpManager.listResourceTemplatesWithOptions.mockClear();
        mockMcpManager.readResource.mockClear();
        mockSubscriptionService.createSubscription.mockClear();

        getProjectContextSpy = spyOn(projectsModule, "getProjectContext").mockReturnValue({
            project: {
                dTag: "project-1",
                tagId: () => "project-1",
                tagValue: (tag: string) => (tag === "d" ? "project-1" : undefined),
            },
            mcpManager: mockMcpManager as never,
        } as never);
    });

    afterEach(() => {
        getProjectContextSpy?.mockRestore();
        mock.restore();
    });

    it("lists resources using agent mcpAccess", async () => {
        const context = createMockToolContext({
            agent: {
                ...createMockToolContext().agent,
                tools: [],
                mcpAccess: ["chrome"],
            },
        });
        const tool = createMcpListResourcesTool(context);

        const result = await tool.execute({});

        expect(result).toContain("chrome");
        expect(result).toContain("Access to 1 server");
        expect(mockMcpManager.listResourcesWithOptions).toHaveBeenCalledWith(
            "chrome",
            expect.objectContaining({ preferCache: true, allowStale: true })
        );
    });

    it("reads resources using agent mcpAccess", async () => {
        const context = createMockToolContext({
            agent: {
                ...createMockToolContext().agent,
                tools: [],
                mcpAccess: ["chrome"],
            },
        });
        const tool = createMcpResourceReadTool(context);

        const result = await tool.execute({
            serverName: "chrome",
            resourceUri: "chrome://tabs",
            description: "browser tabs",
        });

        const parsed = JSON.parse(result as string);
        expect(parsed.success).toBe(true);
        expect(parsed.content).toContain("browser data");
        expect(mockMcpManager.readResource).toHaveBeenCalledWith("chrome", "chrome://tabs");
    });

    it("creates subscriptions using agent mcpAccess", async () => {
        const context = createMockToolContext({
            agent: {
                ...createMockToolContext().agent,
                tools: [],
                mcpAccess: ["chrome"],
            },
        });
        const tool = createMcpSubscribeTool(context);

        const result = await tool.execute({
            serverName: "chrome",
            resourceUri: "chrome://tabs",
            description: "watch browser tabs",
        });

        const parsed = JSON.parse(result as string);
        expect(parsed.success).toBe(true);
        expect(mockSubscriptionService.createSubscription).toHaveBeenCalledWith(
            expect.objectContaining({
                serverName: "chrome",
                resourceUri: "chrome://tabs",
                agentPubkey: context.agent.pubkey,
                agentSlug: context.agent.slug,
            })
        );
    });
});
