import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { NDKProject } from "@nostr-dev-kit/ndk";

// Track logger warnings for testing
let loggerWarnings: Array<{ message: string; data: any }> = [];

// Mock modules before importing ProjectContext
mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: (message: string, data: any) => {
            loggerWarnings.push({ message, data });
        },
        error: () => {},
    },
}));

mock.module("@/services/reports/articleUtils", () => ({
    articleToReportInfo: () => ({}),
}));

// Import after mocking
import { ProjectContext, resolveProjectManager } from "../ProjectContext";
import type { AgentRegistry } from "@/agents/AgentRegistry";

describe("ProjectContext", () => {
    let mockProject: NDKProject;
    let mockAgentRegistry: AgentRegistry;

    beforeEach(() => {
        // Reset logger tracking
        loggerWarnings = [];

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

    describe("resolveProjectManager", () => {
        /**
         * Helper to create a minimal mock agent
         */
        function createMockAgent(overrides: Partial<AgentInstance> & { slug: string }): AgentInstance {
            return {
                name: overrides.name || `Agent ${overrides.slug}`,
                slug: overrides.slug,
                pubkey: overrides.pubkey || `pubkey-${overrides.slug}`,
                eventId: overrides.eventId || `event-${overrides.slug}`,
                role: overrides.role || "assistant",
                llmConfig: "test-config",
                tools: [],
                signer: {} as any,
                pmOverrides: overrides.pmOverrides,
                isPM: overrides.isPM,
                createMetadataStore: () => ({} as any),
                createLLMService: () => ({} as any),
                sign: async () => {},
            };
        }

        it("should prioritize global isPM flag over other designations", () => {
            // Agent with isPM=true should win even if another has pmOverrides
            const agent1 = createMockAgent({
                slug: "agent-1",
                isPM: true, // Global PM designation via kind 24020
            });
            const agent2 = createMockAgent({
                slug: "agent-2",
                pmOverrides: { "test-project": true }, // Local PM override
            });

            const agents = new Map<string, AgentInstance>([
                ["agent-1", agent1],
                ["agent-2", agent2],
            ]);

            const project = {
                tags: [],
                dTag: "test-project",
                tagValue: () => "test-project",
            } as unknown as NDKProject;

            const pm = resolveProjectManager(project, agents, "test-project");

            expect(pm).toBe(agent1);
        });

        it("should fall back to pmOverrides when no global isPM flag exists", () => {
            const agent1 = createMockAgent({ slug: "agent-1" });
            const agent2 = createMockAgent({
                slug: "agent-2",
                pmOverrides: { "test-project": true },
            });

            const agents = new Map<string, AgentInstance>([
                ["agent-1", agent1],
                ["agent-2", agent2],
            ]);

            const project = {
                tags: [],
                dTag: "test-project",
                tagValue: () => "test-project",
            } as unknown as NDKProject;

            const pm = resolveProjectManager(project, agents, "test-project");

            expect(pm).toBe(agent2);
        });

        it("should fall back to project tag designation when no overrides exist", () => {
            const agent1 = createMockAgent({
                slug: "agent-1",
                eventId: "event-id-1",
            });
            const agent2 = createMockAgent({
                slug: "agent-2",
                eventId: "event-id-2",
            });

            const agents = new Map<string, AgentInstance>([
                ["agent-1", agent1],
                ["agent-2", agent2],
            ]);

            // Project with explicit PM designation in tags
            const project = {
                tags: [["agent", "event-id-2", "pm"]], // agent-2 designated as PM
                dTag: "test-project",
                tagValue: () => "test-project",
            } as unknown as NDKProject;

            const pm = resolveProjectManager(project, agents, "test-project");

            expect(pm).toBe(agent2);
        });

        it("should return first agent when no PM designation exists", () => {
            const agent1 = createMockAgent({ slug: "agent-1" });
            const agent2 = createMockAgent({ slug: "agent-2" });

            const agents = new Map<string, AgentInstance>([
                ["agent-1", agent1],
                ["agent-2", agent2],
            ]);

            // Project with agent tags but no PM role
            const project = {
                tags: [["agent", "event-agent-1"]],
                dTag: "test-project",
                tagValue: () => "test-project",
            } as unknown as NDKProject;

            const pm = resolveProjectManager(project, agents, "test-project");

            // First agent from tags should be returned
            expect(pm).toBe(agent1);
        });

        it("should handle isPM=false as no designation", () => {
            const agent1 = createMockAgent({
                slug: "agent-1",
                isPM: false, // Explicitly false
            });
            const agent2 = createMockAgent({
                slug: "agent-2",
                pmOverrides: { "test-project": true },
            });

            const agents = new Map<string, AgentInstance>([
                ["agent-1", agent1],
                ["agent-2", agent2],
            ]);

            const project = {
                tags: [],
                dTag: "test-project",
                tagValue: () => "test-project",
            } as unknown as NDKProject;

            const pm = resolveProjectManager(project, agents, "test-project");

            // Should fall through to pmOverrides since isPM is false
            expect(pm).toBe(agent2);
        });

        it("should return undefined when no agents exist", () => {
            const agents = new Map<string, AgentInstance>();

            const project = {
                tags: [],
                dTag: "test-project",
                tagValue: () => "test-project",
            } as unknown as NDKProject;

            const pm = resolveProjectManager(project, agents, "test-project");

            expect(pm).toBeUndefined();
        });

        it("should log warning when multiple agents have isPM=true and use first one", () => {
            // Multiple agents with isPM=true - this is a configuration issue
            const agent1 = createMockAgent({
                slug: "agent-1",
                name: "First PM Agent",
                isPM: true,
            });
            const agent2 = createMockAgent({
                slug: "agent-2",
                name: "Second PM Agent",
                isPM: true,
            });
            const agent3 = createMockAgent({
                slug: "agent-3",
                name: "Third PM Agent",
                isPM: true,
            });

            const agents = new Map<string, AgentInstance>([
                ["agent-1", agent1],
                ["agent-2", agent2],
                ["agent-3", agent3],
            ]);

            const project = {
                tags: [],
                dTag: "test-project",
                tagValue: () => "test-project",
            } as unknown as NDKProject;

            const pm = resolveProjectManager(project, agents, "test-project");

            // Should return first agent found
            expect(pm).toBe(agent1);

            // Should have logged a warning about multiple PMs
            const multiPMWarning = loggerWarnings.find(
                (w) => w.message.includes("Multiple agents have global PM designation")
            );
            expect(multiPMWarning).toBeDefined();
            expect(multiPMWarning?.data.pmAgents.length).toBe(3);
            expect(multiPMWarning?.data.selectedAgent).toBe("agent-1");
        });

        it("should not log warning when only one agent has isPM=true", () => {
            const agent1 = createMockAgent({
                slug: "agent-1",
                isPM: true,
            });
            const agent2 = createMockAgent({
                slug: "agent-2",
                isPM: false,
            });

            const agents = new Map<string, AgentInstance>([
                ["agent-1", agent1],
                ["agent-2", agent2],
            ]);

            const project = {
                tags: [],
                dTag: "test-project",
                tagValue: () => "test-project",
            } as unknown as NDKProject;

            const pm = resolveProjectManager(project, agents, "test-project");

            expect(pm).toBe(agent1);

            // Should NOT have logged a multiple PM warning
            const multiPMWarning = loggerWarnings.find(
                (w) => w.message.includes("Multiple agents have global PM designation")
            );
            expect(multiPMWarning).toBeUndefined();
        });

        it("should use project-scoped PM from projectOverrides when no global isPM exists", () => {
            // Agent with project-scoped PM via kind 24020 with a-tag
            const agent1 = createMockAgent({ slug: "agent-1" });
            const agent2: AgentInstance = {
                ...createMockAgent({ slug: "agent-2" }),
                projectOverrides: {
                    "test-project": { isPM: true },
                },
            };

            const agents = new Map<string, AgentInstance>([
                ["agent-1", agent1],
                ["agent-2", agent2],
            ]);

            const project = {
                tags: [],
                dTag: "test-project",
                tagValue: () => "test-project",
            } as unknown as NDKProject;

            const pm = resolveProjectManager(project, agents, "test-project");

            expect(pm).toBe(agent2);
        });

        it("should prioritize global isPM over project-scoped projectOverrides.isPM", () => {
            // Agent1 has global isPM=true, agent2 has project-scoped isPM
            const agent1 = createMockAgent({
                slug: "agent-1",
                isPM: true, // Global PM designation
            });
            const agent2: AgentInstance = {
                ...createMockAgent({ slug: "agent-2" }),
                projectOverrides: {
                    "test-project": { isPM: true }, // Project-scoped PM
                },
            };

            const agents = new Map<string, AgentInstance>([
                ["agent-1", agent1],
                ["agent-2", agent2],
            ]);

            const project = {
                tags: [],
                dTag: "test-project",
                tagValue: () => "test-project",
            } as unknown as NDKProject;

            const pm = resolveProjectManager(project, agents, "test-project");

            // Global isPM should win
            expect(pm).toBe(agent1);
        });

        it("should prioritize project-scoped projectOverrides.isPM over legacy pmOverrides", () => {
            // Agent1 has project-scoped isPM via projectOverrides
            // Agent2 has legacy pmOverrides
            const agent1: AgentInstance = {
                ...createMockAgent({ slug: "agent-1" }),
                projectOverrides: {
                    "test-project": { isPM: true },
                },
            };
            const agent2 = createMockAgent({
                slug: "agent-2",
                pmOverrides: { "test-project": true },
            });

            const agents = new Map<string, AgentInstance>([
                ["agent-1", agent1],
                ["agent-2", agent2],
            ]);

            const project = {
                tags: [],
                dTag: "test-project",
                tagValue: () => "test-project",
            } as unknown as NDKProject;

            const pm = resolveProjectManager(project, agents, "test-project");

            // projectOverrides.isPM should win over pmOverrides
            expect(pm).toBe(agent1);
        });

        it("should only apply project-scoped PM to matching project", () => {
            // Agent has project-scoped PM for a DIFFERENT project
            const agent1: AgentInstance = {
                ...createMockAgent({ slug: "agent-1" }),
                projectOverrides: {
                    "other-project": { isPM: true }, // Different project!
                },
            };
            const agent2 = createMockAgent({ slug: "agent-2" });

            const agents = new Map<string, AgentInstance>([
                ["agent-1", agent1],
                ["agent-2", agent2],
            ]);

            // Project tags designate agent-2 as first agent
            const project = {
                tags: [["agent", "event-agent-2"]],
                dTag: "test-project", // Not "other-project"
                tagValue: () => "test-project",
            } as unknown as NDKProject;

            const pm = resolveProjectManager(project, agents, "test-project");

            // Should fall through to first agent from tags since projectOverrides.isPM
            // is for a different project
            expect(pm).toBe(agent2);
        });
    });
});
