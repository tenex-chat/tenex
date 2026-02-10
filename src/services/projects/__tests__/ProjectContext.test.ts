import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { NDKProject } from "@nostr-dev-kit/ndk";

// Mock modules before importing ProjectContext
mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

mock.module("@/services/reports/articleUtils", () => ({
    articleToReportInfo: () => ({}),
}));

// Import after mocking
import { ProjectContext } from "../ProjectContext";
import type { AgentRegistry } from "@/agents/AgentRegistry";

describe("ProjectContext", () => {
    let mockProject: NDKProject;
    let mockAgentRegistry: AgentRegistry;

    beforeEach(() => {
        // Create mock project
        mockProject = {
            id: "test-project-id",
            dTag: "test-project",
            tagValue: (tag: string) => {
                if (tag === "d") return "test-project";
                if (tag === "title") return "Test Project";
                return undefined;
            },
            tags: [],
            pubkey: "test-pubkey",
        } as unknown as NDKProject;

        // Create mock agent registry
        mockAgentRegistry = {
            getAllAgentsMap: () => new Map(),
            getAllAgents: () => [],
            getAgent: () => undefined,
            getAgentByPubkey: () => undefined,
            getBasePath: () => "/test/path",
            getMetadataPath: () => "/test/.tenex",
        } as unknown as AgentRegistry;
    });

    describe("onAgentAdded callback", () => {
        it("should invoke callback when notifyAgentAdded is called", () => {
            const context = new ProjectContext(mockProject, mockAgentRegistry);
            let callbackInvoked = false;
            let receivedAgent: AgentInstance | null = null;

            const mockAgent: AgentInstance = {
                name: "Test Agent",
                slug: "test-agent",
                pubkey: "agent-pubkey-123",
                role: "assistant",
                llmConfig: "test-config",
                tools: [],
                signer: {} as any,
                createMetadataStore: () => ({} as any),
                createLLMService: () => ({} as any),
                sign: async () => {},
            };

            // Set up the callback
            context.setOnAgentAdded((agent) => {
                callbackInvoked = true;
                receivedAgent = agent;
            });

            // Notify that agent was added
            context.notifyAgentAdded(mockAgent);

            // Verify callback was invoked with the agent
            expect(callbackInvoked).toBe(true);
            expect(receivedAgent).toBe(mockAgent);
        });

        it("should not throw when notifyAgentAdded is called without callback", () => {
            const context = new ProjectContext(mockProject, mockAgentRegistry);

            const mockAgent: AgentInstance = {
                name: "Test Agent",
                slug: "test-agent",
                pubkey: "agent-pubkey-123",
                role: "assistant",
                llmConfig: "test-config",
                tools: [],
                signer: {} as any,
                createMetadataStore: () => ({} as any),
                createLLMService: () => ({} as any),
                sign: async () => {},
            };

            // This should not throw
            expect(() => context.notifyAgentAdded(mockAgent)).not.toThrow();
        });

        it("should allow replacing the callback", () => {
            const context = new ProjectContext(mockProject, mockAgentRegistry);
            let callback1Count = 0;
            let callback2Count = 0;

            const mockAgent: AgentInstance = {
                name: "Test Agent",
                slug: "test-agent",
                pubkey: "agent-pubkey-123",
                role: "assistant",
                llmConfig: "test-config",
                tools: [],
                signer: {} as any,
                createMetadataStore: () => ({} as any),
                createLLMService: () => ({} as any),
                sign: async () => {},
            };

            // Set first callback
            context.setOnAgentAdded(() => {
                callback1Count++;
            });
            context.notifyAgentAdded(mockAgent);
            expect(callback1Count).toBe(1);

            // Replace with second callback
            context.setOnAgentAdded(() => {
                callback2Count++;
            });
            context.notifyAgentAdded(mockAgent);

            // Only second callback should be called this time
            expect(callback1Count).toBe(1); // Still just once
            expect(callback2Count).toBe(1);
        });

        it("should handle multiple sequential agent additions", () => {
            const context = new ProjectContext(mockProject, mockAgentRegistry);
            const receivedAgents: AgentInstance[] = [];

            const agents: AgentInstance[] = [
                {
                    name: "Agent 1",
                    slug: "agent-1",
                    pubkey: "pubkey-1",
                    role: "assistant",
                    llmConfig: "test-config",
                    tools: [],
                    signer: {} as any,
                    createMetadataStore: () => ({} as any),
                    createLLMService: () => ({} as any),
                    sign: async () => {},
                },
                {
                    name: "Agent 2",
                    slug: "agent-2",
                    pubkey: "pubkey-2",
                    role: "developer",
                    llmConfig: "test-config",
                    tools: [],
                    signer: {} as any,
                    createMetadataStore: () => ({} as any),
                    createLLMService: () => ({} as any),
                    sign: async () => {},
                },
                {
                    name: "Agent 3",
                    slug: "agent-3",
                    pubkey: "pubkey-3",
                    role: "reviewer",
                    llmConfig: "test-config",
                    tools: [],
                    signer: {} as any,
                    createMetadataStore: () => ({} as any),
                    createLLMService: () => ({} as any),
                    sign: async () => {},
                },
            ];

            context.setOnAgentAdded((agent) => {
                receivedAgents.push(agent);
            });

            // Add all agents
            for (const agent of agents) {
                context.notifyAgentAdded(agent);
            }

            // Verify all callbacks were invoked in order
            expect(receivedAgents.length).toBe(3);
            expect(receivedAgents[0]).toBe(agents[0]);
            expect(receivedAgents[1]).toBe(agents[1]);
            expect(receivedAgents[2]).toBe(agents[2]);
        });
    });
});
