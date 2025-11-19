import { beforeEach, describe, expect, it, mock } from "bun:test";
import { AgentRegistry } from "../AgentRegistry";
import type { AgentInstance } from "../types";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

describe("AgentRegistry", () => {
    let registry: AgentRegistry;
    const projectPath = "/test/project/path";
    const metadataPath = "/test/metadata/path";

    beforeEach(() => {
        registry = new AgentRegistry(projectPath, metadataPath);
    });

    function createMockAgent(overrides: Partial<AgentInstance> = {}): AgentInstance {
        const signer = NDKPrivateKeySigner.generate();
        return {
            name: "Test Agent",
            pubkey: signer.pubkey,
            signer,
            role: "assistant",
            description: "Test description",
            instructions: "Test instructions",
            useCriteria: "Test criteria",
            llmConfig: "anthropic:claude-sonnet-4",
            tools: ["read_path", "shell"],
            eventId: "test-event-id",
            slug: "test-agent",
            phase: undefined,
            phases: undefined,
            createMetadataStore: mock(() => ({}) as any),
            createLLMService: mock(() => ({}) as any),
            sign: mock(async () => {}),
            ...overrides,
        };
    }

    describe("constructor", () => {
        it("should create registry with valid paths", () => {
            expect(registry.getBasePath()).toBe(projectPath);
            expect(registry.getMetadataPath()).toBe(metadataPath);
        });

        it("should throw error for invalid projectPath", () => {
            expect(() => new AgentRegistry("", metadataPath)).toThrow();
            expect(() => new AgentRegistry("undefined", metadataPath)).toThrow();
        });

        it("should throw error for invalid metadataPath", () => {
            expect(() => new AgentRegistry(projectPath, "")).toThrow();
            expect(() => new AgentRegistry(projectPath, "undefined")).toThrow();
        });
    });

    describe("addAgent and getAgent", () => {
        it("should add and retrieve agent by slug", () => {
            const agent = createMockAgent({ slug: "my-agent" });

            registry.addAgent(agent);

            const retrieved = registry.getAgent("my-agent");
            expect(retrieved).toBeDefined();
            expect(retrieved?.slug).toBe("my-agent");
            expect(retrieved?.name).toBe("Test Agent");
        });

        it("should return undefined for non-existent slug", () => {
            const retrieved = registry.getAgent("nonexistent");
            expect(retrieved).toBeUndefined();
        });

        it("should overwrite agent with same slug", () => {
            const agent1 = createMockAgent({ slug: "my-agent", name: "Agent 1" });
            const agent2 = createMockAgent({ slug: "my-agent", name: "Agent 2" });

            registry.addAgent(agent1);
            registry.addAgent(agent2);

            const retrieved = registry.getAgent("my-agent");
            expect(retrieved?.name).toBe("Agent 2");
        });
    });

    describe("getAgentByPubkey", () => {
        it("should retrieve agent by pubkey", () => {
            const agent = createMockAgent();

            registry.addAgent(agent);

            const retrieved = registry.getAgentByPubkey(agent.pubkey);
            expect(retrieved).toBeDefined();
            expect(retrieved?.pubkey).toBe(agent.pubkey);
        });

        it("should return undefined for non-existent pubkey", () => {
            const retrieved = registry.getAgentByPubkey("nonexistent-pubkey");
            expect(retrieved).toBeUndefined();
        });
    });

    describe("getAgentByEventId", () => {
        it("should retrieve agent by eventId", () => {
            const agent = createMockAgent({ eventId: "event-123" });

            registry.addAgent(agent);

            const retrieved = registry.getAgentByEventId("event-123");
            expect(retrieved).toBeDefined();
            expect(retrieved?.eventId).toBe("event-123");
        });

        it("should return undefined for non-existent eventId", () => {
            const retrieved = registry.getAgentByEventId("nonexistent-event");
            expect(retrieved).toBeUndefined();
        });

        it("should handle agents without eventId", () => {
            const agent = createMockAgent({ eventId: undefined });

            registry.addAgent(agent);

            const retrieved = registry.getAgentByEventId("any-event");
            expect(retrieved).toBeUndefined();
        });
    });

    describe("getAllAgents", () => {
        it("should return empty array when no agents", () => {
            const agents = registry.getAllAgents();
            expect(agents).toEqual([]);
        });

        it("should return all agents", () => {
            const agent1 = createMockAgent({ slug: "agent-1" });
            const agent2 = createMockAgent({ slug: "agent-2" });
            const agent3 = createMockAgent({ slug: "agent-3" });

            registry.addAgent(agent1);
            registry.addAgent(agent2);
            registry.addAgent(agent3);

            const agents = registry.getAllAgents();
            expect(agents.length).toBe(3);
            expect(agents.map((a) => a.slug)).toContain("agent-1");
            expect(agents.map((a) => a.slug)).toContain("agent-2");
            expect(agents.map((a) => a.slug)).toContain("agent-3");
        });
    });

    describe("getAgentsByPhase", () => {
        it("should return agents without phase when phase is undefined", () => {
            const universal = createMockAgent({ slug: "universal", phase: undefined });
            const planning = createMockAgent({ slug: "planning", phase: "planning" });

            registry.addAgent(universal);
            registry.addAgent(planning);

            const agents = registry.getAgentsByPhase(undefined);
            expect(agents.length).toBe(1);
            expect(agents[0].slug).toBe("universal");
        });

        it("should return agents matching phase plus universal agents", () => {
            const universal = createMockAgent({ slug: "universal", phase: undefined });
            const planning = createMockAgent({ slug: "planning", phase: "planning" });
            const execution = createMockAgent({ slug: "execution", phase: "execution" });

            registry.addAgent(universal);
            registry.addAgent(planning);
            registry.addAgent(execution);

            const agents = registry.getAgentsByPhase("planning");
            expect(agents.length).toBe(2);
            expect(agents.map((a) => a.slug)).toContain("universal");
            expect(agents.map((a) => a.slug)).toContain("planning");
            expect(agents.map((a) => a.slug)).not.toContain("execution");
        });

        it("should normalize phase names when comparing", () => {
            const agent = createMockAgent({ slug: "planning", phase: "Planning" });

            registry.addAgent(agent);

            // Should match despite different casing
            const agents = registry.getAgentsByPhase("planning");
            expect(agents.length).toBe(1);
            expect(agents[0].slug).toBe("planning");
        });
    });

    describe("removeAgentFromProject", () => {
        it("should return false when agent not found", async () => {
            const result = await registry.removeAgentFromProject("nonexistent");
            expect(result).toBe(false);
        });

        it("should return false when no projectDTag", async () => {
            const agent = createMockAgent({ slug: "test-agent" });
            registry.addAgent(agent);

            const result = await registry.removeAgentFromProject("test-agent");
            expect(result).toBe(false);
        });
    });
});
