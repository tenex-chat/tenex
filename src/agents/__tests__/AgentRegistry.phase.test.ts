import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { AgentRegistry } from "../AgentRegistry";
import type { AgentConfigOptionalNsec, AgentInstance } from "../types";

// Mock dependencies
mock.module("@/nostr/ndkClient", () => ({
    getNDK: mock(() => ({
        fetchEvent: mock(),
        fetchEvents: mock(),
    })),
}));

mock.module("@/nostr/AgentPublisher", () => ({
    AgentPublisher: {
        publishAgentProfile: mock(),
        publishAgentRequest: mock(),
        publishAgentCreation: mock(),
    },
}));

// Keep track of saved agents for test
let savedAgents: any = {};
let globalAgents: any = {};

mock.module("@/services", () => ({
    configService: {
        loadTenexAgents: mock((path: string) => {
            // Return global agents only for global path, project agents for project path
            if (path === "/mock/global/path") {
                return globalAgents;
            }
            return savedAgents;
        }),
        saveProjectAgents: mock((path: string, agents: any) => {
            savedAgents = agents;
            return Promise.resolve();
        }),
        saveGlobalAgents: mock((agents: any) => {
            globalAgents = agents;
            return Promise.resolve();
        }),
        getGlobalPath: mock(() => "/mock/global/path"),
    },
    getAgentRegistry: mock(),
    isProjectContextInitialized: mock(() => false),
}));

describe("AgentRegistry - Phase Support", () => {
    let testDir: string;
    let registry: AgentRegistry;

    beforeEach(async () => {
        // Reset saved agents
        savedAgents = {};
        globalAgents = {};

        // Create temp directory for tests
        testDir = path.join(process.cwd(), ".test-tenex-phase");
        await fs.mkdir(testDir, { recursive: true });
        await fs.mkdir(path.join(testDir, ".tenex", "agents"), { recursive: true });

        registry = new AgentRegistry(testDir);
        await registry.loadFromProject();
    });

    afterEach(async () => {
        // Clean up test directory
        try {
            await fs.rm(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    describe("Agent creation with phases", () => {
        it("should create agent with phase", async () => {
            const config: AgentConfigOptionalNsec = {
                name: "Development Agent",
                role: "Developer",
                description: "Handles development phase tasks",
                instructions: "Write clean code",
                phase: "development",
            };

            const agent = await registry.ensureAgent("dev-agent", config);

            expect(agent.phase).toBe("development");
            expect(agent.name).toBe("Development Agent");
            expect(agent.role).toBe("Developer");
        });

        it("should create agent without phase (universal)", async () => {
            const config: AgentConfigOptionalNsec = {
                name: "Universal Agent",
                role: "General",
                description: "Works in all phases",
                instructions: "Be helpful",
            };

            const agent = await registry.ensureAgent("universal-agent", config);

            expect(agent.phase).toBeUndefined();
            expect(agent.name).toBe("Universal Agent");
        });

        it("should persist phase in agent definition file", async () => {
            const config: AgentConfigOptionalNsec = {
                name: "Testing Agent",
                role: "Tester",
                phase: "testing",
            };

            await registry.ensureAgent("test-agent", config);

            // Read the persisted file
            const files = await fs.readdir(path.join(testDir, ".tenex", "agents"));
            const agentFile = files.find((f) => f.endsWith(".json"));
            expect(agentFile).toBeDefined();

            const content = await fs.readFile(
                path.join(testDir, ".tenex", "agents", agentFile!),
                "utf-8"
            );
            const storedData = JSON.parse(content);

            expect(storedData.phase).toBe("testing");
            expect(storedData.name).toBe("Testing Agent");
        });
    });

    describe("getAgentsByPhase", () => {
        beforeEach(async () => {
            // Create agents with different phases
            await registry.ensureAgent("dev1", {
                name: "Dev Agent 1",
                role: "Developer",
                phase: "development",
            });

            await registry.ensureAgent("dev2", {
                name: "Dev Agent 2",
                role: "Developer",
                phase: "development",
            });

            await registry.ensureAgent("test1", {
                name: "Test Agent 1",
                role: "Tester",
                phase: "testing",
            });

            await registry.ensureAgent("universal", {
                name: "Universal Agent",
                role: "General",
                // No phase - works in all phases
            });
        });

        it("should get agents for specific phase including universal", () => {
            const devAgents = registry.getAgentsByPhase("development");

            expect(devAgents).toHaveLength(3); // dev1, dev2, universal
            expect(devAgents.map((a) => a.name)).toContain("Dev Agent 1");
            expect(devAgents.map((a) => a.name)).toContain("Dev Agent 2");
            expect(devAgents.map((a) => a.name)).toContain("Universal Agent");
        });

        it("should get only universal agents when phase is undefined", () => {
            const universalAgents = registry.getAgentsByPhase(undefined);

            expect(universalAgents).toHaveLength(1);
            expect(universalAgents[0].name).toBe("Universal Agent");
        });

        it("should handle phase normalization (case-insensitive)", () => {
            const devAgents1 = registry.getAgentsByPhase("development");
            const devAgents2 = registry.getAgentsByPhase("DEVELOPMENT");

            expect(devAgents1.length).toBe(devAgents2.length);
            expect(devAgents1.map((a) => a.name).sort()).toEqual(
                devAgents2.map((a) => a.name).sort()
            );
        });

        it("should return universal agents for any phase", () => {
            const testAgents = registry.getAgentsByPhase("testing");
            const prodAgents = registry.getAgentsByPhase("production");

            // Both should include the universal agent
            expect(testAgents.map((a) => a.name)).toContain("Universal Agent");
            expect(prodAgents.map((a) => a.name)).toContain("Universal Agent");

            // Testing phase should also have the test agent
            expect(testAgents.map((a) => a.name)).toContain("Test Agent 1");

            // Production phase should only have universal
            expect(prodAgents).toHaveLength(1);
        });
    });

    describe("Agent loading with phases", () => {
        it("should load agent with phase from persisted file", async () => {
            // Create agent with phase
            const config: AgentConfigOptionalNsec = {
                name: "Staging Agent",
                role: "Deployer",
                phase: "staging",
            };

            await registry.ensureAgent("staging-agent", config);

            // Create new registry and load
            const newRegistry = new AgentRegistry(testDir);
            await newRegistry.loadFromProject();

            const agent = newRegistry.getAgent("staging-agent");
            expect(agent).toBeDefined();
            expect(agent?.phase).toBe("staging");
            expect(agent?.name).toBe("Staging Agent");
        });
    });

    describe("Phase validation in registry", () => {
        it("should handle agents with matching phases correctly", () => {
            // This tests the internal phase matching logic
            const agents: AgentInstance[] = [
                {
                    name: "Agent1",
                    phase: "development",
                    pubkey: "pub1",
                    signer: NDKPrivateKeySigner.generate(),
                    role: "Dev",
                    llmConfig: "default",
                    tools: [],
                    slug: "agent1",
                },
                {
                    name: "Agent2",
                    phase: "DEVELOPMENT", // Different case
                    pubkey: "pub2",
                    signer: NDKPrivateKeySigner.generate(),
                    role: "Dev",
                    llmConfig: "default",
                    tools: [],
                    slug: "agent2",
                },
                {
                    name: "Agent3",
                    // No phase
                    pubkey: "pub3",
                    signer: NDKPrivateKeySigner.generate(),
                    role: "General",
                    llmConfig: "default",
                    tools: [],
                    slug: "agent3",
                },
            ];

            // Filter for development phase
            const { normalizePhase } = require("@/conversations/utils/phaseUtils");
            const normalizedTarget = normalizePhase("development");

            const filtered = agents.filter((agent) => {
                if (!agent.phase) return true; // Universal agents
                const agentPhase = normalizePhase(agent.phase);
                return agentPhase === normalizedTarget;
            });

            expect(filtered).toHaveLength(3); // All three match
        });
    });
});
